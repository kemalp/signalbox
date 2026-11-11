// DeepseekAdapter.listHistory against the synthetic home, and what core makes of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildHistory, embeddedPriceTables, type HistorySession } from "@signalbox/core";
import { createDeepseekAdapter, type DeepseekAdapter } from "../src/adapter.ts";
import { IDS, makeHome, MARK, NOW, type TempHome } from "./helpers.ts";

let h: TempHome;
let adapter: DeepseekAdapter;
let list: HistorySession[];

beforeAll(async () => {
  h = await makeHome();
  adapter = createDeepseekAdapter({ dshHome: h.home, now: () => NOW });
  list = await adapter.listHistory();
});
afterAll(() => h.cleanup());

const by = (id: string) => list.find((s) => s.sessionId === id)!;

describe("DeepseekAdapter.listHistory", () => {
  test("one entry per session the user started; delegated sessions fold into it", () => {
    expect(list.map((s) => s.sessionId).sort()).toEqual([IDS.A, IDS.D, IDS.E, IDS.F, IDS.H].sort());
    const a = by(IDS.A);
    expect(a).toMatchObject({
      agent: "deepseek-harness",
      title: "Synthetic alpha title",
      titleSource: "ai",
      project: "/Users/test/alpha",
      startedAt: "2026-11-09T10:00:00.000Z",
      lastActivityAt: "2026-11-09T10:32:01.000Z",
      compactions: 1,
      subagentFiles: 2, // the spawned session and the fork
      workflowRuns: 0,
      effort: "high",
      transcriptPath: h.path("A"),
    });
    // Its own six calls, the spawned session's two and the fork's one; the fork's inherited copies are not repeated.
    expect(a.records.map((r) => r.id)).toEqual(["msg-A1", "msg-A2", "msg-C1", `${IDS.A}:attempt:21`, "msg-A3", "msg-B1", "msg-B2", `${IDS.A}:compaction:cmp-A1`, "msg-A4"]);
    expect(a.records.every((r) => r.sessionId === IDS.A)).toBe(true);
    // The harness has no one command that reopens a session, so none is offered.
    expect(list.every((s) => s.resume === undefined)).toBe(true);
  });

  test("a rename beats a generated title; a workflow agent is not a subagent file", () => {
    const d = by(IDS.D);
    expect(d).toMatchObject({ title: "Renamed by hand", titleSource: "custom", project: "/Users/test/beta", subagentFiles: 0, workflowRuns: 1, effort: "max", compactions: 0 });
    expect(d.records.map((r) => [r.id, r.kind])).toEqual([
      ["msg-D1", "main"],
      ["msg-G1", "workflow"],
      ["msg-D2", "main"],
    ]);
  });

  test("a session with only a fallback title has none: that title is the start of the prompt", () => {
    expect(by(IDS.E)).toMatchObject({ titleSource: "none", compactions: 1, startedAt: "2026-09-01T08:00:00.000Z", lastActivityAt: "2026-09-01T08:01:05.000Z" });
    expect(by(IDS.E).title).toBeUndefined();
    expect(by(IDS.F).project).toBeUndefined(); // started with no working directory
    expect(by(IDS.H)).toMatchObject({ startedAt: "2026-11-08T06:00:00.000Z", lastActivityAt: "2026-11-08T07:00:00.002Z" });
    expect(JSON.stringify(list)).not.toContain(MARK);
  });

  test("since keeps whole sessions with activity at or after it", async () => {
    const recent = await adapter.listHistory({ since: new Date("2026-11-09T00:00:00Z") });
    expect(recent.map((s) => s.sessionId).sort()).toEqual([IDS.A, IDS.D, IDS.F].sort());
  });

  test("core prices it: known models from the tables, the rest unpriced", async () => {
    const fleet = await adapter.listSessions!();
    const snap = buildHistory({ sessions: list, tables: embeddedPriceTables(), live: fleet, now: NOW });
    expect(snap.entries.map((e) => e.sessionId)).toEqual([IDS.D, IDS.F, IDS.A, IDS.H, IDS.E]);
    const e = Object.fromEntries(snap.entries.map((x) => [x.sessionId, x]));
    expect(e[IDS.D]).toMatchObject({ live: true, hasTranscript: true, responses: 3, title: "Renamed by hand" });
    expect(e[IDS.A]).toMatchObject({ live: true, responses: 9, compactions: 1, subagentFiles: 2 });
    expect(e[IDS.H]!.live).toBe(false);
    expect(e[IDS.A]!.resume).toBeUndefined();
    // hy4-preview has no price table: its tokens are listed as unpriced, at $0.
    expect(e[IDS.F]).toMatchObject({ costUsd: 0, unpricedTokens: 5010, models: ["hy4-preview"] });
    // claude-haiku-5-5 run through the harness is priced from the Anthropic table like anywhere else.
    expect(e[IDS.E]!.unpricedTokens).toBe(0);
    expect(e[IDS.E]!.costUsd).toBeGreaterThan(0);
  });
});
