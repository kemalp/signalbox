import { describe, expect, test } from "bun:test";
import { buildReport, loadPriceTables, localDayKey, rangeDays, type LedgerEntry, type TokenCounts, type UsageRecord } from "../src/index.ts";

// Synthetic fixtures only. Prices used below (USD/MTok): opus-5-5 in 4 / out 20 / read 0.2 / 5m 5 / 1h 8,
// sonnet-5-5 in 2, haiku-5-5 in 0.1, haiku-4-5 read 0.1 / out 5.
const tables = loadPriceTables();
const NOW = new Date("2026-10-09T12:00:00Z");
const tok = (t: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });

let seq = 0;
function rec(over: Partial<Omit<UsageRecord, "tokens">> & { tokens?: Partial<TokenCounts> } = {}): UsageRecord {
  const { tokens, ...rest } = over;
  return {
    agent: "claude-code",
    id: `msg_${++seq}`,
    keyQuality: "id",
    sessionId: "s1",
    project: "/work/alpha",
    kind: "main",
    model: "claude-opus-5-5",
    ts: "2026-10-05T12:00:00Z",
    outputFinal: true,
    webSearchRequests: 0,
    ...rest,
    tokens: tok(tokens ?? {}),
  };
}

function led(over: Partial<Omit<LedgerEntry, "tokens">> & { tokens?: Partial<TokenCounts> } = {}): LedgerEntry {
  const { tokens, ...rest } = over;
  return { agent: "claude-code", sessionId: "s1", model: "claude-opus-5-5", costUsd: 0, source: "cost-state", ...rest, tokens: tok(tokens ?? {}) };
}

