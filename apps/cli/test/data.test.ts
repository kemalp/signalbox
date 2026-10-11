import { describe, expect, test } from "bun:test";
import { loadPriceTables, type Adapter, type HistorySession, type LedgerEntry, type ScanOptions, type TokenCounts, type UsageRecord } from "@signalbox/core";
import { SignalboxData } from "../src/data.ts";
import type { AdapterEntry, LoadedAdapter } from "../src/registry.ts";

// Synthetic fixtures only. claude-opus-5-5: input $4/MTok.
const tables = loadPriceTables();
const tok = (t: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });
let seq = 0;
const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  agent: "fake",
  id: `r${++seq}`,
  keyQuality: "id",
  sessionId: "s1",
  project: "/work/alpha",
  kind: "main",
  model: "claude-opus-5-5",
  ts: "2026-10-08T12:00:00.000Z",
  tokens: tok({ input: 1_000_000 }),
  outputFinal: true,
  webSearchRequests: 0,
  ...over,
});

interface Fake extends Adapter {
  scans: ScanOptions[];
}

function fake(id: string, records: UsageRecord[], extra: Partial<Adapter> = {}): Fake {
  const scans: ScanOptions[] = [];
  return {
    id,
    displayName: id,
    scans,
    detect: async () => true,
    health: async () => [{ name: `${id}:source`, stability: "internal", ok: true, detail: "synthetic" }],
    async *scanUsage(opts: ScanOptions) {
      scans.push(opts);
      for (const r of records) {
        const t = Date.parse(r.ts);
        if (opts.wholeSessions || ((!opts.since || t >= opts.since.getTime()) && (!opts.until || t < opts.until.getTime()))) yield r;
      }
    },
    ...extra,
  };
}

const entry = (id: string): AdapterEntry => ({ id, displayName: id, create: () => { throw new Error("unused"); }, dataDirs: () => [] });
const load = (...adapters: Adapter[]): LoadedAdapter[] => adapters.map((adapter) => ({ entry: entry(adapter.id), adapter }));
const NOW = new Date("2026-10-09T00:00:00.000Z");
const SINCE = new Date("2026-10-02T00:00:00.000Z");

