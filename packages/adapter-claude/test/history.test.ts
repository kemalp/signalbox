// listHistory: titles from custom-title / ai-title / agent-name lines only, metadata from line fields, usage
// shared with scanUsage. Synthetic transcripts only; every line that carries text a user or model wrote holds a
// canary that must never reach the output.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHistory, embeddedPriceTables, type HistorySession } from "../../core/src/index.ts";
import { createClaudeAdapter } from "../src/index.ts";
import { listTranscripts } from "../src/paths.ts";
import { pathField, rawTimestamp } from "../src/transcript.ts";
import { collect, makeSandbox, SID_A, SID_B, type Sandbox } from "./helpers.ts";

const CANARY = "CANARY_SECRET";
const SID_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_AI = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SID_AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SID_CLEARED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SID_BARE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SID_ORPHAN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SID_EMPTY = "abababab-abab-4bab-8bab-abababababab";
const CWD = "/Users/test/history";
const CWD_EMPTY = "/Users/test/opened and closed";
const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;
const MTIME = new Date(T0 + 60 * MIN);
const BEL = String.fromCharCode(7);

let sb: Sandbox;
let proj: string;

function assistant(id: string, msAgo: number, extra: Record<string, unknown> = {}, sessionId = SID_T) {
  return {
    parentUuid: null,
    isSidechain: false,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: `${CANARY} model text` },
        // A nested object shaped like a title line: never a title.
        { type: "tool_use", id: "toolu_1", name: "Write", input: { type: "custom-title", customTitle: `${CANARY} nested` } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    },
    requestId: `req_${id}`,
    type: "assistant",
    uuid: `u-${id}`,
    timestamp: iso(msAgo),
    userType: "external",
    entrypoint: "claude-desktop",
    cwd: CWD,
    sessionId,
    version: "2.1.293",
    gitBranch: "feature/history",
    ...extra,
  };
}

const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

