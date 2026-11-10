import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepseekAdapter, type DeepseekAdapter } from "../src/adapter.ts";
import { isSessionLogPath } from "../src/io.ts";
import { collect, IDS, makeHome, MARK, NOW, spyIO, type Spy, type TempHome } from "./helpers.ts";

let h: TempHome;
let spy: Spy;
let adapter: DeepseekAdapter;

beforeAll(async () => {
  h = await makeHome();
  spy = spyIO();
  adapter = createDeepseekAdapter({ dshHome: h.home, now: () => NOW, io: spy.io });
});

afterAll(() => {
  // Only session logs were ever read, and nothing outside sessions/ was listed or lstat'ed.
  expect(spy.reads.filter((r) => !isSessionLogPath(h.sessions, r.path))).toEqual([]);
  const touched = [...spy.reads.map((r) => r.path), ...spy.stats, ...spy.lists];
  expect(touched.filter((p) => h.decoys.includes(p))).toEqual([]);
  expect(touched.filter((p) => p.includes("linked-session/") || p.includes("/outside"))).toEqual([]);
  expect(touched.filter((p) => p !== h.home && !p.startsWith(h.sessions))).toEqual([]);
  // The generation the harness kept after a migration is never opened once a newer one exists.
  expect(spy.reads.filter((r) => r.path === h.path("E0"))).toEqual([]);
  for (const d of h.decoys) expect(statSync(d).mode & 0o777).toBe(0);
  h.cleanup();
});