describe("SignalboxData.report", () => {
  test("asks for whole sessions, then reports only the range", async () => {
    const a = fake("fake", [rec(), rec({ ts: "2026-09-20T00:00:00.000Z" })]);
    const data = new SignalboxData({ adapters: load(a), tables, now: () => NOW, timeZone: "UTC" });
    const r = await data.report({ since: SINCE, until: NOW });
    expect(a.scans).toEqual([{ since: SINCE, until: NOW, wholeSessions: true }]);
    expect(r.totals.responses).toBe(1);
    expect(r.estimate.recordedUsd).toBeCloseTo(4, 10);
    // The out-of-range record still counts toward the session's reconciliation.
    expect(r.reconciliation[0]!.transcriptUsd).toBeCloseTo(8, 10);
    expect(r.byDay).toHaveLength(7);
  });

  test("reuses a scan within the TTL, also across agent filters", async () => {
    const a = fake("a", [rec({ agent: "a" })]);
    const b = fake("b", [rec({ agent: "b", sessionId: "s2" })]);
    const data = new SignalboxData({ adapters: load(a, b), tables, now: () => NOW });
    const all = await data.report({ since: SINCE });
    const onlyB = await data.report({ since: SINCE, agent: "b" });
    await data.report({ since: SINCE });
    expect(a.scans).toHaveLength(1);
    expect(b.scans).toHaveLength(1);
    expect(all.byAgent.map((g) => g.key).sort()).toEqual(["a", "b"]);
    expect(onlyB.byAgent.map((g) => g.key)).toEqual(["b"]);
  });

  test("rescans after the TTL", async () => {
    const a = fake("a", [rec({ agent: "a" })]);
    const data = new SignalboxData({ adapters: load(a), tables, now: () => NOW, ttlMs: 0 });
    await data.report({ since: SINCE });
    await data.report({ since: SINCE });
    expect(a.scans).toHaveLength(2);
  });

  test("passes ledgers through and notes adapter failures instead of throwing", async () => {
    const ledger: LedgerEntry[] = [{ agent: "a", sessionId: "s1", model: "claude-opus-5-5", tokens: tok({ input: 2_000_000 }), costUsd: 8, source: "test" }];
    const a = fake("a", [rec({ agent: "a" })], { readLedger: async () => ledger });
    const broken = fake("broken", [], {
      async *scanUsage() {
        throw new Error("format changed");
      },
    });
    const data = new SignalboxData({ adapters: load(a, broken), tables, now: () => NOW });
    const r = await data.report({ since: SINCE, until: NOW });
    expect(r.reconciliation.find((row) => row.agent === "a")!.k).toBeCloseTo(0.5, 10);
    expect(r.notes.some((n) => n.startsWith("broken: usage scan failed (format changed)"))).toBe(true);
  });

  test("an agent filter with no adapter gives an empty report with a note", async () => {
    const data = new SignalboxData({ adapters: load(fake("a", [rec()])), tables, now: () => NOW });
    const r = await data.report({ since: SINCE, agent: "nobody" });
    expect(r.totals.responses).toBe(0);
    expect(r.notes[0]).toStartWith("No nobody data was found on this machine.");
    expect(r.notes[0]).toContain("unknown, not $0");
  });

  test("no detected agent at all says where it looked instead of reading as $0", async () => {
    const a = fake("a", [rec()], { detect: async () => false });
    const entryWithDirs: AdapterEntry = { ...entry("a"), displayName: "Agent A", homeEnv: "A_HOME", dataDirs: () => [{ label: "home", path: "/nowhere/.a" }] };
    const data = new SignalboxData({ adapters: [{ entry: entryWithDirs, adapter: a }], tables, now: () => NOW });
    const r = await data.report({ since: SINCE, until: NOW });
    expect(r.notes[0]).toBe(
      "No agent data was found on this machine; looked for Agent A in /nowhere/.a (set A_HOME to change it). This is unknown, not $0 of usage: run `signalbox doctor` for details.",
    );
  });

  test("scan issues reported by the registry entry become notes", async () => {
    const a = fake("a", [rec({ agent: "a" })]);
    const withIssues: AdapterEntry = { ...entry("a"), scanIssues: () => ["1 transcript could not be read (e.g. permission denied), so its usage is missing"] };
    const data = new SignalboxData({ adapters: [{ entry: withIssues, adapter: a }], tables, now: () => NOW });
    const r = await data.report({ since: SINCE, until: NOW });
    expect(r.notes).toContain("a: 1 transcript could not be read (e.g. permission denied), so its usage is missing.");
  });

  test("maxAgeMs forces a rescan of a cached window, but never a second copy of one in flight", async () => {
    const a = fake("a", [rec({ agent: "a" })]);
    const data = new SignalboxData({ adapters: load(a), tables, now: () => NOW });
    await Promise.all([data.report({ since: SINCE }), data.report({ since: SINCE }, { maxAgeMs: 0 })]);
    expect(a.scans).toHaveLength(1);
    await data.report({ since: SINCE });
    expect(a.scans).toHaveLength(1);
    await data.report({ since: SINCE }, { maxAgeMs: 0 });
    expect(a.scans).toHaveLength(2);
    // The forced scan replaced the cached one.
    await data.report({ since: SINCE });
    expect(a.scans).toHaveLength(2);
  });

  test("adapters that detect no data are skipped", async () => {
    const a = fake("a", [rec()], { detect: async () => false });
    const data = new SignalboxData({ adapters: load(a), tables, now: () => NOW });
    await data.report({ since: SINCE });
    expect(a.scans).toHaveLength(0);
  });
});

