import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/index.ts";
import { classify, listTranscripts } from "../src/paths.ts";
import { countsAsResponse } from "../../core/src/index.ts";
import { emptyUsageStats, scanIssues, tokensOf, UsageAccumulator } from "../src/usage.ts";
import { A_SUB, B_MAIN, byId, collect, makeSandbox, SID_A, SID_B, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

const adapter = () => createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: "/nonexistent" });

describe("paths", () => {
  test("classifies main, subagent, workflow; skips journal", () => {
    expect(classify(["x.jsonl"])).toBe("main");
    expect(classify(["sid", "subagents", "agent-1.jsonl"])).toBe("subagent");
    expect(classify(["sid", "subagents", "workflows", "wf_1", "agent-2.jsonl"])).toBe("workflow");
    expect(classify(["sid", "subagents", "workflows", "wf_1", "journal.jsonl"])).toBeNull();
    expect(classify(["sid", "elsewhere", "thing.jsonl"])).toBe("other");
    expect(classify(["sid", "subagents", "agent-1.meta.json"])).toBeNull();
  });

  test("walks the fixture config dir", async () => {
    const files = await listTranscripts(`${sb.configDir}/projects`);
    expect(files.map((f) => [f.kind, f.sessionId])).toEqual([
      ["main", SID_A],
      ["subagent", SID_A],
      ["workflow", SID_A],
      ["main", SID_B],
    ]);
  });
});

describe("tokensOf", () => {
  test("uses the 5m/1h split when present", () => {
    const u = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } };
    expect(tokensOf(u, "workflow")).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite5m: 10, cacheWrite1h: 20 });
  });
  test("falls back to 1h for main and 5m otherwise when the split is missing", () => {
    const u = { cache_creation_input_tokens: 40 };
    expect(tokensOf(u, "main")).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 40 });
    expect(tokensOf(u, "subagent")).toMatchObject({ cacheWrite5m: 40, cacheWrite1h: 0 });
    expect(tokensOf(u, "workflow")).toMatchObject({ cacheWrite5m: 40, cacheWrite1h: 0 });
  });
  test("missing numbers count as 0 and junk is ignored", () => {
    expect(tokensOf({ input_tokens: "12", output_tokens: -4 }, "main")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  });
  test("fractional and absurd counts count as 0 instead of becoming Infinity", () => {
    expect(tokensOf({ input_tokens: 1e308, output_tokens: 1.5, cache_read_input_tokens: 7 }, "main")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 7,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });
});

describe("UsageAccumulator", () => {
  const file = { path: "/synthetic/s.jsonl", kind: "main" as const, sessionId: "sid-1" };
  const line = (ts: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", sessionId: "sid-1", timestamp: ts, message: { model: "claude-opus-5-5", usage, ...extra } });

  test("lines of one streamed response without ids merge into one hash-keyed response", () => {
    const stats = emptyUsageStats();
    const acc = new UsageAccumulator(file, stats);
    acc.addLine(line("2026-01-10T10:00:00.000Z", { input_tokens: 5, cache_read_input_tokens: 100_000, output_tokens: 8 }));
    acc.addLine(line("2026-01-10T10:00:01.000Z", { input_tokens: 5, cache_read_input_tokens: 100_000, output_tokens: 300 }, { stop_reason: "end_turn" }));
    // Same prompt counts again half an hour later: a separate response.
    acc.addLine(line("2026-01-10T10:30:00.000Z", { input_tokens: 5, cache_read_input_tokens: 100_000, output_tokens: 9 }));
    const recs = acc.responses().flatMap((r) => r.records);
    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((r) => r.id)).size).toBe(2);
    expect(recs[0]).toMatchObject({ keyQuality: "hash", ts: "2026-01-10T10:00:00.000Z", outputFinal: true, tokens: { cacheRead: 100_000, output: 300 } });
    expect(recs[1]).toMatchObject({ keyQuality: "hash", ts: "2026-01-10T10:30:00.000Z", outputFinal: false, tokens: { output: 9 } });
    expect(stats.hashKeys).toBe(2);
  });

  test("invalid token counts are counted and reported", () => {
    const stats = emptyUsageStats();
    const acc = new UsageAccumulator(file, stats);
    acc.addLine(line("2026-01-10T10:00:00.000Z", { input_tokens: 1e308, output_tokens: 10 }, { id: "msg_x" }));
    expect(acc.responses()[0]!.records[0]!.tokens).toMatchObject({ input: 0, output: 10 });
    expect(stats.invalidCounts).toBe(1);
    expect(scanIssues(stats)).toEqual([
      "1 response line has a token count that is not a plausible whole number; those counts are taken as 0",
    ]);
    expect(scanIssues(emptyUsageStats())).toEqual([]);
    expect(scanIssues({ ...emptyUsageStats(), readErrors: 2, parseErrors: 1 })).toEqual([
      "2 transcripts could not be read (e.g. permission denied), so their usage is missing",
      "1 transcript line could not be parsed (truncated, corrupted or still being written), so any usage on it is missing",
    ]);
  });
});