describe("DeepseekAdapter", () => {
  test("identity and detect", async () => {
    expect(adapter.id).toBe("deepseek-harness");
    expect(adapter.displayName).toBe("DeepSeek Harness");
    expect(adapter.dshHome).toBe(h.home);
    expect(await adapter.detect()).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "signalbox-dsh-empty-"));
    try {
      expect(await createDeepseekAdapter({ dshHome: empty }).detect()).toBe(false);
      expect(await createDeepseekAdapter({ dshHome: empty }).health()).toEqual([
        { name: "deepseek-harness:session-logs", stability: "internal", ok: false, detail: `no session logs under ${join(empty, "sessions")}` },
      ]);
      // No home at all: the harness isn't installed, so there is no source to report on, failing or otherwise.
      const missing = join(empty, "missing");
      expect(await createDeepseekAdapter({ dshHome: missing }).detect()).toBe(false);
      expect(await createDeepseekAdapter({ dshHome: missing }).health()).toEqual([]);
      expect(await collect(createDeepseekAdapter({ dshHome: missing }).scanUsage({}))).toEqual([]);
      expect(await createDeepseekAdapter({ dshHome: missing }).listSessions!()).toEqual([]);
      expect(await createDeepseekAdapter({ dshHome: missing }).listHistory()).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("DSH_HOME is honoured when no option is given", () => {
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = h.home;
    try {
      expect(createDeepseekAdapter().dshHome).toBe(h.home);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });

  test("scanUsage: one record per model call, across compressed and plain logs", async () => {
    const recs = await collect(adapter.scanUsage({}));
    expect(recs.map((r) => r.id).sort()).toEqual(
      [
        "msg-A1",
        "msg-A2",
        `${IDS.A}:attempt:21`,
        "msg-A3",
        `${IDS.A}:compaction:cmp-A1`,
        "msg-A4",
        "msg-B1",
        "msg-B2",
        "msg-C1",
        "msg-D1",
        "msg-D2",
        "msg-G1",
        "msg-E1",
        "msg-F1",
        "msg-H1",
      ].sort(),
    );
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length);
    const byId = Object.fromEntries(recs.map((r) => [r.id, r]));

    expect(byId["msg-A1"]).toMatchObject({
      agent: "deepseek-harness",
      keyQuality: "id",
      sessionId: IDS.A,
      kind: "main",
      model: "deepseek-v4-pro",
      ts: "2026-11-09T10:00:30.000Z",
      project: "/Users/test/alpha",
      tokens: { input: 1000, output: 200, cacheRead: 9000, cacheWrite5m: 0, cacheWrite1h: 0 },
      outputFinal: true,
      webSearchRequests: 0,
    });
    expect(byId["msg-A1"]!.sourcePath).toBe(h.path("A")); // the fork's copy was left out
    // Cache writes have no TTL in the log: the short-TTL slot. Reasoning is part of output.
    expect(byId["msg-A2"]!.tokens).toEqual({ input: 500, output: 300, cacheRead: 10000, cacheWrite5m: 200, cacheWrite1h: 0, reasoning: 120 });
    // Usage only in the stream's last usage chunk.
    expect(byId["msg-A3"]!.tokens).toEqual({ input: 700, output: 150, cacheRead: 11000, cacheWrite5m: 0, cacheWrite1h: 0 });
    // A retried call never became a message, but the provider counted it.
    expect(byId[`${IDS.A}:attempt:21`]).toMatchObject({ keyQuality: "request", kind: "main", model: "deepseek-v4-pro", flags: ["retried-attempt"], tokens: { input: 11500, output: 40 } });
    // The summarizing call of a compaction is a response of its own, on the model that made the summary.
    expect(byId[`${IDS.A}:compaction:cmp-A1`]).toMatchObject({ keyQuality: "id", kind: "auxiliary", sessionId: IDS.A, model: "deepseek-flash", tokens: { input: 12000, output: 800 } });

    // Delegated sessions roll up into the session the user started.
    expect(byId["msg-B1"]).toMatchObject({ sessionId: IDS.A, kind: "subagent", model: "deepseek-flash" });
    expect(byId["msg-C1"]).toMatchObject({ sessionId: IDS.A, kind: "subagent" });
    expect(byId["msg-G1"]).toMatchObject({ sessionId: IDS.D, kind: "workflow", model: "glm-5.2:cloud" });

    expect(byId["msg-D1"]).toMatchObject({ sessionId: IDS.D, kind: "main", model: "kimi-k3.1-pro:cloud", project: "/Users/test/beta" });
    expect(byId["msg-D2"]!.project).toBe("/Users/test/beta/worktree"); // after working-directory/change
    expect(byId["msg-E1"]).toMatchObject({ model: "claude-haiku-5-5", tokens: { input: 4000, output: 500, cacheRead: 0, cacheWrite5m: 6000 } });
    expect(byId["msg-F1"]).toMatchObject({ sessionId: IDS.F, model: "hy4-preview", tokens: { input: 5000, output: 10 } });
    expect(byId["msg-F1"]!.project).toBeUndefined();
    expect(JSON.stringify(recs)).not.toContain(MARK);
    expect(adapter.scanIssues()).toEqual([]);
  });

  test("scanUsage honours since/until (half-open) and comes out in time order", async () => {
    const early = await collect(adapter.scanUsage({ since: new Date("2026-11-09T00:00:00Z"), until: new Date("2026-11-09T10:01:00Z") }));
    expect(early.map((r) => r.id)).toEqual(["msg-A1"]);
    const morning = await collect(adapter.scanUsage({ since: new Date("2026-11-09T00:00:00Z"), until: new Date("2026-11-09T10:01:30Z") }));
    expect(morning.map((r) => r.id)).toEqual(["msg-A1", "msg-A2"]);
    const old = await collect(adapter.scanUsage({ until: new Date("2026-09-02T00:00:00Z") }));
    expect(old.map((r) => r.id)).toEqual(["msg-E1"]);
    const late = await collect(adapter.scanUsage({ since: new Date("2026-11-09T11:00:00Z") }));
    expect(late.map((r) => r.id)).toEqual(["msg-D1", "msg-G1", "msg-F1", "msg-D2"]);
    const ts = (await collect(adapter.scanUsage({}))).map((r) => Date.parse(r.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  test("listSessions: the sessions the user started, written in the last 24h", async () => {
    const sessions = await adapter.listSessions!();
    expect(sessions.map((s) => s.sessionId)).toEqual([IDS.D, IDS.F, IDS.A]); // newest activity first
    const [d, f, a] = sessions;
    expect(a).toEqual({
      agent: "deepseek-harness",
      sessionId: IDS.A,
      status: "idle",
      statusSince: "2026-11-09T10:32:01.000Z",
      source: "session-log",
      cwd: "/Users/test/alpha",
      name: "Synthetic alpha title", // the generated title, never the fallback (the start of the prompt)
      model: "deepseek-v4-pro",
      effort: "high",
      startedAt: "2026-11-09T10:00:00.000Z",
      lastActivity: "2026-11-09T10:32:01.000Z",
    });
    // An approval asked for and not decided: waiting, under Claude Code's label for the same thing.
    expect(d).toEqual({
      agent: "deepseek-harness",
      sessionId: IDS.D,
      status: "waiting",
      statusSince: "2026-11-09T11:58:00.000Z",
      waitingFor: "permission prompt",
      source: "session-log",
      cwd: "/Users/test/beta/worktree",
      name: "Renamed by hand", // a rename beats the generated title
      model: "kimi-k3.1-pro:cloud",
      effort: "max",
      startedAt: "2026-11-09T11:50:00.000Z",
      lastActivity: "2026-11-09T11:58:00.000Z",
    });
    // An open turn in a log written 90 s ago: busy. The line still being written is not read.
    expect(f).toEqual({
      agent: "deepseek-harness",
      sessionId: IDS.F,
      status: "busy",
      statusSince: "2026-11-09T11:55:00.001Z",
      source: "session-log",
      model: "hy4-preview",
      startedAt: "2026-11-09T11:55:00.000Z",
      lastActivity: "2026-11-09T11:56:30.000Z",
    });
    expect(JSON.stringify(sessions)).not.toContain(MARK);
  });

  test("listSessions: an open turn in a log that went quiet is unknown, not busy", async () => {
    const later = createDeepseekAdapter({ dshHome: h.home, now: () => new Date(NOW.getTime() + 10 * 60_000), io: spy.io });
    const byId = Object.fromEntries((await later.listSessions!()).map((s) => [s.sessionId, s]));
    expect(byId[IDS.F]!.status).toBe("unknown");
    expect(byId[IDS.F]!.statusSince).toBeUndefined();
    expect(byId[IDS.D]!.status).toBe("waiting"); // still waiting for the same approval
    expect(byId[IDS.A]!.status).toBe("idle");
  });

  test("readContext: the prompt size of the last response, with the window the harness logged", async () => {
    const ctx = Object.fromEntries((await adapter.readContext!()).map((c) => [c.sessionId, c]));
    expect(Object.keys(ctx).sort()).toEqual([IDS.A, IDS.D, IDS.F].sort());
    // After A's compaction came another response, so the size is known again.
    expect(ctx[IDS.A]).toEqual({
      agent: "deepseek-harness",
      sessionId: IDS.A,
      tokens: 3000,
      window: 1000000,
      windowSource: "agent",
      percent: 0.3,
      observedAt: "2026-11-09T10:32:00.000Z",
      quality: "estimated",
      source: "session-log:assistant/message",
    });
    expect(ctx[IDS.D]).toMatchObject({ tokens: 40750, window: 1048576, percent: 3.9 });
    expect(ctx[IDS.F]).toMatchObject({ tokens: 5000, window: 1000000, percent: 0.5 });
  });

  test("readCompactions: finished compactions of the sessions the user started", async () => {
    const all = await adapter.readCompactions!({});
    expect(all).toEqual([
      // Asked for by a command, with no usage on its summary: the size is the last response's prompt.
      { agent: "deepseek-harness", sessionId: IDS.E, ts: "2026-09-01T08:01:04.001Z", trigger: "manual", preTokens: 10000 },
      // Automatic: the size is the prompt of the summarizing call.
      { agent: "deepseek-harness", sessionId: IDS.A, ts: "2026-11-09T10:31:40.001Z", trigger: "auto", preTokens: 12000 },
    ]);
    const recent = await adapter.readCompactions!({ since: new Date("2026-11-09T00:00:00Z") });
    expect(recent.map((c) => c.sessionId)).toEqual([IDS.A]);
  });

  test("health: one row, naming what the newest log holds", async () => {
    expect(await adapter.health()).toEqual([
      {
        name: "deepseek-harness:session-logs",
        stability: "internal",
        ok: true,
        detail: "8 session logs (6 written in the last 24h); newest: format v4, 1 response with usage; unknown event types passed over: future/event",
      },
    ]);
  });
});