describe("SignalboxData.fleet and health", () => {
  test("joins sessions with context and whole-session cost; missing pieces stay undefined", async () => {
    const now = new Date();
    const ts = new Date(now.getTime() - 3_600_000).toISOString();
    const a = fake("a", [rec({ agent: "a", ts }), rec({ agent: "a", ts, tokens: tok({ input: 500_000 }) })], {
      listSessions: async () => [
        { agent: "a", sessionId: "s1", status: "busy", source: "test" },
        { agent: "a", sessionId: "s9", status: "idle", source: "test" },
      ],
      readContext: async () => [{ agent: "a", sessionId: "s1", tokens: 1234, observedAt: ts, quality: "estimated", source: "test" }],
      readLimits: async () => {
        throw new Error("no limits today");
      },
      readCompactions: async () => [{ agent: "a", sessionId: "s1", ts, trigger: "auto" }],
    });
    const data = new SignalboxData({ adapters: load(a), tables });
    const f = await data.fleet();
    const s1 = f.sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.costUsd).toBeCloseTo(6, 10);
    expect(s1.context?.tokens).toBe(1234);
    expect((s1 as { unpricedTokens?: number }).unpricedTokens).toBeUndefined();
    const s9 = f.sessions.find((s) => s.sessionId === "s9")!;
    expect(s9.costUsd).toBeUndefined();
    expect(s9.context).toBeUndefined();
    expect(f.limits).toEqual([]);
    expect(f.compactions).toHaveLength(1);
    expect(f.health.map((h) => h.name)).toEqual(["a:source"]);
  });

  test("session cost is unknown when every record is unpriced, and flags unpriced tokens otherwise", async () => {
    const ts = new Date(Date.now() - 3_600_000).toISOString();
    const a = fake(
      "a",
      [
        rec({ agent: "a", sessionId: "only-unpriced", model: "mystery-model", ts, tokens: tok({ input: 100 }) }),
        rec({ agent: "a", sessionId: "mixed", ts, tokens: tok({ input: 250_000 }) }),
        rec({ agent: "a", sessionId: "mixed", model: "mystery-model", ts, tokens: tok({ input: 40, output: 2 }) }),
      ],
      {
        listSessions: async () => [
          { agent: "a", sessionId: "only-unpriced", status: "busy", source: "test" },
          { agent: "a", sessionId: "mixed", status: "idle", source: "test" },
        ],
      },
    );
    const f = await new SignalboxData({ adapters: load(a), tables }).fleet();
    const only = f.sessions.find((s) => s.sessionId === "only-unpriced")! as { costUsd?: number; unpricedTokens?: number };
    expect(only.costUsd).toBeUndefined();
    expect(only.unpricedTokens).toBe(100);
    const mixed = f.sessions.find((s) => s.sessionId === "mixed")! as { costUsd?: number; unpricedTokens?: number };
    expect(mixed.costUsd).toBeCloseTo(1, 10);
    expect(mixed.unpricedTokens).toBe(42);
  });

  test("health has its own TTL; fleet reuses it and its cached scan unless asked for fresh data", async () => {
    let healthCalls = 0;
    const ts = new Date(Date.now() - 3_600_000).toISOString();
    const a = fake("a", [rec({ agent: "a", ts })], {
      health: async () => {
        healthCalls++;
        return [{ name: "a:source", stability: "internal", ok: true, detail: "synthetic" }];
      },
      listSessions: async () => [{ agent: "a", sessionId: "s1", status: "busy", source: "test" }],
    });
    const data = new SignalboxData({ adapters: load(a), tables, ttlMs: 60_000, healthTtlMs: 300_000 });
    await data.fleet();
    await data.fleet();
    expect(healthCalls).toBe(1);
    expect(a.scans).toHaveLength(1);
    await data.fleet({ maxAgeMs: 0 });
    expect(a.scans).toHaveLength(2);
    expect(healthCalls).toBe(1);
    await data.health({ maxAgeMs: 0 });
    expect(healthCalls).toBe(2);
  });

  test("a throwing health() becomes a failed entry", async () => {
    const a = fake("a", [], {
      health: async () => {
        throw new Error("boom");
      },
    });
    const data = new SignalboxData({ adapters: load(a), tables });
    expect(await data.health()).toEqual([{ name: "a:health", stability: "internal", ok: false, detail: "health() failed (boom)" }]);
  });
});

