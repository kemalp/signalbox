import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalModel,
  DEFAULT_PRICING_DIR,
  EMBEDDED_PRICE_FILES,
  embeddedPriceTables,
  findPrice,
  loadPriceTables,
  parsePriceTable,
  priceRecord,
  priceTokens,
  type PriceTable,
  type TokenCounts,
  type UsageRecord,
} from "../src/index.ts";

const tables = loadPriceTables();
const tok = (t: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });

describe("repo price table", () => {
  test("loads and carries its source", () => {
    const anthropic = tables.find((t) => t.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.currency).toBe("USD");
    expect(anthropic!.sourceUrl).toContain("platform.claude.com");
    expect(anthropic!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("covers the required models", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(findPrice(id, tables), id).toBeDefined();
    }
  });

  test("cache write multipliers are 1.25x and 2x input on every Anthropic row", () => {
    // Anthropic's 5m/1h multipliers only; OpenAI has one cache TTL and its own write premium.
    for (const t of tables.filter((t) => t.provider === "anthropic")) {
      for (const [key, p] of Object.entries(t.models)) {
        expect(p.cacheWrite5m, key).toBeCloseTo(p.input * 1.25, 10);
        expect(p.cacheWrite1h, key).toBeCloseTo(p.input * 2, 10);
      }
    }
  });

  test("Sonnet 5.5 cache reads use the official $0.10, not Claude Code's $0.20", () => {
    expect(findPrice("claude-sonnet-5-5", tables)!.price.cacheRead).toBe(0.1);
  });
});

describe("priceTokens", () => {
  test("BRAINSTORM 6.3 worked example: Opus 5.5 main turn = $0.0860", () => {
    const r = priceTokens("claude-opus-5-5", tok({ input: 6, cacheRead: 180_000, cacheWrite1h: 4_000, output: 900 }), tables);
    expect(r.priced).toBe(true);
    expect(r.key).toBe("claude-opus-5-5");
    expect(r.cost.input).toBeCloseTo(0.000024, 12);
    expect(r.cost.cacheRead).toBeCloseTo(0.036, 12);
    expect(r.cost.cacheWrite1h).toBeCloseTo(0.032, 12);
    expect(r.cost.output).toBeCloseTo(0.018, 12);
    expect(r.cost.total).toBeCloseTo(0.086024, 12);
    expect(r.cost.total.toFixed(4)).toBe("0.0860");
    // Gross saving: 180,000 x ($4 - $0.20) / 1e6.
    expect(r.cacheSavingsUsd).toBeCloseTo(0.684, 12);
  });

  test("5m writes at 1.25x input", () => {
    const r = priceTokens("claude-opus-4-6", tok({ cacheWrite5m: 1_000_000 }), tables);
    expect(r.cost.cacheWrite5m).toBeCloseTo(6.25, 10);
  });

  test("unknown model is unpriced at $0, web search included", () => {
    const r = priceTokens("gpt-5-codex", tok({ input: 1_000_000, output: 1_000 }), tables, { webSearchRequests: 3 });
    expect(r.priced).toBe(false);
    expect(r.key).toBeUndefined();
    expect(r.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0 });
  });

  test("an unreleased model in a known family is not guessed", () => {
    expect(priceTokens("claude-opus-5-7", tok({ input: 1 }), tables).priced).toBe(false);
    expect(priceTokens("claude-sonnet-6", tok({ input: 1 }), tables).priced).toBe(false);
    expect(priceTokens("", tok({ input: 1 }), tables).priced).toBe(false);
  });

  test("Haiku 5.5 long-context tier applies above 100,000 prompt tokens per request", () => {
    // Exactly at the threshold: base tier.
    const at = priceTokens("claude-haiku-5-5", tok({ input: 40_000, cacheRead: 50_000, cacheWrite5m: 5_000, cacheWrite1h: 5_000, output: 1_000_000 }), tables);
    expect(at.longContext).toBe(false);
    expect(at.cost.output).toBeCloseTo(0.5, 10);
    // One token over: every category uses the long-context row.
    const over = priceTokens("claude-haiku-5-5", tok({ input: 40_001, cacheRead: 50_000, cacheWrite5m: 5_000, cacheWrite1h: 5_000, output: 1_000_000 }), tables);
    expect(over.longContext).toBe(true);
    expect(over.cost.output).toBeCloseTo(2.5, 10);
    expect(over.cost.input).toBeCloseTo((40_001 * 0.5) / 1e6, 12);
    expect(over.cost.cacheRead).toBeCloseTo((50_000 * 0.05) / 1e6, 12);
    expect(over.cost.cacheWrite5m).toBeCloseTo((5_000 * 0.625) / 1e6, 12);
    expect(over.cost.cacheWrite1h).toBeCloseTo((5_000 * 1) / 1e6, 12);
    // Output does not count toward the prompt.
    expect(priceTokens("claude-haiku-5-5", tok({ input: 100_000, output: 5_000_000 }), tables).longContext).toBe(false);
  });

  test("perRequest: false never applies the long-context tier (ledger sums)", () => {
    const r = priceTokens("claude-haiku-5-5", tok({ input: 5_000_000 }), tables, { perRequest: false });
    expect(r.longContext).toBe(false);
    expect(r.cost.input).toBeCloseTo(0.5, 10);
  });

  test("inference_geo 'us' is 1.1x on tokens but not on web search; unknown geo is 1x", () => {
    const base = priceTokens("claude-opus-5-5", tok({ input: 1_000_000 }), tables, { webSearchRequests: 2 });
    const us = priceTokens("claude-opus-5-5", tok({ input: 1_000_000 }), tables, { webSearchRequests: 2, geo: "us" });
    expect(base.cost.webSearch).toBeCloseTo(0.02, 10);
    expect(us.cost.input).toBeCloseTo(4.4, 10);
    expect(us.cost.webSearch).toBeCloseTo(0.02, 10);
    expect(us.cost.total).toBeCloseTo(4.42, 10);
    for (const geo of ["global", "not_available", "", "constructor", "mars"]) {
      expect(priceTokens("claude-opus-5-5", tok({ input: 1_000_000 }), tables, { geo }).cost.input, geo).toBeCloseTo(4, 10);
    }
  });

  test("fast mode uses the fast row where one exists", () => {
    const fast = priceTokens("claude-opus-5-5", tok({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }), tables, { speed: "fast" });
    expect(fast.fast).toBe(true);
    expect(fast.cost.input).toBeCloseTo(8, 10);
    expect(fast.cost.output).toBeCloseTo(40, 10);
    expect(fast.cost.cacheRead).toBeCloseTo(0.4, 10);
    // Opus 4.6 bills fast requests at standard rates.
    const std = priceTokens("claude-opus-4-6", tok({ input: 1_000_000 }), tables, { speed: "fast" });
    expect(std.fast).toBe(false);
    expect(std.cost.input).toBeCloseTo(5, 10);
  });

  test("priceRecord passes web search, geo and speed through", () => {
    const rec: UsageRecord = {
      agent: "claude-code",
      id: "msg_1",
      keyQuality: "id",
      sessionId: "s1",
      kind: "main",
      model: "claude-sonnet-4-6",
      ts: "2026-10-01T00:00:00Z",
      tokens: tok({ output: 1_000_000 }),
      outputFinal: true,
      webSearchRequests: 5,
      geo: "us",
    };
    const r = priceRecord(rec, tables);
    expect(r.cost.output).toBeCloseTo(16.5, 10);
    expect(r.cost.webSearch).toBeCloseTo(0.05, 10);
  });
});