describe("scanUsage", () => {
  test("dedups streamed lines and applies every rule", async () => {
    const a = adapter();
    const recs = await collect(a.scanUsage({}));
    const m = byId(recs);
    expect([...m.keys()].sort()).toEqual(
      [
        "msg_A1",
        "msg_A2",
        "req:req_A3",
        "msg_A5",
        "msg_A6#iter0",
        "msg_A6#iter1",
        "msg_A7",
        "msg_A8",
        "msg_side",
        "msg_S1",
        "msg_W1",
        "msg_B1",
        "msg_B2",
        ...recs.filter((r) => r.keyQuality === "hash").map((r) => r.id),
      ].sort(),
    );
    expect(recs).toHaveLength(15);
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length);

    // Three lines → one response; output = max; final because one line has stop_reason; ts = first line.
    expect(m.get("msg_A1")).toEqual({
      agent: "claude-code",
      id: "msg_A1",
      keyQuality: "id",
      sessionId: SID_A,
      project: "/Users/test/alpha",
      kind: "main",
      model: "claude-opus-5-5",
      ts: "2026-01-10T10:00:00.000Z",
      tokens: { input: 6, output: 120, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 400 },
      outputFinal: true,
      webSearchRequests: 0,
      geo: "not_available",
      sourcePath: expect.stringContaining(`${SID_A}.jsonl`),
    });

    // Placeholder output, no split (main → 1h), geo/speed/web search/thinking passed through.
    const a2 = m.get("msg_A2")!;
    expect(a2.outputFinal).toBe(false);
    expect(a2.tokens).toEqual({ input: 10, output: 8, cacheRead: 2000, cacheWrite5m: 0, cacheWrite1h: 300, reasoning: 5 });
    expect(a2.geo).toBe("us");
    expect(a2.speed).toBe("fast");
    expect(a2.webSearchRequests).toBe(2);

    // Key fallbacks.
    expect(m.get("req:req_A3")!.keyQuality).toBe("request");
    const hashed = recs.filter((r) => r.keyQuality === "hash");
    expect(hashed).toHaveLength(2);
    expect(hashed.every((r) => r.id.startsWith("hash:"))).toBe(true);

    // iterations[]: a single null-model iteration is not added on top...
    expect(m.get("msg_A5")!.tokens).toEqual({ input: 4, output: 40, cacheRead: 4000, cacheWrite5m: 0, cacheWrite1h: 100 });
    // ...two iterations are priced per iteration, each by its own model.
    expect(m.get("msg_A6#iter0")).toMatchObject({ model: "claude-opus-5-5", tokens: { input: 5, output: 60, cacheRead: 5000, cacheWrite1h: 200 } });
    expect(m.get("msg_A6#iter1")).toMatchObject({ model: "claude-haiku-5-5", tokens: { input: 2, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    expect(m.has("msg_A6")).toBe(false);

    // Partial split: remainder follows the kind fallback.
    expect(m.get("msg_A7")!.tokens).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 50 });

    // Kinds from the path; subagent without split → 5m; workflow uses its split.
    expect(m.get("msg_S1")).toMatchObject({ kind: "subagent", model: "claude-sonnet-5-5", outputFinal: false, sessionId: SID_A });
    expect(m.get("msg_S1")!.tokens).toEqual({ input: 3, output: 8, cacheRead: 800, cacheWrite5m: 600, cacheWrite1h: 0 });
    expect(m.get("msg_W1")).toMatchObject({ kind: "workflow", outputFinal: true, tokens: { output: 64, cacheWrite5m: 2000, cacheWrite1h: 0 } });

    // Dropped rows: <synthetic>, the journal, the cross-file duplicate, the partial last line.
    expect(recs.some((r) => r.model === "<synthetic>")).toBe(false);
    expect(m.has("msg_J1")).toBe(false);
    expect(recs.filter((r) => r.id === "msg_A1")).toHaveLength(1);
    expect(m.get("msg_A1")!.kind).toBe("main");
    expect(m.has("msg_partial")).toBe(false);

    // 15 records from 14 API responses: msg_A6 is split per iteration but counts once.
    expect(recs.filter(countsAsResponse)).toHaveLength(14);
    expect(m.get("msg_A6#iter1")!.flags).toContain("split-continuation");
    expect(m.get("msg_A6#iter0")!.flags).not.toContain("split-continuation");
    expect(a.lastScanStats()).toMatchObject({
      files: 4,
      responses: 14,
      requestKeys: 1,
      hashKeys: 2,
      inputMismatches: 0,
      crossFileDuplicates: 1,
      iterationSplits: 1,
      syntheticDropped: 1,
      parseErrors: 1,
    });
  });

  test("project is the line's cwd", async () => {
    const recs = await collect(adapter().scanUsage({}));
    expect(byId(recs).get("msg_B1")!.project).toBe("/Users/test/beta");
  });

  test("since skips files by mtime, like cc_cost.py", async () => {
    const recs = await collect(adapter().scanUsage({ since: new Date("2026-01-08T00:00:00Z") }));
    expect(recs).toHaveLength(13);
    // msg_B2's timestamp is in range, but its file was last modified before `since`.
    expect(recs.some((r) => r.sessionId === SID_B)).toBe(false);
  });

  test("since/until filter on the response timestamp, half-open [since, until)", async () => {
    const recs = await collect(
      adapter().scanUsage({ since: new Date("2026-01-10T10:05:00.000Z"), until: new Date("2026-01-10T10:20:00.000Z") }),
    );
    // msg_W1 is stamped exactly 10:20:00, so the exclusive `until` drops it.
    expect(recs.map((r) => r.id).sort()).toEqual(["msg_A5", "msg_A6#iter0", "msg_A6#iter1", "msg_A7", "msg_S1"]);
    expect(recs.filter((r) => r.flags?.includes("iteration-split")).map((r) => r.id).sort()).toEqual(["msg_A6#iter0", "msg_A6#iter1"]);
  });

  test("wholeSessions yields every record of sessions touched since `since`", async () => {
    const opts = { since: new Date("2026-01-10T10:05:00.000Z"), until: new Date("2026-01-10T10:20:00.000Z") };
    const ranged = await collect(adapter().scanUsage(opts));
    const whole = await collect(adapter().scanUsage({ ...opts, wholeSessions: true }));
    // Session A's file was touched after `since`, so all of its records come back, in range or not.
    expect(whole.length).toBeGreaterThan(ranged.length);
    expect(new Set(whole.map((r) => r.sessionId))).toEqual(new Set([SID_A]));
    for (const r of ranged) expect(whole.some((w) => w.id === r.id)).toBe(true);
    const all = await collect(adapter().scanUsage({}));
    expect(whole.length).toBe(all.filter((r) => r.sessionId === SID_A).length);
  });

  test("until alone keeps old files", async () => {
    const recs = await collect(adapter().scanUsage({ until: new Date("2026-01-06T00:00:00Z") }));
    expect(recs.map((r) => r.id)).toEqual(["msg_B1"]);
  });

  test("an unreadable transcript is skipped and counted, not thrown", async () => {
    const extra = makeSandbox();
    try {
      const dir = join(extra.configDir, "projects", "-Users-test-locked");
      mkdirSync(dir);
      const path = join(dir, "66666666-6666-4666-8666-666666666666.jsonl");
      writeFileSync(path, "{}\n");
      chmodSync(path, 0o000);
      const a = createClaudeAdapter({ configDir: extra.configDir, spoolDir: extra.spoolDir, claudeBin: "/nonexistent" });
      expect(await collect(a.scanUsage({}))).toHaveLength(15);
      expect(a.lastScanStats()!.readErrors).toBe(1);
    } finally {
      extra.cleanup();
    }
  });

  test("a later scan re-reads only the transcripts that changed", async () => {
    const extra = makeSandbox();
    try {
      const a = createClaudeAdapter({ configDir: extra.configDir, spoolDir: extra.spoolDir, claudeBin: "/nonexistent" });
      const first = await collect(a.scanUsage({}));
      const firstStats = a.lastScanStats();
      // An unchanged file is served from the cache: making it unreadable (mtime and size stay) changes nothing.
      chmodSync(join(extra.configDir, A_SUB), 0o000);
      expect((await collect(a.scanUsage({}))).map((r) => r.id)).toEqual(first.map((r) => r.id));
      expect(a.lastScanStats()).toEqual(firstStats);
      // Cached files are still filtered per call, like a fresh read.
      const opts = { since: new Date("2026-01-10T10:05:00.000Z"), until: new Date("2026-01-10T10:20:00.000Z") };
      const fresh = createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: "/nonexistent" });
      expect((await collect(a.scanUsage(opts))).map((r) => r.id).sort()).toEqual((await collect(fresh.scanUsage(opts))).map((r) => r.id).sort());
      // A file that grew is read again.
      const line = {
        type: "assistant",
        sessionId: SID_B,
        cwd: "/Users/test/beta",
        timestamp: "2026-01-10T12:00:00.000Z",
        message: { id: "msg_B_new", model: "claude-opus-4-6", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } },
      };
      appendFileSync(join(extra.configDir, B_MAIN), `${JSON.stringify(line)}\n`);
      const after = await collect(a.scanUsage({}));
      expect(after).toHaveLength(first.length + 1);
      expect(byId(after).get("msg_B_new")?.tokens).toMatchObject({ input: 1, output: 2 });
      expect(a.lastScanStats()!.readErrors).toBe(0);
    } finally {
      chmodSync(join(extra.configDir, A_SUB), 0o644);
      extra.cleanup();
    }
  });

  test("missing config dir yields nothing", async () => {
    const a = createClaudeAdapter({ configDir: `${sb.root}/missing`, spoolDir: sb.spoolDir });
    expect(await collect(a.scanUsage({}))).toEqual([]);
    expect(await a.detect()).toBe(false);
    expect(await adapter().detect()).toBe(true);
  });
});