beforeAll(() => {
  sb = makeSandbox();
  proj = join(sb.configDir, "projects", "-Users-test-history");
  mkdirSync(join(proj, SID_T, "subagents", "workflows", "wf_one"), { recursive: true });
  mkdirSync(join(proj, SID_T, "subagents", "workflows", "wf_two"), { recursive: true });
  mkdirSync(join(proj, SID_ORPHAN, "subagents"), { recursive: true });
  writeFileSync(
    join(proj, `${SID_T}.jsonl`),
    lines([
      { type: "queue-operation", operation: "enqueue", timestamp: iso(0), sessionId: SID_T, content: `${CANARY} queued prompt` },
      { parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: `${CANARY} the prompt` }, uuid: "u1", timestamp: iso(1000), cwd: CWD, sessionId: SID_T },
      { type: "custom-title", customTitle: "First title", sessionId: SID_T },
      assistant("msg_HT1", 10_000),
      { parentUuid: "u1", type: "attachment", attachment: { type: "file", content: `${CANARY} attached` }, uuid: "u2", timestamp: iso(20_000), sessionId: SID_T },
      { type: "last-prompt", lastPrompt: `${CANARY} last prompt`, leafUuid: "u2", sessionId: SID_T },
      { type: "summary", summary: `${CANARY} summary`, leafUuid: "u2" },
      { type: "ai-title", aiTitle: "Generated title", sessionId: SID_T },
      { type: "agent-name", agentName: "agent-x", sessionId: SID_T },
      // Prompt text that quotes a title line is escaped inside a string, and a small line whose nested object
      // looks like one is parsed but not top-level: neither is a title.
      { type: "user", message: { role: "user", content: `{"type":"custom-title","customTitle":"${CANARY} quoted"}` }, timestamp: iso(21_000), sessionId: SID_T },
      { type: "user", message: { role: "user", content: "ok" }, toolUseResult: { type: "custom-title", customTitle: `${CANARY} result` }, timestamp: iso(22_000), sessionId: SID_T },
      // Too long to be parsed for a title at all.
      { type: "user", toolUseResult: { type: "custom-title", customTitle: `${CANARY} huge` }, padding: "x".repeat(20_000), timestamp: iso(23_000), sessionId: SID_T },
      { type: "custom-title", customTitle: `  Final\ntitle${BEL} with\tcontrol  `, sessionId: SID_T },
      { type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: iso(30 * MIN), sessionId: SID_T, compactMetadata: { trigger: "auto", preTokens: 900_000 } },
      assistant("msg_HT2", 40 * MIN, { gitBranch: "main", entrypoint: "cli", version: "2.1.300" }),
      // A timestamp later than the file's mtime (plus slack) is not activity.
      { type: "progress", data: { note: `${CANARY} progress` }, timestamp: "2099-01-01T00:00:00.000Z", sessionId: SID_T },
      { type: "cost-state", sessionId: SID_T, modelUsage: { "claude-opus-5-5": { inputTokens: 400, outputTokens: 200, cacheReadInputTokens: 4000, cacheCreationInputTokens: 800, costUSD: 0.5 } } },
    ]),
  );
  writeFileSync(join(proj, SID_T, "subagents", "agent-s1.jsonl"), lines([assistant("msg_HS1", 50 * MIN, { isSidechain: true, agentId: "s1" })]));
  writeFileSync(join(proj, SID_T, "subagents", "workflows", "wf_one", "agent-w1.jsonl"), lines([assistant("msg_HW1", 15 * MIN, { isSidechain: true })]));
  writeFileSync(join(proj, SID_T, "subagents", "workflows", "wf_one", "journal.jsonl"), lines([{ type: "note", text: CANARY }]));
  writeFileSync(join(proj, SID_T, "subagents", "workflows", "wf_two", "agent-w2.jsonl"), lines([assistant("msg_HW2", 16 * MIN, { isSidechain: true })]));
  writeFileSync(
    join(proj, `${SID_AI}.jsonl`),
    lines([
      { type: "ai-title", aiTitle: "AI only", sessionId: SID_AI },
      { type: "agent-name", agentName: "agent-y", sessionId: SID_AI },
      assistant("msg_AI1", 5 * MIN, {}, SID_AI),
    ]),
  );
  writeFileSync(join(proj, `${SID_AGENT}.jsonl`), lines([{ type: "agent-name", agentName: "agent-z", sessionId: SID_AGENT }, assistant("msg_AG1", 6 * MIN, {}, SID_AGENT)]));
  writeFileSync(
    join(proj, `${SID_CLEARED}.jsonl`),
    lines([
      { type: "custom-title", customTitle: "Old custom", sessionId: SID_CLEARED },
      { type: "ai-title", aiTitle: "AI fallback", sessionId: SID_CLEARED },
      assistant("msg_CL1", 7 * MIN, {}, SID_CLEARED),
      { type: "custom-title", customTitle: "   ", sessionId: SID_CLEARED },
    ]),
  );
  // Only a title line: no timestamp anywhere, so the file's mtime stands in.
  writeFileSync(join(proj, `${SID_BARE}.jsonl`), lines([{ type: "custom-title", customTitle: "Bare", sessionId: SID_BARE }]));
  // Opened and closed with nothing sent: no response, so the project comes from the first line's top-level cwd,
  // not from the nested one that comes before it in the line.
  writeFileSync(
    join(proj, `${SID_EMPTY}.jsonl`),
    lines([
      { type: "queue-operation", operation: "enqueue", timestamp: iso(2 * MIN), sessionId: SID_EMPTY, content: `${CANARY} queued` },
      { type: "user", message: { role: "user", content: `${CANARY} prompt` }, toolUseResult: { cwd: "/nested/elsewhere" }, cwd: CWD_EMPTY, timestamp: iso(3 * MIN), sessionId: SID_EMPTY },
      { type: "system", subtype: "api_error", cwd: "/later/cwd", timestamp: iso(4 * MIN), sessionId: SID_EMPTY },
      { type: "last-prompt", lastPrompt: `${CANARY} last`, sessionId: SID_EMPTY },
    ]),
  );
  // Subagent files without a main transcript: not a session of their own.
  writeFileSync(join(proj, SID_ORPHAN, "subagents", "agent-o.jsonl"), lines([assistant("msg_O1", 8 * MIN, { isSidechain: true }, SID_ORPHAN)]));
  for (const f of [
    `${SID_T}.jsonl`,
    `${SID_T}/subagents/agent-s1.jsonl`,
    `${SID_T}/subagents/workflows/wf_one/agent-w1.jsonl`,
    `${SID_T}/subagents/workflows/wf_one/journal.jsonl`,
    `${SID_T}/subagents/workflows/wf_two/agent-w2.jsonl`,
    `${SID_AI}.jsonl`,
    `${SID_AGENT}.jsonl`,
    `${SID_CLEARED}.jsonl`,
    `${SID_BARE}.jsonl`,
    `${SID_EMPTY}.jsonl`,
    `${SID_ORPHAN}/subagents/agent-o.jsonl`,
  ]) {
    utimesSync(join(proj, f), MTIME, MTIME);
  }
});
afterAll(() => sb.cleanup());