describe("off-peak tier", () => {
  const rates = (input: number) => ({ input, output: input * 4, cacheRead: input / 50, cacheWrite5m: input, cacheWrite1h: input });
  const table: PriceTable = {
    provider: "test",
    asOf: "2026-01-01",
    sourceUrl: "https://example.invalid",
    currency: "USD",
    // Monday to Friday, 01:00-04:00 and 06:00-10:00 UTC.
    peakHours: [
      { days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" },
      { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" },
    ],
    models: {
      timed: { ...rates(2), offPeak: rates(1) },
      flat: rates(2),
      mixed: { ...rates(2), offPeak: rates(1), longContext: { thresholdTokens: 100, ...rates(8) }, fast: rates(16) },
    },
  };
  const million = tok({ input: 1_000_000 });
  const at = (iso: string, model = "timed") => priceTokens(model, million, [table], { at: iso });

  test("the row's own rates inside the peak hours, the off-peak ones outside (UTC)", () => {
    // 2026-11-09 is a Monday.
    expect(at("2026-11-09T01:00:00Z")).toMatchObject({ offPeak: false, cost: { input: 2 } });
    expect(at("2026-11-09T03:59:59.999Z")).toMatchObject({ offPeak: false, cost: { input: 2 } });
    expect(at("2026-11-09T04:00:00Z")).toMatchObject({ offPeak: true, cost: { input: 1 } });
    expect(at("2026-11-09T05:59:59Z").offPeak).toBe(true);
    expect(at("2026-11-09T06:00:00Z").offPeak).toBe(false);
    expect(at("2026-11-09T10:00:00Z").offPeak).toBe(true);
    expect(at("2026-11-09T00:59:59Z").offPeak).toBe(true);
    // The same hour in another zone's clothes: 09:30 in Istanbul is 06:30 UTC.
    expect(at("2026-11-09T09:30:00+03:00").offPeak).toBe(false);
    // Friday is a weekday; the weekend is off-peak all day.
    expect(at("2026-11-13T08:00:00Z").offPeak).toBe(false);
    expect(at("2026-11-14T08:00:00Z").offPeak).toBe(true);
    expect(at("2026-11-15T02:00:00Z").offPeak).toBe(true);
    // Every rate of the tier, and the cache saving at that tier's rates.
    const r = priceTokens("timed", tok({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6 }), [table], { at: "2026-11-14T08:00:00Z" });
    expect(r.cost).toMatchObject({ input: 1, output: 4, cacheRead: 0.02, cacheWrite5m: 1 });
    expect(r.cacheSavingsUsd).toBeCloseTo(0.98, 10);
  });

  test("with no time of the request, the row's own (peak) rates: never a discount that can't be shown", () => {
    expect(priceTokens("timed", million, [table])).toMatchObject({ offPeak: false, cost: { input: 2 } });
    expect(priceTokens("timed", million, [table], { at: "not a time" })).toMatchObject({ offPeak: false, cost: { input: 2 } });
    expect(priceTokens("timed", million, [table], { at: Date.parse("2026-11-14T08:00:00Z") }).offPeak).toBe(true);
    expect(priceTokens("timed", million, [table], { at: new Date("2026-11-14T08:00:00Z") }).offPeak).toBe(true);
  });

  test("a row without the tier is flat; long-context and fast rates are not discounted", () => {
    expect(at("2026-11-14T08:00:00Z", "flat")).toMatchObject({ offPeak: false, cost: { input: 2 } });
    expect(at("2026-11-14T08:00:00Z", "mixed")).toMatchObject({ offPeak: false, longContext: true, cost: { input: 8 } });
    expect(priceTokens("mixed", tok({ input: 50 }), [table], { at: "2026-11-14T08:00:00Z" })).toMatchObject({ offPeak: true, longContext: false });
    expect(priceTokens("mixed", tok({ input: 50 }), [table], { at: "2026-11-14T08:00:00Z", speed: "fast" })).toMatchObject({ offPeak: false, fast: true });
  });

  test("priceRecord prices a record by its own timestamp", () => {
    const rec = (ts: string): UsageRecord => ({ agent: "deepseek-harness", id: "m", keyQuality: "id", sessionId: "s", kind: "main", model: "deepseek-v4-pro", ts, tokens: tok({ input: 1e6, output: 1e6, cacheRead: 1e6 }), outputFinal: true, webSearchRequests: 0 });
    // The real DeepSeek table: $1.32 / $3.96 / $0.044 at peak, half of each off-peak.
    const peak = priceRecord(rec("2026-11-09T07:00:00Z"), tables);
    expect(peak.offPeak).toBe(false);
    expect(peak.cost.total).toBeCloseTo(1.32 + 3.96 + 0.044, 10);
    const off = priceRecord(rec("2026-11-09T19:00:00Z"), tables);
    expect(off.offPeak).toBe(true);
    expect(off.cost.total).toBeCloseTo(0.66 + 1.98 + 0.022, 10);
    // A table without the tier is unaffected by the time.
    const opus = (ts: string) => priceRecord({ ...rec(ts), model: "claude-opus-5-5" }, tables);
    expect(opus("2026-11-09T07:00:00Z").cost.total).toBe(opus("2026-11-14T19:00:00Z").cost.total);
    expect(opus("2026-11-14T19:00:00Z").offPeak).toBe(false);
  });

  test("parsePriceTable checks the tier and its hours", () => {
    const base = { provider: "p", asOf: "2026-01-01", sourceUrl: "https://example.invalid", currency: "USD" };
    const row = { ...rates(2), offPeak: rates(1) };
    const hours = [{ days: [1], from: "01:00", to: "04:00" }];
    expect(parsePriceTable({ ...base, peakHours: hours, models: { m: row } }).peakHours).toEqual(hours);
    expect(parsePriceTable({ ...base, peakHours: [{ days: [7], from: "00:00", to: "24:00" }], models: { m: rates(2) } }).provider).toBe("p");
    expect(() => parsePriceTable({ ...base, models: { m: row } })).toThrow(/peakHours/);
    expect(() => parsePriceTable({ ...base, peakHours: [], models: { m: row } })).toThrow(/peakHours/);
    expect(() => parsePriceTable({ ...base, peakHours: hours, models: { m: { ...rates(2), offPeak: { input: 1 } } } })).toThrow(/offPeak\.output/);
    expect(() => parsePriceTable({ ...base, peakHours: "always", models: { m: rates(2) } })).toThrow(/peakHours/);
    for (const bad of [{ days: [], from: "01:00", to: "04:00" }, { days: [0], from: "01:00", to: "04:00" }, { days: [8], from: "01:00", to: "04:00" }, { days: [1.5], from: "01:00", to: "04:00" }]) {
      expect(() => parsePriceTable({ ...base, peakHours: [bad], models: { m: rates(2) } })).toThrow(/weekdays/);
    }
    for (const bad of [{ days: [1], from: "4:00", to: "06:00" }, { days: [1], from: "04:00", to: "04:00" }, { days: [1], from: "06:00", to: "04:00" }, { days: [1], from: "01:00", to: "24:30" }, { days: [1], from: "01:60", to: "04:00" }, { days: [1], to: "04:00" }]) {
      expect(() => parsePriceTable({ ...base, peakHours: [bad], models: { m: rates(2) } })).toThrow(/HH:MM/);
    }
  });
});

describe("findPrice", () => {
  test("dated snapshot ids match prefix keys", () => {
    expect(findPrice("claude-opus-4-5-20251101", tables)?.key).toBe("claude-opus-4-5*");
    expect(findPrice("claude-haiku-4-5-20251001", tables)?.key).toBe("claude-haiku-4-5*");
    expect(findPrice("claude-haiku-4-5", tables)?.key).toBe("claude-haiku-4-5*");
    expect(findPrice("claude-opus-4-20250514", tables)?.price.input).toBe(15);
  });

  test("exact beats prefix, and the longest prefix wins", () => {
    const t: PriceTable[] = [
      {
        provider: "test",
        asOf: "2026-01-01",
        sourceUrl: "https://example.invalid",
        currency: "USD",
        models: {
          "m*": { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          "m-big*": { input: 2, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          "m-big-exact": { input: 3, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        },
      },
    ];
    expect(findPrice("m-big-exact", t)?.key).toBe("m-big-exact");
    expect(findPrice("m-big-exact-2", t)?.key).toBe("m-big*");
    expect(findPrice("m-small", t)?.key).toBe("m*");
    expect(findPrice("x", t)).toBeUndefined();
  });

  test("bracket tags and date suffixes fall back to the canonical id", () => {
    expect(canonicalModel("claude-opus-4-6[1m]")).toBe("claude-opus-4-6");
    expect(canonicalModel("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(canonicalModel("claude-sonnet-4-5-20250929[1m]")).toBe("claude-sonnet-4-5");
    expect(findPrice("claude-opus-4-6[1m]", tables)?.key).toBe("claude-opus-4-6");
    expect(findPrice("claude-opus-5-5-20261001", tables)?.key).toBe("claude-opus-5-5");
    // Bedrock ids are a different price list and stay unpriced.
    expect(findPrice("anthropic.claude-opus-5-5", tables)).toBeUndefined();
  });

  test("the first table wins an exact tie", () => {
    const row = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const a: PriceTable = { provider: "a", asOf: "x", sourceUrl: "x", currency: "USD", models: { m: row(1) } };
    const b: PriceTable = { provider: "b", asOf: "x", sourceUrl: "x", currency: "USD", models: { m: row(2) } };
    expect(findPrice("m", [a, b])?.table.provider).toBe("a");
  });
});

describe("loading", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-pricing-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("loadPriceTables reads only .json files, sorted", () => {
    const dir = tempDir();
    const table = (provider: string) =>
      JSON.stringify({
        provider,
        asOf: "2026-01-01",
        sourceUrl: "https://example.invalid",
        currency: "USD",
        models: { "z-1": { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } },
      });
    writeFileSync(join(dir, "b.json"), table("b"));
    writeFileSync(join(dir, "a.json"), table("a"));
    writeFileSync(join(dir, "README.md"), "not a table");
    expect(loadPriceTables(dir).map((t) => t.provider)).toEqual(["a", "b"]);
  });

  test("the embedded tables are exactly the repo's pricing/*.json files", () => {
    // A price file added to pricing/ but not to EMBEDDED_PRICES would silently go missing from the compiled binary.
    expect([...EMBEDDED_PRICE_FILES]).toEqual(readdirSync(DEFAULT_PRICING_DIR).filter((n) => n.endsWith(".json")).sort());
    expect(loadPriceTables()).toEqual(loadPriceTables(DEFAULT_PRICING_DIR));
  });

  test("embeddedPriceTables returns fresh copies", () => {
    const a = embeddedPriceTables();
    a[0]!.models = {};
    expect(Object.keys(embeddedPriceTables()[0]!.models).length).toBeGreaterThan(0);
  });

  test("loadPriceTables throws on a broken file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => loadPriceTables(dir)).toThrow(/invalid JSON/);
  });

  test("parsePriceTable rejects malformed tables", () => {
    const ok = {
      provider: "p",
      asOf: "2026-01-01",
      sourceUrl: "https://example.invalid",
      currency: "USD",
      models: { m: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
    };
    expect(parsePriceTable(ok).provider).toBe("p");
    expect(() => parsePriceTable({ ...ok, provider: "" })).toThrow(/provider/);
    expect(() => parsePriceTable({ ...ok, currency: "EUR" })).toThrow(/currency/);
    expect(() => parsePriceTable({ ...ok, models: { m: { ...ok.models.m, input: -1 } } })).toThrow(/input/);
    expect(() => parsePriceTable({ ...ok, models: { "*": ok.models.m } })).toThrow(/bad key/);
    expect(() => parsePriceTable({ ...ok, models: { "a*b": ok.models.m } })).toThrow(/bad key/);
    expect(() => parsePriceTable({ ...ok, models: { m: { ...ok.models.m, longContext: { input: 1 } } } })).toThrow(/thresholdTokens/);
    expect(() => parsePriceTable({ ...ok, geoMultipliers: { us: 0 } })).toThrow(/geoMultipliers/);
    expect(() => parsePriceTable([])).toThrow(/not an object/);
  });
});