describe("SignalboxData quick fleet and session watching", () => {
  test("quick passes through to listSessions and reuses the last health reading, however old", async () => {
    const listCalls: unknown[] = [];
    let healthCalls = 0;
    const a = fake("a", [rec({ agent: "a" })], {
      async listSessions(opts) {
        listCalls.push(opts);
        return [{ agent: "a", sessionId: "s1", status: opts?.quick ? "waiting" : "busy", source: "fake" }];
      },
      async health() {
        healthCalls++;
        return [{ name: "a:source", stability: "internal", ok: true, detail: `reading ${healthCalls}` }];
      },
    });
    const data = new SignalboxData({ adapters: load(a), tables, now: () => NOW, healthTtlMs: 0 });
    const full = await data.fleet();
    expect(full.sessions[0]!.status).toBe("busy");
    expect(healthCalls).toBe(1);
    const quick = await data.fleet({}, { quick: true });
    expect(quick.sessions[0]!.status).toBe("waiting");
    expect(quick.health[0]!.detail).toBe("reading 1");
    expect(healthCalls).toBe(1);
    expect(listCalls).toEqual([undefined, { quick: true }]);
  });

  test("watchSessions follows every adapter that can watch, names the agent, and stops them all", () => {
    const listeners = new Map<string, () => void>();
    const stopped: string[] = [];
    const watching = (id: string): Partial<Adapter> => ({
      watchSessions(onChange) {
        listeners.set(id, onChange);
        return () => stopped.push(id);
      },
    });
    const broken: Partial<Adapter> = {
      watchSessions() {
        throw new Error("no watch here");
      },
    };
    const data = new SignalboxData({ adapters: load(fake("a", [], watching("a")), fake("b", []), fake("c", [], broken), fake("d", [], watching("d"))), tables });
    const seen: string[] = [];
    const stop = data.watchSessions((agent) => seen.push(agent));
    listeners.get("d")!();
    listeners.get("a")!();
    expect(seen).toEqual(["d", "a"]);
    stop();
    expect(stopped).toEqual(["a", "d"]);
    stop();
    expect(stopped).toEqual(["a", "d"]);
  });
});

describe("SignalboxData.history", () => {
  const hist = (agent: string, sessionId: string, lastActivityAt: string, over: Partial<HistorySession> = {}): HistorySession => ({
    agent,
    sessionId,
    titleSource: "none",
    startedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt,
    records: [rec({ agent, sessionId })],
    compactions: 0,
    subagentFiles: 0,
    workflowRuns: 0,
    ...over,
  });

  test("merges adapters, prices sessions, takes live flags from the last fleet, and caches within the TTL", async () => {
    let calls = 0;
    const a = fake("a", [], {
      async listSessions() {
        return [{ agent: "a", sessionId: "s1", status: "busy", source: "fake" }];
      },
      async listHistory(opts) {
        calls++;
        expect(opts).toEqual({ since: undefined, until: undefined });
        return [hist("a", "s1", "2026-10-08T00:00:00.000Z", { title: "Alpha", titleSource: "custom" }), hist("a", "s2", "2026-10-06T00:00:00.000Z")];
      },
    });
    const b = fake("b", [], { listHistory: async () => [hist("b", "x", "2026-10-07T00:00:00.000Z")] });
    const plain = fake("c", []); // no listHistory: skipped
    const data = new SignalboxData({ adapters: load(a, b, plain), tables, now: () => NOW });
    await data.fleet();
    const h = await data.history();
    expect(h.entries.map((e) => [e.agent, e.sessionId, e.live])).toEqual([
      ["a", "s1", true],
      ["b", "x", false],
      ["a", "s2", false],
    ]);
    expect(h.entries[0]).toMatchObject({ title: "Alpha", titleSource: "custom", responses: 1 });
    expect(h.entries[0]!.costUsd).toBeCloseTo(4, 9); // 1M input tokens at $4/MTok
    expect(h.generatedAt).toBe(NOW.toISOString());
    await data.history();
    expect(calls).toBe(1);
    await data.history({}, { maxAgeMs: 0 });
    expect(calls).toBe(2);
    const limited = await data.history({ agent: "a", limit: 1 });
    expect(limited).toMatchObject({ total: 2, truncated: true });
    expect(limited.entries.map((e) => e.sessionId)).toEqual(["s1"]);
  });

  test("one failing adapter leaves its sessions out; all failing is an error", async () => {
    const ok = fake("a", [], { listHistory: async () => [hist("a", "s1", "2026-10-08T00:00:00.000Z")] });
    const bad = fake("b", [], {
      listHistory: async () => {
        throw new Error("disk on fire");
      },
    });
    expect((await new SignalboxData({ adapters: load(ok, bad), tables }).history()).entries.map((e) => e.sessionId)).toEqual(["s1"]);
    await expect(new SignalboxData({ adapters: load(bad), tables }).history()).rejects.toThrow("history failed (b: disk on fire)");
    expect((await new SignalboxData({ adapters: load(fake("c", [])), tables }).history()).entries).toEqual([]);
  });
});
