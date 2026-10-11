import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRollout } from "../src/rollout.ts";
import { FIXTURES, IDS, MARK, PATHS } from "./helpers.ts";

const read = (rel: string) => readFileSync(join(FIXTURES, "codex-home", rel), "utf8");

describe("parseRollout: current writer (token_usage_record)", () => {
  const s = parseRollout(read(PATHS.A), "/fixture/A.jsonl");

  test("one record per response_id, compaction call included, repeated token_count ignored", () => {
    expect(s.records.map((r) => r.id)).toEqual(["resp_A1", "resp_A2", "resp_A3", "resp_A4"]);
    expect(s.records.every((r) => r.keyQuality === "id" && r.outputFinal && r.kind === "main" && r.sessionId === IDS.A)).toBe(true);
    expect(s.stats.usageRecords).toBe(4);
    expect(s.stats.legacyRecords).toBe(0);
  });

  test("tokens, model per turn, project, speed and web searches", () => {
    const [a1, a2, a3, a4] = s.records;
    expect(a1).toMatchObject({
      model: "gpt-6-sol",
      project: "/synthetic/project-a",
      speed: "fast",
      webSearchRequests: 1,
      ts: "2026-10-09T10:00:05.000Z",
      tokens: { input: 300, output: 200, cacheRead: 600, cacheWrite5m: 100, cacheWrite1h: 0, reasoning: 50 },
    });
    expect(a2?.webSearchRequests).toBe(0);
    expect(a2?.tokens).toEqual({ input: 500, output: 100, cacheRead: 1500, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 });
    expect(a3?.model).toBe("gpt-6-sol");
    expect(a4).toMatchObject({ model: "gpt-6-astra", project: "/synthetic/project-a/sub" });
  });

  test("message content is skipped without being stored", () => {
    expect(JSON.stringify(s)).not.toContain(MARK);
    expect(s.stats.skipped).toBeGreaterThanOrEqual(3);
  });

  test("context comes from the last token_count after the compaction; compaction carries preTokens", () => {
    expect(s.context).toEqual({ ts: "2026-10-09T10:31:30.100Z", tokens: 40000, window: 258400 });
    expect(s.compactions).toEqual([{ agent: "codex", sessionId: IDS.A, ts: "2026-10-09T10:30:00.100Z", trigger: "unknown", preTokens: 5000 }]);
  });

  test("latest reading per limit kind within the file", () => {
    const byKind = Object.fromEntries(s.limits.map((l) => [l.kind, l]));
    expect(Object.keys(byKind).sort()).toEqual(["codex.primary", "codex.secondary"]);
    expect(byKind["codex.primary"]).toEqual({
      agent: "codex",
      kind: "codex.primary",
      label: "5-hour",
      usedPercent: 13,
      resetsAt: "2026-10-09T14:00:00.000Z",
      windowMinutes: 300,
      observedAt: "2026-10-09T10:31:30.100Z",
      plan: "plus",
      sessionId: IDS.A,
      source: "rollout:token_count",
    });
    expect(byKind["codex.secondary"]).toMatchObject({ label: "Weekly", usedPercent: 4, windowMinutes: 10080 });
  });

  test("turn state and metadata", () => {
    expect(s.turnOpen).toBe(false);
    expect(s.turnChangedAt).toBe("2026-10-09T10:32:00.000Z");
    expect(s.lastTurn).toEqual({ model: "gpt-6-astra", effort: "high", cwd: "/synthetic/project-a/sub" });
    expect(s.meta).toMatchObject({ threadId: IDS.A, originator: "codex_cli_rs", cliVersion: "0.200.0", cwd: "/synthetic/project-a" });
  });
});

