import { describe, expect, test } from "bun:test";
import { lastUsageChunk, normalizeUsage } from "../src/normalize.ts";
import { parseSessionLog, SessionLogFold } from "../src/session-log.ts";
import { ev, headerLine, MARK } from "./helpers.ts";

const T = 1794218400000; // 2026-11-09T10:00:00Z
const PATH = "/synthetic/sessions/--Users-test-gamma--/folder-name/session.v4.jsonl.zstd";
const parse = (text: string) => parseSessionLog(text, PATH, "folder-name");
const reply = (id: string | undefined, seq: number, time: number, usage: unknown, extra: Record<string, unknown> = {}) =>
  ev("assistant/message", seq, time, {
    message: { ...(id ? { id } : {}), role: "assistant", content: [{ type: "text", text: MARK }], source: { kind: "model", provider: "ollama", model: "kimi-k3.1-pro:cloud" } },
    stream: [],
    turn: 1,
    step: 1,
    ...(usage === undefined ? {} : { usage }),
    ...extra,
  });

describe("normalizeUsage", () => {
  test("the harness's buckets map one to one; input is already the uncached part", () => {
    expect(normalizeUsage({ inputTokens: 38, outputTokens: 9, cacheReadTokens: 7840, totalTokens: 7887 })).toEqual({ input: 38, output: 9, cacheRead: 7840, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, reasoningTokens: 5 })).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite5m: 30, cacheWrite1h: 0, reasoning: 5 });
    expect(normalizeUsage({ outputTokens: 4 })).toEqual({ input: 0, output: 4, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  test("anything that is not a usage object, or has no usable count, is unknown", () => {
    for (const v of [undefined, null, 7, "x", [], {}, { totalTokens: 9 }, { inputTokens: -1, outputTokens: "3" }, { inputTokens: Number.NaN }]) expect(normalizeUsage(v)).toBeUndefined();
  });

  test("lastUsageChunk: the last raw usage chunk of a stream", () => {
    const u = (n: number) => ({ type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: n, outputTokens: 1 } } });
    expect(lastUsageChunk([u(1), { type: "text-chunks", texts: ["x"] }, u(2), { type: "chunk", chunk: { type: "finish" } }])).toEqual({ inputTokens: 2, outputTokens: 1 });
    expect(lastUsageChunk([{ type: "chunk", chunk: { type: "finish" } }])).toBeUndefined();
    expect(lastUsageChunk("nope")).toBeUndefined();
  });
});