const adapter = () => createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: "/nonexistent" });
const byId = (list: HistorySession[]) => new Map(list.map((s) => [s.sessionId, s]));

describe("listHistory", () => {
  test("one entry per main transcript, with titles in priority order and the last custom title winning", async () => {
    const h = byId(await adapter().listHistory());
    expect([...h.keys()].sort()).toEqual([SID_A, SID_B, SID_T, SID_AI, SID_AGENT, SID_CLEARED, SID_BARE, SID_EMPTY].sort());
    expect(h.get(SID_T)).toMatchObject({ title: "Final title with control", titleSource: "custom" });
    expect(h.get(SID_AI)).toMatchObject({ title: "AI only", titleSource: "ai" });
    expect(h.get(SID_AGENT)).toMatchObject({ title: "agent-z", titleSource: "agent-name" });
    // A last custom-title line that is blank clears the custom title.
    expect(h.get(SID_CLEARED)).toMatchObject({ title: "AI fallback", titleSource: "ai" });
    expect(h.get(SID_A)!.titleSource).toBe("none");
    expect(h.get(SID_A)!.title).toBeUndefined();
  });

  test("no prompt, message, summary, attachment, queue or tool text reaches the output", async () => {
    const list = await adapter().listHistory();
    expect(JSON.stringify(list)).not.toContain(CANARY);
    const snap = buildHistory({ sessions: list, tables: embeddedPriceTables() });
    expect(JSON.stringify(snap)).not.toContain(CANARY);
  });

  test("times span every file of the session; metadata comes from line fields", async () => {
    const t = byId(await adapter().listHistory()).get(SID_T)!;
    expect(t.startedAt).toBe(iso(0)); // the queue-operation line
    expect(t.lastActivityAt).toBe(iso(50 * MIN)); // the subagent's response, after the main transcript's last line
    expect(t).toMatchObject({
      project: CWD,
      gitBranch: "main",
      entrypoint: "cli",
      version: "2.1.300",
      compactions: 1,
      subagentFiles: 1,
      workflowRuns: 2,
      resume: { command: `claude --resume ${SID_T}`, cwd: CWD },
    });
    expect(t.transcriptPath).toBe(join(proj, `${SID_T}.jsonl`));
    expect(t.ledger?.map((e) => [e.model, e.costUsd])).toEqual([["claude-opus-5-5", 0.5]]);
    const bare = byId(await adapter().listHistory()).get(SID_BARE)!;
    expect(bare.startedAt).toBe(MTIME.toISOString());
    expect(bare.lastActivityAt).toBe(MTIME.toISOString());
    expect(bare.records).toEqual([]);
    expect(bare.resume).toEqual({ command: `claude --resume ${SID_BARE}` });
  });

  test("a session with no response takes its project from its first line's top-level cwd", async () => {
    const e = byId(await adapter().listHistory()).get(SID_EMPTY)!;
    expect(e).toMatchObject({ titleSource: "none", project: CWD_EMPTY, records: [], resume: { command: `claude --resume ${SID_EMPTY}`, cwd: CWD_EMPTY } });
    expect(e.startedAt).toBe(iso(2 * MIN));
    expect(e.lastActivityAt).toBe(iso(4 * MIN));
    expect(JSON.stringify(e)).not.toContain(CANARY);
    // Responses still decide the project when there are any (SID_T's first line has the same cwd; SID_AI has none).
    expect(byId(await adapter().listHistory()).get(SID_AI)!.project).toBe(CWD);
  });

  test("records are exactly scanUsage's, grouped by session", async () => {
    const a = adapter();
    const scanned = await collect(a.scanUsage({}));
    const hist = await a.listHistory();
    const fromHistory = hist.flatMap((s) => s.records.map((r) => r.id)).sort();
    // scanUsage also counts the orphaned subagent file, which belongs to no listed session.
    expect(fromHistory).toEqual(scanned.filter((r) => r.sessionId !== SID_ORPHAN).map((r) => r.id).sort());
    expect(byId(hist).get(SID_T)!.records.map((r) => r.id).sort()).toEqual(["msg_HS1", "msg_HT1", "msg_HT2", "msg_HW1", "msg_HW2"]);
  });

  test("reuses the transcript cache: after a scan, unreadable (unchanged) files change nothing", async () => {
    const a = adapter();
    await collect(a.scanUsage({}));
    const before = await a.listHistory();
    const files = await listTranscripts(join(sb.configDir, "projects"));
    try {
      for (const f of files) chmodSync(f.path, 0o000);
      expect(await a.listHistory()).toEqual(before);
      expect(await a.readLedger({})).toHaveLength(4);
      expect((await a.readCompactions({})).length).toBe(4);
    } finally {
      for (const f of files) chmodSync(f.path, 0o644);
    }
  });

  test("health says how many sessions the last history titled, by source", async () => {
    const a = adapter();
    expect((await a.health()).find((x) => x.name === "claude-code:titles")!.detail).toContain("read on demand");
    await a.listHistory();
    const row = (await a.health()).find((x) => x.name === "claude-code:titles")!;
    expect(row).toMatchObject({ stability: "internal", ok: true, detail: "last history: 5 of 8 sessions titled (custom-title 2, ai-title 2, agent-name 1)" });
  });

  test("since keeps sessions with any file written since then", async () => {
    const recent = await adapter().listHistory({ since: new Date("2026-02-01T00:00:00Z") });
    expect(recent.map((s) => s.sessionId).sort()).toEqual([SID_T, SID_AI, SID_AGENT, SID_CLEARED, SID_BARE, SID_EMPTY].sort());
  });
});

describe("pathField", () => {
  test("an absolute path on one line, else nothing", () => {
    expect(pathField("/Users/me/code/app")).toBe("/Users/me/code/app");
    expect(pathField("C:\\Users\\me")).toBe("C:\\Users\\me");
    expect(pathField("relative/dir")).toBeUndefined();
    expect(pathField("/two\nlines")).toBeUndefined();
    expect(pathField("")).toBeUndefined();
    expect(pathField(42)).toBeUndefined();
  });
});

describe("rawTimestamp", () => {
  test("the last timestamp key of a line, or nothing", () => {
    expect(rawTimestamp('{"data":{"timestamp":"2020-01-01T00:00:00Z"},"timestamp":"2026-03-01T10:00:00.000Z"}')).toBe(T0);
    expect(rawTimestamp('{"type":"custom-title","customTitle":"x"}')).toBeUndefined();
    expect(rawTimestamp('{"timestamp":"not a date"}')).toBeUndefined();
    expect(rawTimestamp('{"timestamp":"2026-03-01T10:00:00.000Z')).toBeUndefined();
  });
});
