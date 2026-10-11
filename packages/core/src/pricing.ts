import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import anthropicPrices from "../../../pricing/anthropic.json" with { type: "json" };
import openaiPrices from "../../../pricing/openai.json" with { type: "json" };
import type { CostBreakdown, ModelPrice, PriceTable, TokenCounts, TokenRates, UsageRecord } from "./types.ts";

/** The repo's `pricing/` directory, resolved relative to this source file. It does not exist inside a compiled binary. */
export const DEFAULT_PRICING_DIR: string = fileURLToPath(new URL("../../../pricing/", import.meta.url));

/**
 * The repo's price files, bundled at build time so a compiled `signalbox` binary works with no repo
 * around. Keyed by file name. A new `pricing/*.json` file must be added here too (a test checks).
 */
const EMBEDDED_PRICES: Readonly<Record<string, unknown>> = {
  "anthropic.json": anthropicPrices,
  "openai.json": openaiPrices,
};

export const EMBEDDED_PRICE_FILES: readonly string[] = Object.keys(EMBEDDED_PRICES).sort();

/** @deprecated `fast` is part of `ModelPrice` now; kept as an alias. */
export type ModelPriceWithFast = ModelPrice;

export interface PriceMatch {
  /** The table key that matched: an exact id or a `prefix*` key. */
  key: string;
  price: ModelPrice;
  table: PriceTable;
}

export interface PriceOptions {
  webSearchRequests?: number;
  /** e.g. Anthropic `inference_geo`. Looked up in the matched table's `geoMultipliers`; unknown values are 1x. */
  geo?: string;
  /** "fast" uses the row's `fast` rates when it has them, standard rates otherwise. */
  speed?: string;
  /**
   * Whether `tokens` describe a single API request (the default). Set it to false for sums such as
   * ledger rows: per-request long-context tiers can't be decided from a sum, so the base tier is used.
   */
  perRequest?: boolean;
}

export interface PriceResult {
  cost: CostBreakdown;
  /** False when no price row matched: every cost field is then 0. */
  priced: boolean;
  /** The matched table key, when priced. */
  key?: string;
  /** True when the long-context tier applied. */
  longContext: boolean;
  /** True when fast-mode rates applied. */
  fast: boolean;
  /** Gross cache saving at list price: cacheRead x (input rate - cacheRead rate), same tier and geo multiplier. */
  cacheSavingsUsd: number;
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

export function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function zeroCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0 };
}

/** Adds `b` into `a` in place and returns `a`. */
export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.webSearch += b.webSearch;
  a.total += b.total;
  return a;
}

/** Adds `b` into `a` in place and returns `a`. `reasoning` stays undefined until some input reports it. */
export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  a.input += num(b.input);
  a.output += num(b.output);
  a.cacheRead += num(b.cacheRead);
  a.cacheWrite5m += num(b.cacheWrite5m);
  a.cacheWrite1h += num(b.cacheWrite1h);
  if (b.reasoning !== undefined) a.reasoning = (a.reasoning ?? 0) + num(b.reasoning);
  return a;
}

/** input + output + cacheRead + cacheWrite5m + cacheWrite1h. */
export function processedTokens(t: TokenCounts): number {
  return num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite5m) + num(t.cacheWrite1h);
}

/** The prompt size that decides a long-context tier: input + cacheRead + cacheWrite5m + cacheWrite1h. */
export function promptTokens(t: TokenCounts): number {
  return num(t.input) + num(t.cacheRead) + num(t.cacheWrite5m) + num(t.cacheWrite1h);
}

/**
 * Normalizes a model id for matching: drops a trailing bracket tag such as `[1m]`, then a trailing
 * date snapshot (`-20251101` or Vertex-style `@20251101`). Provider prefixes (Bedrock `anthropic.`)
 * are kept, because those platforms price differently.
 */
export function canonicalModel(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, "").replace(/[-@]\d{8}$/, "");
}

/**
 * Finds the price row for a model id. Order: exact key, exact key for the canonical id, longest
 * `prefix*` key, longest `prefix*` key for the canonical id. Across tables the first table wins a tie.
 */