describe("parseSessionLog", () => {
  test("the header names the session; without one the folder name stands in", () => {
    const s = parse(headerLine("session-x", { parentSession: "session-parent", origin: "subagent" }) + reply("m1", 0, T, { inputTokens: 5, outputTokens: 1 }));
    expect(s).toMatchObject({ sessionId: "session-x", parentId: "session-parent", kind: "subagent", cwd: "/Users/test/gamma" });
    expect(s.header).toEqual({ id: "session-x", version: 4, cwd: "/Users/test/gamma", createdAt: "2026-11-09T10:00:00.000Z", parentSession: "session-parent", origin: "subagent", seeded: false });
    expect(s.records[0]).toMatchObject({ sessionId: "session-x", kind: "subagent", project: "/Users/test/gamma", sourcePath: PATH });

    const headless = parse(reply("m1", 0, T, { inputTokens: 5, outputTokens: 1 }));
    expect(headless).toMatchObject({ sessionId: "folder-name", kind: "main" });
    expect(headless.records[0]!.sessionId).toBe("folder-name");
    expect(headless.header).toEqual({ seeded: false });
    // A second header line changes nothing; a relative or multi-line working directory is not taken.
    expect(parse(headerLine("first") + headerLine("second")).sessionId).toBe("first");
    expect(parse(headerLine("s", { cwd: "relative/path" })).cwd).toBeUndefined();
  });

  test("content lines are never parsed: a broken one is passed over by its prefix", () => {
    const broken = `{"type":"tool/result","seq":1,"time":${T + 1},"data":{"content":[{"type":"text","text":"${MARK} never closed\n`;
    const s = parse(headerLine("s") + ev("user/message", 0, T, { content: [{ type: "text", text: MARK }] }) + broken + reply("m1", 2, T + 2, { inputTokens: 5, outputTokens: 1 }));
    expect(s.stats).toMatchObject({ lines: 4, skipped: 2, badLines: 0, usageLines: 1, records: 1 });
    expect(s.firstTs).toBe("2026-11-09T10:00:00.000Z");
    expect(s.lastTs).toBe("2026-11-09T10:00:00.002Z");
    expect(JSON.stringify(s)).not.toContain(MARK);
  });

  test("a line in another key order is parsed in full and still counts", () => {
    const odd = `${JSON.stringify({ seq: 0, time: T + 5, type: "assistant/message", data: { message: { id: "m-odd", source: { model: "deepseek-flash" } }, usage: { inputTokens: 7, outputTokens: 2 } } })}\r\n`;
    const s = parse(headerLine("s") + odd + `${JSON.stringify({ seq: 1, time: T + 6, type: "user/message", data: {} })}\n` + "not json at all\n" + "\n   \n");
    expect(s.records.map((r) => [r.id, r.model, r.ts])).toEqual([["m-odd", "deepseek-flash", "2026-11-09T10:00:00.005Z"]]);
    expect(s.stats).toMatchObject({ lines: 4, skipped: 0, badLines: 1 });
  });

  test("usage: no usage, zero usage, a missing id, an interrupted reply", () => {
    const s = parse(
      headerLine("s") +
        ev("request/context", 0, T, { provider: "ollama", model: "kimi-k3.1-pro:cloud", contextWindow: 1048576 }) +
        reply("none", 1, T + 1, undefined, { interrupted: true }) +
        reply("zero", 2, T + 2, { inputTokens: 0, outputTokens: 0 }) +
        reply(undefined, 3, T + 3, { inputTokens: 9, outputTokens: 1 }) +
        reply("cut", 4, T + 4, { inputTokens: 9, outputTokens: 1 }, { interrupted: true }) +
        ev("assistant/attempt", 5, T + 5, { turn: 1, step: 1, stream: [{ type: "chunk", chunk: { type: "finish" } }] }),
    );
    expect(s.records.map((r) => [r.id, r.keyQuality, r.outputFinal])).toEqual([
      ["s:message:3", "request", true],
      ["cut", "id", false],
    ]);
    expect(s.stats).toMatchObject({ usageLines: 5, records: 2, noUsage: 2, zeroUsage: 1 });
    expect(s.context).toEqual({ ts: "2026-11-09T10:00:00.004Z", tokens: 9, window: 1048576 });
  });

  test("a model with no source falls back to the request's model, then to unknown", () => {
    const bare = (seq: number) => ev("assistant/message", seq, T + seq, { message: { id: `b${seq}` }, usage: { inputTokens: 1, outputTokens: 1 } });
    const s = parse(headerLine("s") + bare(0) + ev("model/selection", 1, T + 1, { provider: "anthropic", model: "claude-haiku-5-5", reasoningEffort: "low" }) + bare(2) + ev("model/selection", 3, T + 3, { provider: "x", model: "next-model" }));
    expect(s.records.map((r) => r.model)).toEqual(["unknown", "claude-haiku-5-5"]);
    expect(s).toMatchObject({ model: "next-model", provider: "x" });
    expect(s.effort).toBeUndefined(); // the last selection named none
  });

  test("titles: a rename or a generated title, the last one winning; never the fallback", () => {
    const title = (seq: number, text: unknown, kind: string) => ev("session/title", seq, T + seq, { title: text, messageSeqs: [], source: { kind } });
    expect(parse(headerLine("s") + title(0, `${MARK} prompt words`, "fallback"))).toMatchObject({ titleSource: "none" });
    expect(parse(headerLine("s") + title(0, `${MARK} prompt words`, "fallback")).title).toBeUndefined();
    expect(parse(headerLine("s") + title(0, "Generated", "provider") + title(1, `${MARK} prompt words`, "fallback"))).toMatchObject({ title: "Generated", titleSource: "ai" });
    expect(parse(headerLine("s") + title(0, "Generated", "provider") + title(1, "Mine", "user"))).toMatchObject({ title: "Mine", titleSource: "custom" });
    expect(parse(headerLine("s") + title(0, "Mine", "user") + title(1, "Regenerated", "provider"))).toMatchObject({ title: "Regenerated", titleSource: "ai" });
    // Sanitized like every title: one line, no control characters, at most 120 characters.
    expect(parse(headerLine("s") + title(0, "two\nlines\u0007 here", "user")).title).toBe("two lines here");
    expect(parse(headerLine("s") + title(0, "x".repeat(300), "provider")).title).toHaveLength(120);
    // An unknown source, an empty title and an oversized line are not titles.
    expect(parse(headerLine("s") + title(0, "From elsewhere", "imported") + title(1, "   ", "user") + title(2, 7, "user")).title).toBeUndefined();
    expect(parse(headerLine("s") + title(0, "y".repeat(20_000), "user")).title).toBeUndefined();
  });

  test("turns and approvals", () => {
    const base = headerLine("s") + ev("turn/start", 0, T);
    expect(parse(base)).toMatchObject({ turnOpen: true, pendingApprovals: 0, statusChangedAt: "2026-11-09T10:00:00.000Z" });
    const asked = base + ev("approval/asked", 1, T + 1, { id: "a1", reason: MARK }) + ev("approval/asked", 2, T + 2, { id: "a2", reason: MARK });
    expect(parse(asked)).toMatchObject({ turnOpen: true, pendingApprovals: 2, statusChangedAt: "2026-11-09T10:00:00.002Z" });
    expect(parse(asked + ev("approval/decided", 3, T + 3, { id: "a1", outcome: "allowed-once" }))).toMatchObject({ pendingApprovals: 1 });
    // The turn ending (aborted, say) leaves nothing to approve.
    expect(parse(asked + ev("turn/end", 3, T + 3, { turn: 1, reason: { kind: "aborted" } }))).toMatchObject({ turnOpen: false, pendingApprovals: 0, statusChangedAt: "2026-11-09T10:00:00.003Z" });
    expect(JSON.stringify(parse(asked))).not.toContain(MARK);
  });

  test("a fork: what it inherited belongs to its parent's log", () => {
    const seededHeader = headerLine("fork", { isSeeded: true, parentSession: "session-parent", origin: "subagent" });
    const inherited =
      ev("request/context", 0, T, { provider: "ollama", model: "kimi-k3.1-pro:cloud", contextWindow: 1048576 }) +
      ev("session/title", 1, T + 1, { title: "Parent's title", messageSeqs: [], source: { kind: "provider" } }) +
      ev("tool-workflow/run-start", 2, T + 2, { name: "wf", runId: "r" }) +
      ev("tool-workflow/agent-start", 3, T + 3, { runId: "r", childId: "wf-child" }) +
      reply("parent-1", 4, T + 4, { inputTokens: 100, outputTokens: 10 }) +
      ev("compaction/start", 5, T + 5, { compactionId: "c", turn: 1 }) +
      ev("compaction/end", 6, T + 6, { compactionId: "c", turn: 1 });
    // Until the mark is read, nothing in a seeded log is counted.
    const unmarked = parse(seededHeader + inherited);
    expect(unmarked).toMatchObject({ records: [], compactions: [], workflowRuns: 0, workflowChildIds: [] });
    expect(unmarked.stats.records).toBe(0);

    const own = ev("session/end-seed", 7, T + 6, { inherited: true }) + ev("turn/start", 8, T + 60_000, { turn: 2 }) + reply("fork-1", 9, T + 61_000, { inputTokens: 5, outputTokens: 1 });
    const s = parse(seededHeader + inherited + own);
    expect(s.records.map((r) => r.id)).toEqual(["fork-1"]);
    expect(s).toMatchObject({ compactions: [], workflowRuns: 0, workflowChildIds: [], title: "Parent's title", model: "kimi-k3.1-pro:cloud" });
    expect(s.stats).toMatchObject({ records: 1, inherited: 1 });
    // Its own span starts after the mark, not with the parent's first event.
    expect(s.firstTs).toBe("2026-11-09T10:01:00.000Z");

    // A seed mark that is not an inherited one (a session's starting settings) drops nothing.
    const plain = parse(headerLine("s") + reply("before", 0, T, { inputTokens: 5, outputTokens: 1 }) + ev("session/end-seed", 1, T + 1, {}) + reply("after", 2, T + 2, { inputTokens: 5, outputTokens: 1 }));
    expect(plain.records.map((r) => r.id)).toEqual(["before", "after"]);
  });

  test("compactions: trigger, size, and a context that is unknown until the next response", () => {
    const start = headerLine("s") + ev("request/context", 0, T, { provider: "p", model: "m", contextWindow: 1000 }) + reply("m1", 1, T + 1, { inputTokens: 400, outputTokens: 10, cacheReadTokens: 200 });
    expect(parse(start).context).toEqual({ ts: "2026-11-09T10:00:00.001Z", tokens: 600, window: 1000 });
    const auto = start + ev("compaction/start", 2, T + 2, { compactionId: "c1", turn: 1 }) + ev("compaction/end", 3, T + 3, { compactionId: "c1", turn: 1 });
    expect(parse(auto).compactions).toEqual([{ agent: "deepseek-harness", sessionId: "s", ts: "2026-11-09T10:00:00.003Z", trigger: "auto", preTokens: 600 }]);
    expect(parse(auto).context).toBeUndefined();
    expect(parse(auto + reply("m2", 4, T + 4, { inputTokens: 50, outputTokens: 1 })).context).toMatchObject({ tokens: 50 });
    // Still open, failed, or an end with no start: only a clean end is an event.
    expect(parse(start + ev("compaction/start", 2, T + 2, { compactionId: "c1" })).compactions).toEqual([]);
    expect(parse(start + ev("compaction/start", 2, T + 2, { compactionId: "c1" }) + ev("compaction/end", 3, T + 3, { compactionId: "c1", error: { message: MARK } })).compactions).toEqual([]);
    expect(parse(start + ev("compaction/end", 2, T + 2, { compactionId: "c9" })).compactions).toMatchObject([{ trigger: "unknown", preTokens: 600 }]);
    // Two in a row: the second has no response to size it by.
    const twice = auto + ev("compaction/start", 4, T + 4, { compactionId: "c2", sourceCommandId: "cmd" }) + ev("compaction/end", 5, T + 5, { compactionId: "c2", sourceCommandId: "cmd" });
    expect(parse(twice).compactions[1]).toEqual({ agent: "deepseek-harness", sessionId: "s", ts: "2026-11-09T10:00:00.005Z", trigger: "manual" });
  });

  test("event types this reader has never seen are counted by name; plugin events are not", () => {
    const s = parse(headerLine("s") + ev("future/thing", 0, T) + ev("future/thing", 1, T + 1) + ev("plugin:action-cards/decision", 2, T + 2) + ev("job/registered", 3, T + 3) + `${JSON.stringify({ type: "odd/order", data: {} })}\n`);
    expect(s.stats.unknownTypes).toEqual({ "future/thing": 2, "odd/order": 1 });
    expect(s.stats.skipped).toBe(4);
  });
});

