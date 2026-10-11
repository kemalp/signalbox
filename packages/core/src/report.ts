import type {
  AgentId,
  CostBreakdown,
  DayTotals,
  GroupTotals,
  LedgerEntry,
  PriceTable,
  ReconciliationRow,
  Report,
  TokenCounts,
  Totals,
  UsageRecord,
} from "./types.ts";
import { newerLedger, priceLedgerRow } from "./ledger.ts";
import {
  addCost,
  addTokens,
  canonicalModel,
  priceRecord,
  processedTokens,
  zeroCost,
  zeroTokens,
  type PriceResult,
} from "./pricing.ts";

/** Group key used in `byProject` for records without a project directory. */
export const UNKNOWN_PROJECT = "(unknown)";

/** byDay never lists more days than this. Beyond it, leading empty days are dropped. */
export const MAX_DAYS = 3660;

/** A session whose transcript $ exceeds its ledger $ by more than this ratio has a stale ledger and gives no k. */
export const STALE_LEDGER_K = 1.02;

/**
 * Session/model pairs with k below this are dominated by spend that never reaches transcripts (e.g.
 * auxiliary calls), not by placeholder under-recording, so they count at their ledger figure and are
 * left out of the per-model k that extrapolates sessions without a ledger.
 */
export const MIN_LEDGER_K = 0.5;

/**
 * UsageRecord flag for the second and later records of one API response that an adapter split into
 * several records (e.g. per usage.iterations[] entry). Their tokens and cost count; they don't count
 * as another response or placeholder, because a UsageRecord's response counts once.
 */
export const SPLIT_CONTINUATION_FLAG = "split-continuation";

/** False for the continuation records of a split response (see SPLIT_CONTINUATION_FLAG). */
export function countsAsResponse(rec: UsageRecord): boolean {
  return !rec.flags?.includes(SPLIT_CONTINUATION_FLAG);
}

export interface BuildReportInput {
  /**
   * Deduplicated usage records. Totals and groups use only the records inside [since, until).
   * Reconciliation compares whole sessions, because a ledger covers a whole session: pass every
   * record of the sessions you have (not only the in-range ones) for an unbiased k.
   */
  records: Iterable<UsageRecord>;
  /** Agent ledger rows, one per (agent, sessionId, model). Duplicates keep the newest row. */
  ledger?: Iterable<LedgerEntry>;
  tables: readonly PriceTable[];
  since: Date | string;
  /** Exclusive. */
  until: Date | string;
  /** IANA time zone for `byDay`. Default: the system time zone. */
  timeZone?: string;
  /** `generatedAt` override, for tests. */
  now?: Date;
}

interface Priced {
  rec: UsageRecord;
  pr: PriceResult;
  inRange: boolean;
}

