import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCodexAdapter } from "../src/adapter.ts";
import { isForbiddenName } from "../src/io.ts";
import { collect, IDS, makeHome, MARK, NOW, spyIO, type TempHome } from "./helpers.ts";

let h: TempHome;
let spy: ReturnType<typeof spyIO>;
let adapter: ReturnType<typeof createCodexAdapter>;

beforeAll(() => {
  h = makeHome();
  spy = spyIO();
  adapter = createCodexAdapter({ codexHome: h.home, now: () => NOW, io: spy.io });
});

afterAll(() => {
  // The decoys must never have reached the filesystem layer: not read, not even stat'ed.
  const touched = [...spy.reads, ...spy.stats].filter((p) => isForbiddenName(p));
  expect(touched).toEqual([]);
  expect(statSync(h.path("auth")).mode & 0o777).toBe(0);
  h.cleanup();
});

describe("CodexAdapter", () => {
  test("identity and detect", async () => {
    expect(adapter.id).toBe("codex");
    expect(adapter.displayName).toBe("Codex");
    expect(adapter.codexHome).toBe(h.home);
    expect(await adapter.detect()).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "signalbox-codex-empty-"));
    try {
      expect(await createCodexAdapter({ codexHome: empty }).detect()).toBe(false);
      const health = await createCodexAdapter({ codexHome: join(empty, "missing") }).health();
      expect(health).toEqual([{ name: "codex:rollouts", stability: "internal", ok: false, detail: `${join(empty, "missing")} not found` }]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("CODEX_HOME is honoured when no option is given", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = h.home;
    try {
      expect(createCodexAdapter().codexHome).toBe(h.home);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  test("scanUsage: every rollout (incl. archived and .zst), deduplicated across files", async () => {
    const recs = await collect(adapter.scanUsage({}));
    expect(recs.map((r) => r.id).sort()).toEqual(
      ["resp_A1", "resp_A2", "resp_A3", "resp_A4", "resp_B1", "resp_C1", "resp_E1", "resp_F1", `${IDS.D}:tc:4300`, `${IDS.D}:tc:10500`].sort(),
    );
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length);
    const a1 = recs.find((r) => r.id === "resp_A1");
    expect(a1?.sourcePath).toContain(IDS.A); // the forked copy in C was dropped
    expect(recs.find((r) => r.id === "resp_E1")).toMatchObject({ model: "gpt-5.5", kind: "main", sessionId: IDS.E });
    expect(recs.find((r) => r.id === "resp_F1")).toMatchObject({ model: "gpt-6-luna", sessionId: IDS.F });
    expect(recs.find((r) => r.id === "resp_B1")).toMatchObject({ kind: "auxiliary", sessionId: IDS.A });
    expect(JSON.stringify(recs)).not.toContain(MARK);
  });

  test("scanUsage honours since/until (half-open)", async () => {
    const day = await collect(adapter.scanUsage({ since: new Date("2026-10-09T00:00:00Z"), until: new Date("2026-10-09T10:31:30Z") }));
    expect(day.map((r) => r.id)).toEqual(["resp_A1", "resp_A2", "resp_A3"]);
    const old = await collect(adapter.scanUsage({ until: new Date("2026-09-02T00:00:00Z") }));
    expect(old.map((r) => r.id).sort()).toEqual([`${IDS.D}:tc:10500`, `${IDS.D}:tc:4300`, "resp_E1"]);
  });

  test("a forked copy with a later timestamp never stands in for an original outside the range", async () => {
    // C repeats resp_A1 at 11:50; the original is at 10:00.
    const fromEleven = await collect(adapter.scanUsage({ since: new Date("2026-10-09T11:00:00Z") }));
    expect(fromEleven.map((r) => r.id)).toEqual(["resp_C1"]);
    // Here A's file is pruned by mtime; the adapter still remembers resp_A1's earliest timestamp.
    const late = await collect(adapter.scanUsage({ since: new Date("2026-10-09T11:45:00Z") }));
    expect(late.map((r) => r.id)).toEqual(["resp_C1"]);
  });

  test("records come out in time order", async () => {
    const ts = (await collect(adapter.scanUsage({}))).map((r) => Date.parse(r.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  test("readLimits: freshest reading per kind across sessions", async () => {
    const limits = await adapter.readLimits!();
    const byKind = Object.fromEntries(limits.map((l) => [l.kind, l]));
    expect(Object.keys(byKind)).toEqual(["codex.primary", "codex.primary.10080m", "codex.secondary"]);
    expect(byKind["codex.primary"]).toMatchObject({ usedPercent: 14, label: "5-hour", sessionId: IDS.A, observedAt: "2026-10-09T10:40:02.100Z", plan: "plus" });
    expect(byKind["codex.secondary"]).toMatchObject({ usedPercent: 4, label: "Weekly", resetsAt: "2026-10-14T00:00:00.000Z", windowMinutes: 10080 });
    expect(byKind["codex.primary.10080m"]).toMatchObject({ usedPercent: 5, label: "Weekly (gpt-reserve)", sessionId: IDS.C, resetsAt: "2026-10-16T11:00:00.000Z" });
  });

  test("readLimits: an idle account still gets its last known readings", async () => {
    const later = createCodexAdapter({ codexHome: h.home, now: () => new Date("2026-11-30T00:00:00Z"), io: spy.io });
    const limits = await later.readLimits!();
    expect(limits.map((l) => l.kind)).toEqual(["codex.primary", "codex.primary.10080m", "codex.secondary"]);
    // Readings later than `now` are ignored.
    const past = createCodexAdapter({ codexHome: h.home, now: () => new Date("2026-09-01T09:00:00Z"), io: spy.io });
    const pastLimits = await past.readLimits!();
    expect(pastLimits.map((l) => [l.kind, l.usedPercent, l.observedAt])).toEqual([
      ["codex.primary", 2, "2026-09-01T08:00:02.000Z"],
      ["codex.secondary", 1, "2026-09-01T08:00:02.000Z"],
    ]);
  });

  test("readContext: last token_count of recent main sessions", async () => {
    const ctx = await adapter.readContext!();
    expect(ctx.map((c) => c.sessionId).sort()).toEqual([IDS.A, IDS.C].sort());
    const a = ctx.find((c) => c.sessionId === IDS.A);
    expect(a).toEqual({ agent: "codex", sessionId: IDS.A, tokens: 40000, window: 258400, windowSource: "agent", percent: 15.5, observedAt: "2026-10-09T10:31:30.100Z", quality: "estimated", source: "rollout:token_count" });
  });

  test("listSessions: recent main threads plus index-only entries", async () => {
    const sessions = await adapter.listSessions!();
    expect(sessions.map((s) => [s.sessionId, s.status, s.source])).toEqual([
      [IDS.C, "busy", "rollout+session_index"],
      [IDS.A, "idle", "rollout+session_index"],
      [IDS.G, "unknown", "session_index"],
    ]);
    const [c, a, g] = sessions;
    expect(a).toEqual({
      agent: "codex",
      sessionId: IDS.A,
      status: "idle",
      statusSince: "2026-10-09T10:32:00.000Z",
      source: "rollout+session_index",
      cwd: "/synthetic/project-a/sub",
      name: "Synthetic session A",
      entrypoint: "codex_cli_rs",
      version: "0.200.0",
      model: "gpt-6-astra",
      effort: "high",
      startedAt: "2026-10-09T10:00:00.000Z",
      lastActivity: "2026-10-09T10:32:00.000Z",
    });
    expect(c).toMatchObject({ status: "busy", statusSince: "2026-10-09T11:50:01.000Z", model: "gpt-reserve", entrypoint: "codex_work_desktop", name: "Synthetic session C" });
    expect(g).toMatchObject({ name: "Synthetic index-only session", lastActivity: "2026-10-09T09:00:00.000000Z" });
  });

  test("an open turn on a rollout that stopped being written is unknown, not busy", async () => {
    const later = createCodexAdapter({ codexHome: h.home, now: () => new Date("2026-10-09T12:30:00Z"), io: spy.io });
    const c = (await later.listSessions!()).find((s) => s.sessionId === IDS.C);
    expect(c?.status).toBe("unknown");
    expect(c?.statusSince).toBeUndefined();
  });

  test("readCompactions", async () => {
    expect(await adapter.readCompactions!({})).toEqual([{ agent: "codex", sessionId: IDS.A, ts: "2026-10-09T10:30:00.100Z", trigger: "unknown", preTokens: 5000 }]);
    expect(await adapter.readCompactions!({ since: new Date("2026-10-09T11:00:00Z") })).toEqual([]);
  });

  test("health: internal sources, passes unknown line types through", async () => {
    const health = await adapter.health();
    expect(health.map((x) => [x.name, x.stability, x.ok])).toEqual([
      ["codex:rollouts", "internal", true],
      ["codex:rate-limits", "internal", true],
      ["codex:session-index", "internal", true],
    ]);
    expect(health[0]?.detail).toContain("6 rollout files (1 archived, 3 written in the last 24h)");
    expect(health[0]?.detail).toContain("unknown line types passed through: future_thing");
    expect(health[1]?.detail).toContain("freshest reading 2026-10-09T11:55:00.100Z (plan plus)");
  });

  test("parsed rollouts are cached until the file changes", async () => {
    const pathA = h.path("A");
    const readsOfA = () => spy.reads.filter((p) => p === pathA).length;
    await collect(adapter.scanUsage({}));
    const before = readsOfA();
    await collect(adapter.scanUsage({}));
    expect(readsOfA()).toBe(before);

    const u = { input_tokens: 70, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 77 };
    appendFileSync(pathA, JSON.stringify({ timestamp: "2026-10-09T10:33:00.000Z", ordinal: 99, type: "token_usage_record", payload: { session_id: IDS.A, thread_id: IDS.A, turn_id: "t2", response_id: "resp_A5", usage: u } }) + "\n");
    const t = new Date("2026-10-09T10:33:01Z");
    utimesSync(pathA, t, t);
    const recs = await collect(adapter.scanUsage({ since: new Date("2026-10-09T10:32:30Z"), until: new Date("2026-10-09T10:35:00Z") }));
    expect(recs.map((r) => r.id)).toEqual(["resp_A5"]);
    expect(recs[0]?.model).toBe("gpt-6-astra");
    expect(readsOfA()).toBe(before + 1);
  });

  test("only rollouts and the session index are ever opened", () => {
    const names = new Set(spy.reads.map((p) => basename(p)));
    for (const n of names) expect(n === "session_index.jsonl" || /^rollout-.+\.jsonl(\.zst)?$/.test(n)).toBe(true);
    expect([...names].some((n) => n.endsWith(".zst"))).toBe(true);
  });
});