describe("SessionLogFold", () => {
  test("text can arrive in any pieces; a line waits for its newline", () => {
    const text = headerLine("s") + ev("turn/start", 0, T) + reply("m1", 1, T + 1, { inputTokens: 5, outputTokens: 1 }) + ev("turn/end", 2, T + 2, { turn: 1 });
    const whole = parse(text);
    for (const size of [1, 7, 64, 1000]) {
      const fold = new SessionLogFold(PATH, "folder-name");
      for (let i = 0; i < text.length; i += size) fold.pushText(text.slice(i, i + size));
      expect(fold.summary()).toEqual(whole);
    }
    const fold = new SessionLogFold(PATH, "folder-name");
    fold.pushText(text.slice(0, text.length - 1)); // everything but the last newline
    expect(fold.summary().turnOpen).toBe(true);
    fold.pushText("\n");
    expect(fold.summary().turnOpen).toBe(false);
  });

  test("a summary handed out does not change when more lines are folded", () => {
    const fold = new SessionLogFold(PATH, "folder-name");
    fold.pushText(headerLine("s") + reply("m1", 0, T, { inputTokens: 5, outputTokens: 1 }));
    const before = fold.summary();
    fold.pushText(reply("m2", 1, T + 1, { inputTokens: 5, outputTokens: 1 }) + ev("future/x", 2, T + 2));
    expect(before.records.map((r) => r.id)).toEqual(["m1"]);
    expect(before.stats.unknownTypes).toEqual({});
    expect(fold.summary().records.map((r) => r.id)).toEqual(["m1", "m2"]);
  });
});