const WEEK = { since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z", timeZone: "UTC", now: NOW, tables };

describe("buildReport", () => {
  test("empty input gives zero totals and one zero row per day", () => {
    const r = buildReport({ ...WEEK, records: [], ledger: [] });
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.range).toEqual({ since: "2026-10-01T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" });
    expect(r.totals.responses).toBe(0);
    expect(r.totals.cost.total).toBe(0);
    expect(r.totals.processedTokens).toBe(0);
    expect(r.totals.freshTokens).toBe(0);
    expect(r.totals.cacheHitRatio).toBe(0);
    expect(r.totals.savedByCachingUsd).toBe(0);
    expect(r.totals.unpricedModels).toEqual([]);
    expect(r.totals.tokens.reasoning).toBeUndefined();
    expect(r.byDay.map((d) => d.key)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(r.byDay.every((d) => d.responses === 0 && d.cost.total === 0)).toBe(true);
    expect(r.byAgent).toEqual([]);
    expect(r.byModel).toEqual([]);
    expect(r.byProject).toEqual([]);
    expect(r.byKind).toEqual([]);
    expect(r.reconciliation).toEqual([]);
    expect(r.estimate.recordedUsd).toBe(0);
    expect(r.estimate.estimatedLowUsd).toBe(0);
    expect(r.estimate.estimatedHighUsd).toBe(0);
    expect(r.estimate.method.length).toBeGreaterThan(0);
    expect(r.priceTables[0]).toEqual({ provider: "anthropic", asOf: expect.any(String), sourceUrl: expect.stringContaining("platform.claude.com") });
    expect(r.notes).toEqual([]);
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  test("totals, groups and derived counters", () => {
    const records = [
      // 0.086024 (BRAINSTORM 6.3 worked example)
      rec({ tokens: { input: 6, cacheRead: 180_000, cacheWrite1h: 4_000, output: 900, reasoning: 300 } }),
      // 0.00400 + 0.05000 + 0.00016 = 0.05416, placeholder output
      rec({ kind: "subagent", tokens: { input: 1_000, cacheWrite5m: 10_000, output: 8 }, outputFinal: false }),
      // unpriced
      rec({ agent: "codex", sessionId: "c1", project: undefined, model: "gpt-5-codex", tokens: { input: 500, output: 100 } }),
      // 0.0001 + 0.00005 = 0.00015, hash-keyed
      rec({ kind: "workflow", project: "/work/beta", model: "claude-haiku-4-5-20251001", keyQuality: "hash", tokens: { cacheRead: 1_000, output: 10 } }),
    ];
    const r = buildReport({ ...WEEK, records });
    const t = r.totals;
    expect(t.responses).toBe(4);
    expect(t.placeholderResponses).toBe(1);
    expect(t.tokens).toEqual({ input: 1_506, output: 1_018, cacheRead: 181_000, cacheWrite5m: 10_000, cacheWrite1h: 4_000, reasoning: 300 });
    expect(t.processedTokens).toBe(197_524);
    expect(t.freshTokens).toBe(16_524);
    expect(t.cacheHitRatio).toBeCloseTo(181_000 / 196_506, 12);
    expect(t.savedByCachingUsd).toBeCloseTo(0.684 + 0.0009, 12);
    expect(t.cost.total).toBeCloseTo(0.140334, 12);
    expect(t.unpricedTokens).toBe(600);
    expect(t.unpricedModels).toEqual(["gpt-5-codex"]);

    expect(r.byAgent.map((g) => g.key)).toEqual(["claude-code", "codex"]);
    expect(r.byAgent[1]!.unpricedModels).toEqual(["gpt-5-codex"]);
    expect(r.byModel.map((g) => g.key)).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001", "gpt-5-codex"]);
    // The workflow record ran in /work/beta, but its session s1 started in /work/alpha.
    expect(r.byProject.map((g) => [g.key, g.responses])).toEqual([["/work/alpha", 3], ["(unknown)", 1]]);
    expect(r.byKind.map((g) => g.key)).toEqual(["main", "subagent", "workflow"]);
    expect(r.byKind[0]!.cost.total).toBeCloseTo(0.086024, 12);
    const day = r.byDay.find((d) => d.key === "2026-10-05")!;
    expect(day.responses).toBe(4);
    expect(day.cost.total).toBeCloseTo(t.cost.total, 12);
    expect(day.byModel!.map((g) => [g.key, g.responses])).toEqual([
      ["claude-opus-5-5", 2],
      ["claude-haiku-4-5-20251001", 1],
      ["gpt-5-codex", 1],
    ]);
    expect(day.byKind!.map((g) => g.key)).toEqual(["main", "subagent", "workflow"]);
    expect(day.byKind!.reduce((a, g) => a + g.cost.total, 0)).toBeCloseTo(t.cost.total, 12);
    expect(r.byDay.find((d) => d.key === "2026-10-01")!.byModel).toEqual([]);

    expect(r.notes.some((n) => n.includes("gpt-5-codex") && n.includes("600"))).toBe(true);
    expect(r.notes.some((n) => n.includes("hash-derived"))).toBe(true);
    expect(r.notes.some((n) => n.includes("placeholder") && n.includes("subagent 100.0%"))).toBe(true);
    // No ledger: estimate equals recorded.
    expect(r.estimate.estimatedLowUsd).toBeCloseTo(t.cost.total, 12);
    expect(r.estimate.estimatedHighUsd).toBeCloseTo(t.cost.total, 12);
  });

  test("byDay buckets by local calendar day across a time-zone boundary", () => {
    const records = [rec({ ts: "2026-10-08T23:30:00Z", tokens: { input: 1 } }), rec({ ts: "2026-10-09T06:30:00Z", tokens: { input: 2 } })];
    const base = { records, tables, now: NOW, since: "2026-10-08T00:00:00Z", until: "2026-10-10T00:00:00Z" };
    const days = (timeZone: string) => buildReport({ ...base, timeZone }).byDay.map((d) => [d.key, d.responses, d.tokens.input]);

    expect(days("UTC")).toEqual([["2026-10-08", 1, 1], ["2026-10-09", 1, 2]]);
    // UTC-7: both instants fall on Oct 8; the range starts on Oct 7 local.
    expect(days("America/Los_Angeles")).toEqual([["2026-10-07", 0, 0], ["2026-10-08", 2, 3], ["2026-10-09", 0, 0]]);
    // UTC+9: both fall on Oct 9; the range ends on Oct 10 local.
    expect(days("Asia/Tokyo")).toEqual([["2026-10-08", 0, 0], ["2026-10-09", 2, 3], ["2026-10-10", 0, 0]]);
  });

  test("byDay has no gaps or duplicates across a DST change", () => {
    // Europe/London leaves BST at 2026-10-25 02:00 local.
    const records = [rec({ ts: "2026-10-24T23:30:00Z" }), rec({ ts: "2026-10-25T23:30:00Z" })];
    const r = buildReport({ records, tables, now: NOW, since: "2026-10-24T00:00:00Z", until: "2026-10-27T00:00:00Z", timeZone: "Europe/London" });
    expect(r.byDay.map((d) => [d.key, d.responses])).toEqual([["2026-10-24", 0], ["2026-10-25", 2], ["2026-10-26", 0]]);
    // March 2026 in London, local midnight to local midnight (BST starts Mar 29): 31 days.
    expect(rangeDays(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-31T23:00:00Z"), "Europe/London")).toHaveLength(31);
    // A UTC-midnight end is 01:00 BST, so Apr 1 is touched locally.
    expect(rangeDays(new Date("2026-03-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z"), "Europe/London").at(-1)).toBe("2026-04-01");
    expect(localDayKey(new Date("2026-10-09T02:00:00Z"), "America/New_York")).toBe("2026-10-08");
  });

  test("range is [since, until): outside records are only used for reconciliation", () => {
    const records = [
      rec({ ts: "2026-09-30T23:59:59Z", tokens: { input: 1_000_000 } }), // before: $4
      rec({ ts: "2026-10-01T00:00:00Z", tokens: { input: 250_000 } }), // first instant: $1
      rec({ ts: "2026-10-08T00:00:00Z", tokens: { input: 1_000_000 } }), // until is exclusive: $4
      rec({ ts: "not a date", tokens: { input: 1 } }),
    ];
    const r = buildReport({ ...WEEK, records, ledger: [led({ tokens: { input: 2_250_000 } })] });
    expect(r.totals.responses).toBe(1);
    expect(r.totals.cost.total).toBeCloseTo(1, 12);
    expect(r.reconciliation).toHaveLength(1);
    expect(r.reconciliation[0]!.transcriptUsd).toBeCloseTo(9, 12);
    expect(r.reconciliation[0]!.ledgerUsd).toBeCloseTo(9, 12);
    expect(r.reconciliation[0]!.k).toBeCloseTo(1, 12);
    expect(r.notes.some((n) => n.includes("2 supplied records fall outside the range"))).toBe(true);
    expect(r.notes.some((n) => n.includes("1 record has an unparseable timestamp and was skipped"))).toBe(true);
  });

  test("reconciliation: k = transcript $ / ledger $ with both priced by the same table", () => {
    const records = [
      rec({ tokens: { input: 1_000_000 }, outputFinal: false }), // $4
      rec({ tokens: { output: 100_000 } }), // $2
      rec({ sessionId: "s2", project: "/work/beta", tokens: { input: 250_000 } }), // $1, no ledger
    ];
    const ledger = [
      led({ tokens: { input: 1_000_000, output: 200_000 }, costUsd: 7.9 }), // $8 at table price
      led({ sessionId: "s3", model: "claude-haiku-5-5", tokens: { input: 1_000_000 }, costUsd: 0.1 }), // ledger only, no records
    ];
    const r = buildReport({ ...WEEK, records, ledger });
    const byId = new Map(r.reconciliation.map((row) => [row.sessionId, row]));

    const s1 = byId.get("s1")!;
    expect(s1.project).toBe("/work/alpha");
    expect(s1.transcriptUsd).toBeCloseTo(6, 12);
    expect(s1.ledgerUsd).toBeCloseTo(8, 12);
    expect(s1.k).toBeCloseTo(0.75, 12);
    expect(s1.placeholderShare).toBe(0.5);

    const s2 = byId.get("s2")!;
    expect(s2.transcriptUsd).toBeCloseTo(1, 12);
    expect(s2.ledgerUsd).toBeUndefined();
    expect(s2.k).toBeUndefined();

    const s3 = byId.get("s3")!;
    expect(s3.transcriptUsd).toBe(0);
    expect(s3.ledgerUsd).toBeCloseTo(0.1, 12);
    expect(s3.k).toBeUndefined();
    expect(s3.project).toBeUndefined();

    expect(r.reconciliation.map((row) => row.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(r.notes.some((n) => n.includes("$8.00") && n.includes("own ledger figures total $8.00"))).toBe(true);
  });

  test("ledger cache writes are re-split by the transcript share, else priced as 1h", () => {
    const records = [
      rec({ tokens: { cacheWrite1h: 1_000_000 } }), // s1: all 1h, $8
      rec({ sessionId: "s2", tokens: { cacheWrite5m: 300_000, cacheWrite1h: 100_000 } }), // s2: 25% 1h
    ];
    const ledger = [
      led({ tokens: { cacheWrite5m: 1_000_000 } }), // adapter put the unsplit pool in 5m: priced as 1h = $8
      led({ model: "claude-haiku-5-5", tokens: { cacheWrite5m: 1_000_000 } }), // no transcript slice: 1h = $0.2
      led({ sessionId: "s2", tokens: { cacheWrite1h: 400_000 } }), // 300k at $5 + 100k at $8 = $2.3
    ];
    const r = buildReport({ ...WEEK, records, ledger });
    const byId = new Map(r.reconciliation.map((row) => [row.sessionId, row]));
    expect(byId.get("s1")!.ledgerUsd).toBeCloseTo(8.2, 12);
    expect(byId.get("s1")!.k).toBeCloseTo(8 / 8.2, 12);
    expect(byId.get("s2")!.ledgerUsd).toBeCloseTo(2.3, 12);
    expect(r.notes.some((n) => n.includes("no 5m/1h split"))).toBe(true);
  });

  test("estimate: ledger sessions at their ledger $, the rest by per-model k range, ledger-only spend added", () => {
    const records = [
      rec({ sessionId: "A", tokens: { input: 750_000 } }), // opus $3
      rec({ sessionId: "B", tokens: { input: 2_250_000 } }), // opus $9
      rec({ sessionId: "C", tokens: { input: 500_000 } }), // opus $2, no ledger
      rec({ sessionId: "C", model: "claude-sonnet-5-5", tokens: { input: 500_000 } }), // sonnet $1, no ledger anywhere
    ];
    const ledger = [
      led({ sessionId: "A", tokens: { input: 1_500_000 } }), // $6 -> k 0.5
      led({ sessionId: "A", model: "claude-haiku-5-5", tokens: { input: 5_000_000 } }), // $0.5, not in transcripts
      led({ sessionId: "B", tokens: { input: 2_500_000 } }), // $10 -> k 0.9
    ];
    const r = buildReport({ ...WEEK, records, ledger });
    // A and B count at their ledger $ (6 + 10). Only C's opus $2 is extrapolated:
    // pooled k = 12/16 = 0.75; $-weighted q25 = 0.5, q75 = 0.9.
    expect(r.estimate.recordedUsd).toBeCloseTo(15, 12);
    expect(r.estimate.estimatedLowUsd).toBeCloseTo(16 + 2 / 0.9 + 1 + 0.5, 10);
    expect(r.estimate.estimatedHighUsd).toBeCloseTo(16 + 2 / 0.5 + 1 + 0.5, 10);
    expect(r.estimate.estimatedLowUsd).toBeGreaterThanOrEqual(r.estimate.recordedUsd);
    expect(r.estimate.method).toContain("claude-opus-5-5 k 0.75 (25th-75th percentile 0.50-0.90, 2 sessions) on $2.00");
    expect(r.estimate.method).toContain("$16.00");
    expect(r.estimate.method).toContain(`$${(16 + 2 / 0.75 + 1.5).toFixed(2)}`);
    expect(r.estimate.method).toContain("$0.50");
  });

  test("estimate: one tiny transcript call doesn't turn auxiliary ledger spend into a huge k divisor", () => {
    // Session A spends $10 of haiku-4-5 through its ledger (auxiliary calls); session B has no ledger
    // and $1 of recorded haiku-4-5. haiku-4-5: input $1/MTok.
    const ledger = [led({ sessionId: "A", model: "claude-haiku-4-5", tokens: { input: 10_000_000 } })];
    const b = rec({ sessionId: "B", model: "claude-haiku-4-5", tokens: { input: 1_000_000 } });
    const without = buildReport({ ...WEEK, records: [b], ledger });
    expect(without.estimate.estimatedLowUsd).toBeCloseTo(11, 10);
    expect(without.estimate.estimatedHighUsd).toBeCloseTo(11, 10);
    const withTiny = buildReport({
      ...WEEK,
      records: [b, rec({ sessionId: "A", model: "claude-haiku-4-5", tokens: { input: 10_000 } })], // $0.01, k 0.001
      ledger,
    });
    expect(withTiny.estimate.recordedUsd).toBeCloseTo(1.01, 12);
    expect(withTiny.estimate.estimatedLowUsd).toBeCloseTo(11, 10);
    expect(withTiny.estimate.estimatedHighUsd).toBeCloseTo(11, 10);
    expect(withTiny.estimate.method).toContain("1 session/model ledger row with k below 0.5");
  });

  test("estimate: a ledger session's own k doesn't rescale it; only sessions without a ledger are extrapolated", () => {
    const records = [
      rec({ sessionId: "A", tokens: { input: 800_000 } }), // $3.2
      rec({ sessionId: "B", ts: "2026-09-20T00:00:00Z", tokens: { input: 750_000 } }), // $3 before the range
      rec({ sessionId: "B", tokens: { input: 250_000 } }), // $1 in range
    ];
    // A: ledger $4 -> k 0.8, counts at $4. B: ledger $5 -> k 0.8, counts at $5 x 1/4 in range.
    const ledger = [led({ sessionId: "A", tokens: { input: 1_000_000 } }), led({ sessionId: "B", tokens: { input: 1_250_000 } })];
    const r = buildReport({ ...WEEK, records, ledger });
    expect(r.estimate.recordedUsd).toBeCloseTo(4.2, 12);
    expect(r.estimate.estimatedLowUsd).toBeCloseTo(4 + 1.25, 10);
    expect(r.estimate.estimatedHighUsd).toBeCloseTo(4 + 1.25, 10);
  });

  test("estimate: a single session gives low = high; k is capped at 1; stale ledgers are left out", () => {
    const one = buildReport({
      ...WEEK,
      records: [rec({ tokens: { input: 1_000_000 } })], // $4
      ledger: [led({ tokens: { input: 1_250_000 } })], // $5 -> k 0.8
    });
    expect(one.estimate.estimatedLowUsd).toBeCloseTo(5, 10);
    expect(one.estimate.estimatedHighUsd).toBeCloseTo(5, 10);

    const stale = buildReport({
      ...WEEK,
      records: [rec({ tokens: { input: 2_500_000 } })], // $10
      ledger: [led({ tokens: { input: 1_250_000 } })], // $5: transcript exceeds ledger
    });
    expect(stale.reconciliation[0]!.k).toBeCloseTo(2, 12);
    expect(stale.estimate.estimatedLowUsd).toBeCloseTo(10, 10);
    expect(stale.estimate.estimatedHighUsd).toBeCloseTo(10, 10);
    expect(stale.notes.some((n) => n.includes("stale ledger"))).toBe(true);

    const slightlyOver = buildReport({
      ...WEEK,
      records: [rec({ tokens: { input: 1_010_000 } })],
      ledger: [led({ tokens: { input: 1_000_000 } })], // k 1.01: within tolerance, capped at 1
    });
    expect(slightlyOver.estimate.estimatedLowUsd).toBeCloseTo(slightlyOver.estimate.recordedUsd, 10);
  });

  test("ledger-only spend is pro-rated by the session's in-range share", () => {
    const records = [
      rec({ sessionId: "D", ts: "2026-10-02T00:00:00Z", tokens: { input: 250_000 } }), // $1 in range
      rec({ sessionId: "D", ts: "2026-09-20T00:00:00Z", tokens: { input: 750_000 } }), // $3 before the range
    ];
    const ledger = [
      led({ sessionId: "D", tokens: { input: 1_000_000 } }), // $4 -> k 1
      led({ sessionId: "D", model: "claude-haiku-5-5", tokens: { input: 10_000_000 } }), // $1 ledger only
    ];
    const r = buildReport({ ...WEEK, records, ledger });
    expect(r.estimate.recordedUsd).toBeCloseTo(1, 12);
    expect(r.estimate.estimatedLowUsd).toBeCloseTo(1 + 0.25, 10);
    expect(r.estimate.estimatedHighUsd).toBeCloseTo(1 + 0.25, 10);
  });

  test("duplicate ledger rows keep the newest; unknown geo values are noted", () => {
    const ledger = [
      led({ observedAt: "2026-10-03T00:00:00Z", tokens: { input: 1_000_000 } }),
      led({ observedAt: "2026-10-04T00:00:00Z", tokens: { input: 2_000_000 } }),
      led({ observedAt: "2026-10-02T00:00:00Z", tokens: { input: 3_000_000 } }),
    ];
    const records = [rec({ geo: "not_available" }), rec({ geo: "global" }), rec({ geo: "eu" })];
    const r = buildReport({ ...WEEK, records, ledger });
    expect(r.reconciliation[0]!.ledgerUsd).toBeCloseTo(8, 12);
    expect(r.notes.some((n) => n.includes("2 duplicate ledger rows"))).toBe(true);
    const geoNote = r.notes.find((n) => n.startsWith("Geo values"));
    expect(geoNote).toContain("eu");
    expect(geoNote).not.toContain("not_available");
    expect(geoNote).not.toContain("global");
  });

  test("byProject groups by the session's earliest main-thread cwd", () => {
    const records = [
      rec({ kind: "subagent", ts: "2026-10-05T09:00:00Z", project: "/work/alpha/pkg" }), // earliest, but not main
      rec({ ts: "2026-10-05T11:00:00Z", project: "/work/alpha/sub" }), // later main record
      rec({ ts: "2026-10-05T10:00:00Z", project: "/work/alpha" }), // earliest main record wins
      rec({ sessionId: "s2", kind: "workflow", project: "/work/beta/x" }), // no main record: earliest cwd
      rec({ sessionId: "s2", kind: "workflow", ts: "2026-10-06T00:00:00Z", project: "/work/beta/y" }),
      rec({ sessionId: "s3", project: undefined }),
    ];
    const r = buildReport({ ...WEEK, records });
    expect(r.byProject.map((g) => [g.key, g.responses])).toEqual([["/work/alpha", 3], ["/work/beta/x", 2], ["(unknown)", 1]]);
    expect(r.reconciliation.find((row) => row.sessionId === "s1")!.project).toBe("/work/alpha");
  });

  test("ledger web searches are priced like transcript web searches", () => {
    const ledger = [led({ tokens: { input: 1_000_000 }, webSearchRequests: 100 })]; // $4 + 100 x $0.01
    const r = buildReport({ ...WEEK, records: [rec({ tokens: { input: 1_000_000 } })], ledger });
    expect(r.reconciliation[0]!.ledgerUsd).toBeCloseTo(5, 12);
    expect(r.reconciliation[0]!.k).toBeCloseTo(0.8, 12);
  });

  test("bad ranges", () => {
    expect(() => buildReport({ ...WEEK, records: [], since: "nope" })).toThrow(/since/);
    const inverted = buildReport({ ...WEEK, records: [rec()], since: WEEK.until, until: WEEK.since });
    expect(inverted.byDay).toEqual([]);
    expect(inverted.totals.responses).toBe(0);
  });
});