export function findPrice(model: string, tables: readonly PriceTable[]): PriceMatch | undefined {
  const m = matchModelKey(model, tables);
  return m ? { key: m.key, price: m.row, table: m.table } : undefined;
}

/**
 * The row for a model id in tables keyed by exact ids or `prefix*` keys (price and model tables).
 * Order: exact key, exact key for the canonical id, longest `prefix*` key, longest `prefix*` key for
 * the canonical id. Across tables the first table wins a tie.
 */
export function matchModelKey<Table extends { models: Record<string, unknown> }>(
  model: string,
  tables: readonly Table[],
): KeyMatch<Table> | undefined {
  const raw = model.trim();
  if (!raw) return undefined;
  const canon = canonicalModel(raw);
  const alt = canon !== raw && canon !== "" ? canon : undefined;
  return (
    exactMatch(raw, tables) ??
    (alt ? exactMatch(alt, tables) : undefined) ??
    prefixMatch(raw, tables) ??
    (alt ? prefixMatch(alt, tables) : undefined)
  );
}

/** A row found by matchModelKey: the key that matched, its row and the table it is in. */
export interface KeyMatch<Table extends { models: Record<string, unknown> }> {
  key: string;
  row: Table["models"][string];
  table: Table;
}

function exactMatch<Table extends { models: Record<string, unknown> }>(id: string, tables: readonly Table[]): KeyMatch<Table> | undefined {
  if (id.endsWith("*")) return undefined;
  for (const table of tables) {
    if (Object.hasOwn(table.models, id)) {
      const row = table.models[id] as Table["models"][string] | undefined;
      if (row) return { key: id, row, table };
    }
  }
  return undefined;
}