interface ModelSlice {
  cost: number;
  costInRange: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface SessionAgg {
  agent: AgentId;
  sessionId: string;
  project?: string;
  responses: number;
  placeholders: number;
  costAll: number;
  costInRange: number;
  inRangeResponses: number;
  byModel: Map<string, ModelSlice>;
}

interface LedgerSession {
  agent: AgentId;
  sessionId: string;
  /** canonical model -> newest entry */
  byModel: Map<string, LedgerEntry>;
}

export function buildReport(input: BuildReportInput): Report {
  const since = toDate(input.since, "since");
  const until = toDate(input.until, "until");
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { tables } = input;
  const notes: string[] = [];

  // ---- Price every record once, and find each session's project: the cwd of its earliest
  // main-thread record, else of its earliest record. byProject groups by it, so a session that
  // cd's around (or a subagent working in a subdirectory) stays under one project.
  const priced: Priced[] = [];
  const sessionProject = new Map<string, { project: string; main: boolean; t: number }>();
  let badTs = 0;
  for (const rec of input.records) {
    const t = Date.parse(rec.ts);
    if (Number.isNaN(t)) {
      badTs++;
      continue;
    }
    priced.push({ rec, pr: priceRecord(rec, tables), inRange: t >= since.getTime() && t < until.getTime() });
    if (rec.project) {
      const key = sessionKey(rec.agent, rec.sessionId);
      const main = rec.kind === "main";
      const prev = sessionProject.get(key);
      if (!prev || (main && !prev.main) || (main === prev.main && t < prev.t)) {
        sessionProject.set(key, { project: rec.project, main, t });
      }
    }
  }
  const inRange = priced.filter((p) => p.inRange);
  const projectOf = (rec: UsageRecord): string =>
    sessionProject.get(sessionKey(rec.agent, rec.sessionId))?.project ?? rec.project ?? UNKNOWN_PROJECT;

  // ---- Totals and groups.
  const total = newAcc();
  const groups = {
    agent: new Map<string, Acc>(),
    model: new Map<string, Acc>(),
    project: new Map<string, Acc>(),
    kind: new Map<string, Acc>(),
    day: new Map<string, Acc>(),
  };
  const daySplits = new Map<string, { model: Map<string, Acc>; kind: Map<string, Acc> }>();
  let savedByCaching = 0;
  let hashKeyed = 0;
  let fastWithoutRate = 0;
  const geoUnknown = new Set<string>();
  for (const { rec, pr } of inRange) {
    const day = localDayKey(new Date(rec.ts), timeZone);
    let split = daySplits.get(day);
    if (!split) daySplits.set(day, (split = { model: new Map(), kind: new Map() }));
    for (const [map, key] of [
      [groups.agent, rec.agent],
      [groups.model, rec.model],
      [groups.project, projectOf(rec)],
      [groups.kind, rec.kind],
      [groups.day, day],
      [split.model, rec.model],
      [split.kind, rec.kind],
    ] as const) {
      let acc = map.get(key);
      if (!acc) map.set(key, (acc = newAcc()));
      addToAcc(acc, rec, pr);
    }
    addToAcc(total, rec, pr);
    savedByCaching += pr.cacheSavingsUsd;
    const counts = countsAsResponse(rec);
    if (counts && rec.keyQuality === "hash") hashKeyed++;
    if (counts && pr.priced && rec.speed === "fast" && !pr.fast) fastWithoutRate++;
    if (pr.priced && rec.geo !== undefined && !UNREPORTED_GEOS.has(rec.geo) && !knownGeo(rec, tables)) geoUnknown.add(rec.geo);
  }

  const totals = finishAcc(total);
  const t = totals.tokens;
  const cacheDenom = t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input;

  // ---- byDay: every local calendar day in the range, oldest first, zero days included.
  let days = rangeDays(since, until, timeZone);
  if (days.length > MAX_DAYS) {
    const firstWithData = [...groups.day.keys()].sort()[0];
    const start = firstWithData ?? days[days.length - 1];
    days = days.filter((d) => start !== undefined && d >= start).slice(-MAX_DAYS);
    notes.push(`The range spans more than ${MAX_DAYS} days, so byDay starts at the first day with usage.`);
  }
  const byDay: DayTotals[] = days.map((d) => {
    const split = daySplits.get(d);
    return {
      key: d,
      ...finishAcc(groups.day.get(d) ?? newAcc()),
      byModel: split ? sortGroups(split.model) : [],
      byKind: split ? sortGroups(split.kind) : [],
    };
  });

  // ---- Sessions (all supplied records) and ledger.
  const sessions = new Map<string, SessionAgg>();
  for (const { rec, pr, inRange: within } of priced) {
    const key = sessionKey(rec.agent, rec.sessionId);
    let s = sessions.get(key);
    if (!s) {
      s = {
        agent: rec.agent,
        sessionId: rec.sessionId,
        responses: 0,
        placeholders: 0,
        costAll: 0,
        costInRange: 0,
        inRangeResponses: 0,
        byModel: new Map(),
      };
      const sp = sessionProject.get(key);
      if (sp) s.project = sp.project;
      sessions.set(key, s);
    }
    const counts = countsAsResponse(rec);
    if (counts) {
      s.responses++;
      if (!rec.outputFinal) s.placeholders++;
    }
    s.costAll += pr.cost.total;
    if (within) {
      s.costInRange += pr.cost.total;
      if (counts) s.inRangeResponses++;
    }
    const m = canonicalModel(rec.model);
    let slice = s.byModel.get(m);
    if (!slice) s.byModel.set(m, (slice = { cost: 0, costInRange: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
    slice.cost += pr.cost.total;
    if (within) slice.costInRange += pr.cost.total;
    slice.cacheWrite5m += rec.tokens.cacheWrite5m;
    slice.cacheWrite1h += rec.tokens.cacheWrite1h;
  }

  const ledgerSessions = new Map<string, LedgerSession>();
  let ledgerDuplicates = 0;
  for (const e of input.ledger ?? []) {
    const key = sessionKey(e.agent, e.sessionId);
    let ls = ledgerSessions.get(key);
    if (!ls) ledgerSessions.set(key, (ls = { agent: e.agent, sessionId: e.sessionId, byModel: new Map() }));
    const m = canonicalModel(e.model);
    const prev = ls.byModel.get(m);
    if (prev) ledgerDuplicates++;
    if (!prev || newerLedger(e, prev)) ls.byModel.set(m, e);
  }

  // Price each ledger row with our tables. The ledger has no 5m/1h split, so its cache writes are
  // re-split by the session's own transcript share for that model, or priced as 1h (main sessions
  // write 1h on a subscription) when the transcript has no cache writes for it.
  const ledgerUsd = new Map<string, Map<string, number>>();
  let ledgerOwnUsd = 0;
  let ledgerOurUsd = 0;
  let ledgerResplit = 0;
  const ledgerUnpriced = new Set<string>();
  for (const [key, ls] of ledgerSessions) {
    const perModel = new Map<string, number>();
    const s = sessions.get(key);
    for (const [m, e] of ls.byModel) {
      const pr = priceLedgerRow(e, s?.byModel.get(m), tables);
      if (pr.resplit) ledgerResplit++;
      if (!pr.priced) ledgerUnpriced.add(e.model);
      perModel.set(m, pr.usd);
      ledgerOurUsd += pr.usd;
      ledgerOwnUsd += num(e.costUsd);
    }
    ledgerUsd.set(key, perModel);
  }

  // ---- Reconciliation rows: sessions active in the range, plus every session with a ledger.
  const rowKeys = new Set<string>();
  for (const [key, s] of sessions) if (s.inRangeResponses > 0) rowKeys.add(key);
  for (const key of ledgerSessions.keys()) rowKeys.add(key);
  const reconciliation: ReconciliationRow[] = [];
  for (const key of rowKeys) {
    const s = sessions.get(key);
    const ls = ledgerSessions.get(key);
    const perModel = ledgerUsd.get(key);
    const row: ReconciliationRow = {
      agent: (s ?? ls)!.agent,
      sessionId: (s ?? ls)!.sessionId,
      transcriptUsd: s?.costAll ?? 0,
      placeholderShare: s && s.responses > 0 ? s.placeholders / s.responses : 0,
    };
    if (perModel) {
      const l = sum(perModel.values());
      row.ledgerUsd = l;
      if (l > 0 && s && s.responses > 0) row.k = s.costAll / l;
    }
    if (s?.project !== undefined) row.project = s.project;
    reconciliation.push(row);
  }
  reconciliation.sort(
    (a, b) =>
      Math.max(b.transcriptUsd, b.ledgerUsd ?? 0) - Math.max(a.transcriptUsd, a.ledgerUsd ?? 0) ||
      a.sessionId.localeCompare(b.sessionId),
  );

  // ---- Estimate. A session/model with a usable ledger counts at its ledger figure, pro-rated to the
  // range. Everything else is extrapolated as recorded / k, with k per model from the session/model
  // pairs that have both transcript and ledger $ (and are not dominated by ledger-only spend).
  const pairs = new Map<string, Array<{ k: number; t: number; l: number }>>();
  /** In-range transcript $ per model that is already covered by a ledger figure. */
  const coveredByModel = new Map<string, number>();
  let staleLedger = 0;
  let lowKPairs = 0;
  let ledgerExactUsd = 0;
  let ledgerOnlyUsd = 0;
  for (const [key, perModel] of ledgerUsd) {
    const s = sessions.get(key);
    for (const [m, l] of perModel) {
      if (l <= 0) continue;
      const slice = s?.byModel.get(m);
      const tr = slice?.cost ?? 0;
      if (tr <= 0) {
        // Spend that never reaches transcripts, e.g. auxiliary calls. Pro-rated to the range.
        ledgerOnlyUsd += l * inRangeShare(s);
        continue;
      }
      const k = tr / l;
      if (k > STALE_LEDGER_K) {
        // The ledger missed later activity; extrapolate this session's records like any other.
        staleLedger++;
        continue;
      }
      const inRangeTr = slice?.costInRange ?? 0;
      ledgerExactUsd += Math.max(l, tr) * (inRangeTr / tr);
      coveredByModel.set(m, (coveredByModel.get(m) ?? 0) + inRangeTr);
      if (k < MIN_LEDGER_K) {
        lowKPairs++;
        continue;
      }
      let list = pairs.get(m);
      if (!list) pairs.set(m, (list = []));
      list.push({ k: Math.min(k, 1), t: tr, l });
    }
  }

  const recordedByModel = new Map<string, number>();
  for (const { rec, pr } of inRange) {
    const m = canonicalModel(rec.model);
    recordedByModel.set(m, (recordedByModel.get(m) ?? 0) + pr.cost.total);
  }
  let low = ledgerExactUsd + ledgerOnlyUsd;
  let high = low;
  let point = low;
  const kSummaries: string[] = [];
  for (const [m, recorded] of [...recordedByModel].sort((a, b) => b[1] - a[1])) {
    // Float sums: treat a sub-micro-dollar remainder as fully covered.
    const rest = Math.max(recorded - (coveredByModel.get(m) ?? 0), 0);
    const list = pairs.get(m);
    if (!list || list.length === 0 || rest < 1e-9) {
      low += rest;
      high += rest;
      point += rest;
      continue;
    }
    const pooled = Math.min(sum(list.map((p) => p.t)) / sum(list.map((p) => p.l)), 1);
    const q25 = weightedQuantile(list, 0.25);
    const q75 = weightedQuantile(list, 0.75);
    low += rest / Math.max(pooled, q75);
    high += rest / Math.min(pooled, q25);
    point += rest / pooled;
    kSummaries.push(
      `${clipId(m)} k ${pooled.toFixed(2)} (25th-75th percentile ${q25.toFixed(2)}-${q75.toFixed(2)}, ${plural(list.length, "session")}) on ${usd(rest)}`,
    );
  }

  const recordedUsd = totals.cost.total;
  const method = [
    "Recorded is the sum of transcript-priced responses at list price. It is a lower bound: placeholder output counts and calls that never reach transcripts are missing.",
    ledgerExactUsd > 0
      ? `Sessions with the agent's own ledger count at that ledger figure (priced with the same table), pro-rated to the range by their transcript $: ${usd(ledgerExactUsd)}.`
      : "",
    kSummaries.length > 0
      ? `The rest is estimated as recorded / k per model, where k = transcript $ / ledger $ over sessions that have both: ${kSummaries.join("; ")}. The low-high range uses the ledger-$-weighted 75th and 25th percentiles of per-session k, widened to include the pooled k (point estimate ${usd(point)}). k is capped at 1.`
      : ledgerSessions.size === 0
        ? "No session has both transcript and ledger data, so estimated equals recorded."
        : "",
    lowKPairs > 0
      ? `${plural(lowKPairs, "session/model ledger row")} with k below ${MIN_LEDGER_K} (mostly calls that never reach transcripts) count at their ledger figure and are left out of k.`
      : "",
    "Models without ledger data count at their recorded value.",
    ledgerOnlyUsd > 0
      ? `Ledger-only spend (models that appear in a ledger but not in that session's transcripts, e.g. auxiliary calls) adds ${usd(ledgerOnlyUsd)}, pro-rated to the range.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ---- Notes.
  if (totals.unpricedModels.length > 0) {
    notes.push(
      `No price row for ${totals.unpricedModels.map((x) => clipId(x)).join(", ")}: ${plural(totals.unpricedTokens, "token")} ${agree(totals.unpricedTokens, "is", "are")} counted at $0.`,
    );
  }
  if (hashKeyed > 0) {
    notes.push(
      `${plural(hashKeyed, "response")} ${agree(hashKeyed, "has a hash-derived dedup key", "have hash-derived dedup keys")} (no message or request id), so ${agree(hashKeyed, "it", "they")} may be double counted.`,
    );
  }
  if (totals.placeholderResponses > 0) {
    const byKind = [...groups.kind.entries()]
      .filter(([, a]) => a.placeholders > 0)
      .map(([k, a]) => `${k} ${pct(a.placeholders / a.responses)}`)
      .join(", ");
    notes.push(
      `${fmtInt(totals.placeholderResponses)} of ${plural(totals.responses, "response")} (${pct(totals.placeholderResponses / totals.responses)}) only ${agree(totals.placeholderResponses, "has", "have")} a placeholder output count, so ${agree(totals.placeholderResponses, "its", "their")} output cost is a lower bound (by kind: ${byKind}).`,
    );
  }
  if (ledgerSessions.size > 0) {
    notes.push(
      "Ledger cache writes have no 5m/1h split. They are split by the session's transcript share for the same model, or priced as 1h writes (main sessions write 1h on a subscription) when the transcript has no cache writes for that model." +
        (ledgerResplit > 0 ? ` ${plural(ledgerResplit, "ledger row")} used a transcript share below 100% 1h.` : ""),
    );
    notes.push("Ledger rows are session sums, so per-request long-context tiers (Haiku 5.5 over 100K tokens) are not applied to them.");
    notes.push(
      `The agents' own ledger figures total ${usd(ledgerOwnUsd)}. The same tokens cost ${usd(ledgerOurUsd)} at the table price, and reconciliation uses the latter so that a price-table disagreement doesn't look like missing data.`,
    );
  }
  if (ledgerUnpriced.size > 0) notes.push(`Ledger rows with no price row (counted at $0): ${[...ledgerUnpriced].sort().map((x) => clipId(x)).join(", ")}.`);
  if (ledgerDuplicates > 0) {
    notes.push(`${plural(ledgerDuplicates, "duplicate ledger row")} (same session and model) ${agree(ledgerDuplicates, "was", "were")} collapsed to the newest.`);
  }
  if (staleLedger > 0) {
    notes.push(
      `${plural(staleLedger, "session/model ledger row")} ${agree(staleLedger, "is", "are")} smaller than the transcript (stale ledger, e.g. written before a resume), so ${agree(staleLedger, "it was", "they were")} left out of k and the estimate.`,
    );
  }
  const outside = priced.length - inRange.length;
  if (outside > 0) {
    notes.push(`${plural(outside, "supplied record")} ${agree(outside, "falls", "fall")} outside the range. They are used only to reconcile whole sessions.`);
  }
  if (badTs > 0) notes.push(`${plural(badTs, "record")} ${agree(badTs, "has an unparseable timestamp and was", "have an unparseable timestamp and were")} skipped.`);
  if (fastWithoutRate > 0) {
    notes.push(
      `${plural(fastWithoutRate, "fast-mode response")} ${agree(fastWithoutRate, "is on a model", "are on models")} without a fast rate and ${agree(fastWithoutRate, "was", "were")} priced at standard rates.`,
    );
  }
  if (geoUnknown.size > 0) notes.push(`Geo values without a multiplier, priced at 1x: ${[...geoUnknown].sort().map((x) => clipId(x)).join(", ")}.`);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    range: { since: since.toISOString(), until: until.toISOString() },
    totals: {
      ...totals,
      processedTokens: processedTokens(t),
      freshTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.output,
      cacheHitRatio: cacheDenom > 0 ? t.cacheRead / cacheDenom : 0,
      savedByCachingUsd: savedByCaching,
    },
    byAgent: sortGroups(groups.agent),
    byModel: sortGroups(groups.model),
    byProject: sortGroups(groups.project),
    byKind: sortGroups(groups.kind),
    byDay,
    reconciliation,
    estimate: { recordedUsd, estimatedLowUsd: low, estimatedHighUsd: high, method },
    priceTables: tables.map((tb) => ({ provider: tb.provider, asOf: tb.asOf, sourceUrl: tb.sourceUrl })),
    notes,
  };
}

// ---------- Days ----------

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The local calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDayKey(date: Date, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Every local calendar day touched by [since, until), oldest first. */
export function rangeDays(since: Date, until: Date, timeZone: string): string[] {
  if (until.getTime() <= since.getTime()) return [];
  const first = localDayKey(since, timeZone);
  const last = localDayKey(new Date(until.getTime() - 1), timeZone);
  const out: string[] = [];
  // Calendar arithmetic in UTC: a local day is always one calendar step, whatever DST does.
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  for (let i = 0; ; i++) {
    const key = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (key > last) break;
    out.push(key);
  }
  return out;
}

// ---------- Accumulators ----------

interface Acc {
  tokens: TokenCounts;
  cost: CostBreakdown;
  responses: number;
  placeholders: number;
  unpricedTokens: number;
  unpriced: Set<string>;
}

function newAcc(): Acc {
  return { tokens: zeroTokens(), cost: zeroCost(), responses: 0, placeholders: 0, unpricedTokens: 0, unpriced: new Set() };
}

function addToAcc(acc: Acc, rec: UsageRecord, pr: PriceResult): void {
  addTokens(acc.tokens, rec.tokens);
  addCost(acc.cost, pr.cost);
  if (countsAsResponse(rec)) {
    acc.responses++;
    if (!rec.outputFinal) acc.placeholders++;
  }
  if (!pr.priced) {
    acc.unpricedTokens += processedTokens(rec.tokens);
    acc.unpriced.add(rec.model);
  }
}

function finishAcc(acc: Acc): Totals {
  return {
    tokens: { ...acc.tokens },
    cost: { ...acc.cost },
    responses: acc.responses,
    placeholderResponses: acc.placeholders,
    unpricedTokens: acc.unpricedTokens,
    unpricedModels: [...acc.unpriced].sort(),
  };
}

function sortGroups(map: Map<string, Acc>): GroupTotals[] {
  return [...map.entries()]
    .map(([key, acc]) => ({ key, ...finishAcc(acc) }))
    .sort((a, b) => b.cost.total - a.cost.total || b.responses - a.responses || a.key.localeCompare(b.key));
}

// ---------- Helpers ----------

/** Geo values that mean "not reported", which is standard pricing. */
const UNREPORTED_GEOS = new Set(["", "not_available"]);

function knownGeo(rec: UsageRecord, tables: readonly PriceTable[]): boolean {
  return tables.some((tb) => tb.geoMultipliers !== undefined && rec.geo !== undefined && Object.hasOwn(tb.geoMultipliers, rec.geo));
}

function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}\u0000${sessionId}`;
}

/** The share of a session's transcript $ that falls inside the range (1 when it has no records). */
function inRangeShare(s: SessionAgg | undefined): number {
  if (!s) return 1;
  if (s.costAll > 0) return s.costInRange / s.costAll;
  return s.inRangeResponses > 0 ? 1 : 0;
}

/** Weighted quantile of k, weighted by ledger $. */
function weightedQuantile(items: ReadonlyArray<{ k: number; l: number }>, q: number): number {
  const sorted = [...items].sort((a, b) => a.k - b.k);
  const totalW = sum(sorted.map((i) => i.l));
  let cum = 0;
  for (const i of sorted) {
    cum += i.l;
    if (cum >= q * totalW) return i.k;
  }
  return sorted[sorted.length - 1]?.k ?? 1;
}

function toDate(v: Date | string, name: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`buildReport: invalid ${name}: ${String(v)}`);
  return d;
}

function sum(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "1 response", "2 responses" (count formatted with thousands separators). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Picks the singular or plural form of a following word for count `n`. */
export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Model ids (and other ids) come from agent files and can be arbitrarily long; clip them for text. */
export function clipId(id: string, max = 64): string {
  return id.length <= max ? id : `${id.slice(0, max - 1)}…`;
}
