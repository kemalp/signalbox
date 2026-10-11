// listHistory for Codex: main rollouts (archived and .zst too) named from session_index.jsonl, with every
// record of the session. Synthetic fixtures; message text carries MARK, which must never reach the output.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildHistory, embeddedPriceTables, type HistorySession } from "@signalbox/core";
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
  // The credential decoys never reached the filesystem layer.
  expect([...spy.reads, ...spy.stats].filter((p) => isForbiddenName(p))).toEqual([]);
  h.cleanup();
});

const byId = (list: HistorySession[]) => new Map(list.map((s) => [s.sessionId, s]));

describe("Codex listHistory", () => {
  test("one entry per main rollout; subagent and guardian rollouts fold into their session", async () => {
    const list = await adapter.listHistory();
    expect(list.map((s) => s.sessionId).sort()).toEqual([IDS.A, IDS.C, IDS.D, IDS.E, IDS.F].sort());
    const s = byId(list);
    // The newest session_index line per id wins; sessions it doesn't name have no title.
    expect(s.get(IDS.A)).toMatchObject({ title: "Synthetic session A", titleSource: "index" });
    expect(s.get(IDS.C)).toMatchObject({ title: "Synthetic session C", titleSource: "index" });
    expect(s.get(IDS.D)).toMatchObject({ titleSource: "none" });
    expect(s.get(IDS.D)!.title).toBeUndefined();
    const a = s.get(IDS.A)!;
    expect(a).toMatchObject({
      agent: "codex",
      entrypoint: "codex_cli_rs",
      version: "0.200.0",
      compactions: 1,
      subagentFiles: 0,
      workflowRuns: 0,
      startedAt: "2026-10-09T10:00:00.000Z",
      transcriptPath: h.path("A"),
    });
    // The guardian review (B) wrote after A's last line, so it extends A's activity.
    expect(Date.parse(a.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse("2026-10-09T10:40:03.000Z"));
    expect(a.resume).toEqual({ command: `codex resume ${IDS.A}`, cwd: a.project });
    expect(a.project?.startsWith("/synthetic/project-a")).toBe(true);
    expect(s.get(IDS.E)!.transcriptPath).toBe(h.path("E"));
    expect(s.get(IDS.F)!.transcriptPath).toBe(h.path("F"));
  });

  test("records are scanUsage's, each in the session it names (copies dedup to the earliest)", async () => {
    const scanned = await collect(adapter.scanUsage({}));
    const list = await adapter.listHistory();
    expect(list.flatMap((s) => s.records.map((r) => r.id)).sort()).toEqual(scanned.map((r) => r.id).sort());
    const s = byId(list);
    expect(s.get(IDS.A)!.records.map((r) => r.id).sort()).toEqual(["resp_A1", "resp_A2", "resp_A3", "resp_A4", "resp_B1"]);
    expect(s.get(IDS.C)!.records.map((r) => r.id)).toEqual(["resp_C1"]);
  });

  test("no message text, and live flags come from the fleet", async () => {
    const list = await adapter.listHistory();
    expect(JSON.stringify(list)).not.toContain(MARK);
    const fleet = await adapter.listSessions!();
    const snap = buildHistory({ sessions: list, tables: embeddedPriceTables(), live: fleet, now: NOW });
    expect(JSON.stringify(snap)).not.toContain(MARK);
    expect(snap.entries.map((e) => [e.sessionId, e.live])).toEqual([
      [IDS.C, true],
      [IDS.A, true],
      [IDS.F, false],
      [IDS.D, false],
      [IDS.E, false],
    ]);
  });

  test("since keeps sessions active since then", async () => {
    const recent = await adapter.listHistory({ since: new Date("2026-10-01T00:00:00Z") });
    expect(recent.map((s) => s.sessionId).sort()).toEqual([IDS.A, IDS.C, IDS.F].sort());
  });
});