function prefixMatch<Table extends { models: Record<string, unknown> }>(id: string, tables: readonly Table[]): KeyMatch<Table> | undefined {
  let best: KeyMatch<Table> | undefined;
  let bestLen = 0;
  for (const table of tables) {
    for (const [key, row] of Object.entries(table.models)) {
      if (!key.endsWith("*")) continue;
      const prefix = key.slice(0, -1);
      if (prefix.length > bestLen && id.startsWith(prefix)) {
        best = { key, row: row as Table["models"][string], table };
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export function geoMultiplier(table: PriceTable, geo: string | undefined): number {
  if (geo === undefined || !table.geoMultipliers || !Object.hasOwn(table.geoMultipliers, geo)) return 1;
  return table.geoMultipliers[geo] ?? 1;
}

/**
 * Prices one API request's tokens (or a sum, with `perRequest: false`). An unknown model is
 * priced at 0 with `priced: false`; never guess a price.
 */
export function priceTokens(
  model: string,
  tokens: TokenCounts,
  tables: readonly PriceTable[],
  opts: PriceOptions = {},
): PriceResult {
  const match = findPrice(model, tables);
  if (!match) return { cost: zeroCost(), priced: false, longContext: false, fast: false, cacheSavingsUsd: 0 };

  const { price, table, key } = match;
  let rates: TokenRates = price;
  let longContext = false;
  let fast = false;
  if (opts.perRequest !== false && price.longContext && promptTokens(tokens) > price.longContext.thresholdTokens) {
    rates = price.longContext;
    longContext = true;
  }
  if (opts.speed === "fast" && price.fast) {
    // Fast-mode pricing covers the full context window, so it replaces any long-context tier.
    rates = price.fast;
    longContext = false;
    fast = true;
  }

  const geo = geoMultiplier(table, opts.geo);
  const usd = (n: number, rate: number) => (num(n) * rate * geo) / 1e6;
  const cost: CostBreakdown = {
    input: usd(tokens.input, rates.input),
    output: usd(tokens.output, rates.output),
    cacheRead: usd(tokens.cacheRead, rates.cacheRead),
    cacheWrite5m: usd(tokens.cacheWrite5m, rates.cacheWrite5m),
    cacheWrite1h: usd(tokens.cacheWrite1h, rates.cacheWrite1h),
    webSearch: num(opts.webSearchRequests) * (price.webSearchPerRequest ?? 0),
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite5m + cost.cacheWrite1h + cost.webSearch;
  return {
    cost,
    priced: true,
    key,
    longContext,
    fast,
    cacheSavingsUsd: usd(tokens.cacheRead, rates.input - rates.cacheRead),
  };
}

/** Prices one deduplicated usage record with its own web-search count, geo and speed. */
export function priceRecord(rec: UsageRecord, tables: readonly PriceTable[]): PriceResult {
  return priceTokens(rec.model, rec.tokens, tables, {
    webSearchRequests: rec.webSearchRequests,
    geo: rec.geo,
    speed: rec.speed,
  });
}

// ---------- Loading ----------

/** The embedded copies of the repo's `pricing/*.json`, validated, sorted by file name. Each call returns fresh objects. */
export function embeddedPriceTables(): PriceTable[] {
  return EMBEDDED_PRICE_FILES.map((name) => parsePriceTable(structuredClone(EMBEDDED_PRICES[name]), `pricing/${name} (embedded)`));
}

/**
 * Without `dir`: the price tables embedded at build time (the repo's `pricing/` as of the build).
 * With `dir`: every `*.json` file in it as a `PriceTable`, sorted by file name (an override, e.g.
 * newer prices than the binary carries). Throws on a malformed table: a silently missing price would
 * understate cost.
 */
export function loadPriceTables(dir?: string): PriceTable[] {
  if (dir === undefined) return embeddedPriceTables();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        throw new Error(`${path}: invalid JSON (${(err as Error).message})`);
      }
      return parsePriceTable(json, path);
    });
}

/** Validates an already-parsed price table. Unknown keys are kept. */
export function parsePriceTable(json: unknown, source = "price table"): PriceTable {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isObject(json)) return fail("not an object");
  for (const field of ["provider", "asOf", "sourceUrl"] as const) {
    if (typeof json[field] !== "string" || json[field] === "") fail(`"${field}" must be a non-empty string`);
  }
  if (json.currency !== "USD") fail(`"currency" must be "USD"`);
  if (!isObject(json.models)) return fail(`"models" must be an object`);

  for (const [key, row] of Object.entries(json.models)) {
    const where = `models["${key}"]`;
    if (key === "" || key === "*" || key.slice(0, -1).includes("*")) fail(`${where}: bad key ("*" only as a suffix of a non-empty prefix)`);
    if (!isObject(row)) return fail(`${where} must be an object`);
    checkRates(row, where, fail);
    if (row.longContext !== undefined) {
      if (!isObject(row.longContext)) return fail(`${where}.longContext must be an object`);
      const t = row.longContext.thresholdTokens;
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) fail(`${where}.longContext.thresholdTokens must be a positive number`);
      checkRates(row.longContext, `${where}.longContext`, fail);
    }
    if (row.fast !== undefined) {
      if (!isObject(row.fast)) return fail(`${where}.fast must be an object`);
      checkRates(row.fast, `${where}.fast`, fail);
    }
    if (row.webSearchPerRequest !== undefined && !isRate(row.webSearchPerRequest)) {
      fail(`${where}.webSearchPerRequest must be a non-negative number`);
    }
  }

  if (json.geoMultipliers !== undefined) {
    if (!isObject(json.geoMultipliers)) return fail(`"geoMultipliers" must be an object`);
    for (const [geo, m] of Object.entries(json.geoMultipliers)) {
      if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) fail(`geoMultipliers["${geo}"] must be a positive number`);
    }
  }
  if (json.notes !== undefined && (!Array.isArray(json.notes) || json.notes.some((n) => typeof n !== "string"))) {
    fail(`"notes" must be an array of strings`);
  }
  return json as unknown as PriceTable;
}

function checkRates(row: Record<string, unknown>, where: string, fail: (msg: string) => never): void {
  for (const field of RATE_FIELDS) {
    if (!isRate(row[field])) fail(`${where}.${field} must be a non-negative number`);
  }
}

function isRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
