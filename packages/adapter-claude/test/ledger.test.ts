import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClaudeAdapter } from "../src/index.ts";
import { compactionFromLine, ledgerFromCostState } from "../src/ledger.ts";
import { A_MTIME, B_MTIME, makeSandbox, SID_A, SID_B, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

const adapter = () => createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: "/nonexistent" });

describe("readLedger", () => {
  test("uses only the last (cumulative) cost-state row per file", async () => {
    const entries = await adapter().readLedger({});
    expect(entries).toHaveLength(3);
    const a = entries.filter((e) => e.sessionId === SID_A);
    expect(a).toEqual([
      {
        agent: "claude-code",
        sessionId: SID_A,
        model: "claude-opus-5-5",
        tokens: { input: 20, output: 300, cacheRead: 9000, cacheWrite5m: 0, cacheWrite1h: 700, reasoning: 9 },
        webSearchRequests: 2,
        costUsd: 0.9,
        observedAt: A_MTIME.toISOString(),
        source: "cost-state",
      },
      {
        agent: "claude-code",
        sessionId: SID_A,
        model: "claude-haiku-4-5-20251001",
        tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        costUsd: 0.01,
        observedAt: A_MTIME.toISOString(),
        source: "cost-state",
      },
    ]);
    // A model row without costUSD is unknown, not $0: it is skipped.
    expect(entries.some((e) => e.model === "claude-future-model")).toBe(false);
    const b = entries.find((e) => e.sessionId === SID_B)!;
    expect(b).toMatchObject({ model: "claude-opus-4-6", costUsd: 0.2, observedAt: B_MTIME.toISOString() });
    expect(b.tokens.cacheWrite1h).toBe(1000);
  });

  test("since skips files by mtime; until skips sessions that started later", async () => {
    const recent = await adapter().readLedger({ since: new Date("2026-01-08T00:00:00Z") });
    expect(new Set(recent.map((e) => e.sessionId))).toEqual(new Set([SID_A]));
    const old = await adapter().readLedger({ until: new Date("2026-01-06T00:00:00Z") });
    expect(old.map((e) => e.sessionId)).toEqual([SID_B]);
  });

  test("cache writes go to 5m for non-main transcripts", () => {
    const row = { type: "cost-state", modelUsage: { m: { inputTokens: 1, cacheCreationInputTokens: 9, costUSD: 0.1 } } };
    expect(ledgerFromCostState(row, { sessionId: "s", kind: "workflow" })[0]!.tokens).toMatchObject({ cacheWrite5m: 9, cacheWrite1h: 0 });
    expect(ledgerFromCostState(row, { sessionId: "s", kind: "main" })[0]!.tokens).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 9 });
    expect(ledgerFromCostState({ type: "user" }, { sessionId: "s", kind: "main" })).toEqual([]);
  });
});

describe("readCompactions", () => {
  test("reads compact_boundary rows from main transcripts", async () => {
    const ev = await adapter().readCompactions({});
    expect(ev).toEqual([
      { agent: "claude-code", sessionId: SID_B, ts: "2026-01-05T00:10:00.000Z", trigger: "auto", preTokens: 167000 },
      { agent: "claude-code", sessionId: SID_A, ts: "2026-01-10T11:00:00.000Z", trigger: "manual", preTokens: 150000 },
      { agent: "claude-code", sessionId: SID_A, ts: "2026-01-10T11:30:00.000Z", trigger: "unknown" },
    ]);
  });

  test("filters by range", async () => {
    const ev = await adapter().readCompactions({
      since: new Date("2026-01-08T00:00:00Z"),
      until: new Date("2026-01-10T11:15:00Z"),
    });
    expect(ev.map((e) => e.ts)).toEqual(["2026-01-10T11:00:00.000Z"]);
  });

  test("accepts snake_case metadata and rejects other rows", () => {
    const row = { type: "system", subtype: "compact_boundary", timestamp: "2026-01-01T00:00:00Z", compact_metadata: { trigger: "auto", pre_tokens: 5 } };
    expect(compactionFromLine(row, "fallback")).toEqual({ agent: "claude-code", sessionId: "fallback", ts: "2026-01-01T00:00:00.000Z", trigger: "auto", preTokens: 5 });
    expect(compactionFromLine({ type: "system", subtype: "api_error" }, "x")).toBeUndefined();
    expect(compactionFromLine({ type: "system", subtype: "compact_boundary" }, "x")).toBeUndefined();
  });
});