describe("parseRollout: other shapes", () => {
  test("guardian subagent: auxiliary kind, root session id", () => {
    const s = parseRollout(read(PATHS.B), "/fixture/B.jsonl");
    expect(s.kind).toBe("auxiliary");
    expect(s.threadId).toBe(IDS.B);
    expect(s.sessionId).toBe(IDS.A);
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ id: "resp_B1", sessionId: IDS.A, model: "codex-auto-review", kind: "auxiliary" });
  });

  test("weekly bucket in the primary slot gets its own kind, labelled with the model", () => {
    const s = parseRollout(read(PATHS.C), "/fixture/C.jsonl");
    expect(s.limits).toHaveLength(1);
    expect(s.limits[0]).toMatchObject({ kind: "codex.primary.10080m", label: "Weekly (gpt-reserve)", usedPercent: 5, windowMinutes: 10080 });
    expect(s.turnOpen).toBe(true);
    expect(s.stats.unknownTypes).toEqual({ future_thing: 1 });
    expect(s.stats.badLines).toBe(1);
  });

  test("legacy writer: usage rebuilt from token_count, repeats and info-less events skipped", () => {
    const s = parseRollout(read(PATHS.D), "/fixture/D.jsonl");
    expect(s.records.map((r) => r.id)).toEqual([`${IDS.D}:tc:4300`, `${IDS.D}:tc:10500`]);
    expect(s.records.every((r) => r.keyQuality === "hash" && r.model === "gpt-5.3-codex")).toBe(true);
    expect(s.records[1]?.tokens).toEqual({ input: 2000, output: 200, cacheRead: 4000, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 });
    expect(s.stats.legacyRecords).toBe(2);
  });

  test("token_count after the first token_usage_record never adds usage", () => {
    const u = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 };
    const lines = [
      { timestamp: "2026-10-01T00:00:00Z", type: "token_usage_record", payload: { response_id: "resp_x", usage: u } },
      { timestamp: "2026-10-01T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: u, last_token_usage: u } } },
      { timestamp: "2026-10-01T00:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...u, total_tokens: 22 }, last_token_usage: u } } },
    ];
    const s = parseRollout(lines.map((l) => JSON.stringify(l)).join("\n"), "/x.jsonl", "fallback-thread");
    expect(s.records.map((r) => r.id)).toEqual(["resp_x"]);
    expect(s.threadId).toBe("fallback-thread");
    expect(s.records[0]?.model).toBe("unknown");
  });

  test("a compaction after the last token_count leaves context unknown", () => {
    const u = { input_tokens: 900, output_tokens: 10, total_tokens: 910 };
    const lines = [
      { timestamp: "2026-10-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: u, last_token_usage: u, model_context_window: 1000 } } },
      { timestamp: "2026-10-01T00:00:01Z", type: "compacted", payload: { message: "x" } },
    ];
    const s = parseRollout(lines.map((l) => JSON.stringify(l)).join("\n"), "/x.jsonl");
    expect(s.context).toBeUndefined();
    expect(s.compactions).toHaveLength(1);
    expect(s.compactions[0]?.preTokens).toBeUndefined();
  });

  test("zero-usage records and duplicate response ids inside one file are dropped", () => {
    const z = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const u = { input_tokens: 5, output_tokens: 1, total_tokens: 6 };
    const lines = [
      { timestamp: "2026-10-01T00:00:00Z", type: "token_usage_record", payload: { response_id: "resp_z", usage: z } },
      { timestamp: "2026-10-01T00:00:01Z", type: "token_usage_record", payload: { response_id: "resp_u", usage: u } },
      { timestamp: "2026-10-01T00:00:02Z", type: "token_usage_record", payload: { response_id: "resp_u", usage: u } },
      { timestamp: "2026-10-01T00:00:03Z", type: "token_usage_record", payload: { usage: u } },
    ];
    const s = parseRollout(lines.map((l) => JSON.stringify(l)).join("\n"), "/x.jsonl", "t");
    expect(s.records.map((r) => [r.id, r.keyQuality])).toEqual([
      ["resp_u", "id"],
      ["t:h:2026-10-01T00:00:03Z::5/0/0/1", "hash"],
    ]);
    expect(s.stats.zeroUsage).toBe(1);
  });
});
