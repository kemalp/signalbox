// A log that grows, tears or is replaced: the adapter folds only what was appended, takes whole frames only,
// and starts over when the file is not the one it knew. Plus watchSessions, which rides on the same reads.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepseekAdapter } from "../src/adapter.ts";
import { collect, concat, ev, frame, headerLine, MARK, spyIO } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "signalbox-dsh-growing-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const project = join(home, "sessions", "--Users-test-gamma--");

const T = 1794218400000; // 2026-11-09T10:00:00Z
const reply = (id: string, seq: number, time: number, input: number) =>
  ev("assistant/message", seq, time, {
    message: { id, role: "assistant", content: [{ type: "text", text: MARK }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
    stream: [],
    turn: 1,
    step: 1,
    usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10 },
  });

/** Creates sessions/<project>/<id>/session.v4.jsonl.zstd from batches of lines, one frame per batch. */
async function writeLog(id: string, batches: string[]): Promise<string> {
  const dir = join(project, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(path, concat(await Promise.all(batches.map(frame))));
  return path;
}

/** Appends bytes and moves the mtime on, as a later write would. */
let clock = Date.now() - 60_000;
function append(path: string, bytes: Uint8Array): void {
  appendFileSync(path, bytes);
  clock += 1000;
  utimesSync(path, new Date(clock), new Date(clock));
}

describe("a growing log", () => {
  test("only the appended frames are read; a torn frame waits until it is whole", async () => {
    const id = "session-grow-1";
    const path = await writeLog(id, [headerLine(id), ev("turn/start", 0, T) + reply("m1", 1, T + 1000, 100)]);
    const spy = spyIO();
    const adapter = createDeepseekAdapter({ dshHome: home, io: spy.io });
    expect((await collect(adapter.scanUsage({}))).map((r) => r.id)).toEqual(["m1"]);
    const sizeAfterFirst = statSync(path).size;
    expect(spy.reads).toEqual([{ path, start: 0, length: sizeAfterFirst }]);

    // Unchanged: answered from the cache, no read at all.
    spy.reads.length = 0;
    expect((await collect(adapter.scanUsage({}))).map((r) => r.id)).toEqual(["m1"]);
    expect(spy.reads).toEqual([]);

    // One more batch: the read starts where the last one ended (after a 32-byte look at what is before it).
    append(path, await frame(reply("m2", 2, T + 2000, 200)));
    expect((await collect(adapter.scanUsage({}))).map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(spy.reads.map((r) => r.start)).toEqual([sizeAfterFirst - 32, sizeAfterFirst]);
    const sizeAfterSecond = statSync(path).size;

    // Half a frame, as a crash or a write in progress leaves it: nothing new is taken, nothing breaks.
    const third = await frame(reply("m3", 3, T + 3000, 300) + ev("turn/end", 4, T + 3001, { turn: 1, reason: { kind: "completed" } }));
    append(path, third.subarray(0, 9));
    spy.reads.length = 0;
    expect((await collect(adapter.scanUsage({}))).map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(spy.reads.every((r) => r.start >= sizeAfterSecond - 32)).toBe(true);
    expect(adapter.scanIssues()).toEqual([]);
    expect((await adapter.listSessions!())[0]).toMatchObject({ sessionId: id, status: "busy" });

    // The rest of it arrives.
    append(path, third.subarray(9));
    expect((await collect(adapter.scanUsage({}))).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect((await adapter.listSessions!())[0]).toMatchObject({ sessionId: id, status: "idle" });
    expect((await adapter.readContext!())[0]).toMatchObject({ sessionId: id, tokens: 300 });
  });

  test("a file that is no longer the log it knew is folded afresh", async () => {
    const id = "session-grow-2";
    const path = await writeLog(id, [headerLine(id), reply("old-1", 0, T + 1000, 100), reply("old-2", 1, T + 2000, 100)]);
    const adapter = createDeepseekAdapter({ dshHome: home });
    const mine = async () => (await collect(adapter.scanUsage({}))).filter((r) => r.sessionId === id).map((r) => r.id);
    expect(await mine()).toEqual(["old-1", "old-2"]);
    // Replaced by a longer, different log.
    writeFileSync(path, concat(await Promise.all([headerLine(id), reply("new-1", 0, T + 1000, 100), reply("new-2", 1, T + 2000, 100), reply("new-3", 2, T + 3000, 100), reply("new-4", 3, T + 4000, 100)].map(frame))));
    clock += 1000;
    utimesSync(path, new Date(clock), new Date(clock));
    expect(await mine()).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    // And by a shorter one.
    writeFileSync(path, concat(await Promise.all([headerLine(id), reply("short-1", 0, T + 1000, 100)].map(frame))));
    clock += 1000;
    utimesSync(path, new Date(clock), new Date(clock));
    expect(await mine()).toEqual(["short-1"]);
  });

  test("a damaged frame stops the read there, and health and doctor say so", async () => {
    const id = "session-grow-3";
    const good = await frame(reply("ok-1", 0, T + 1000, 100));
    const bad = await frame(reply("lost-1", 1, T + 2000, 100));
    bad[bad.length - 1]! ^= 0xff; // the checksum no longer matches
    const dir = join(project, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "session.v4.jsonl.zstd");
    writeFileSync(path, concat([await frame(headerLine(id)), good, bad, await frame(reply("after-1", 2, T + 3000, 100))]));
    const far = new Date(Date.now() + 3_600_000); // the newest log, so health looks at it
    utimesSync(path, far, far);
    const adapter = createDeepseekAdapter({ dshHome: home });
    const recs = (await collect(adapter.scanUsage({}))).filter((r) => r.sessionId === id);
    expect(recs.map((r) => r.id)).toEqual(["ok-1"]);
    expect(adapter.scanIssues()).toEqual(["1 session log has a damaged frame, so the usage after it is missing"]);
    const [row] = await adapter.health();
    expect(row!.ok).toBe(true);
    expect(row!.detail).toContain("a damaged frame; what follows it was not read");
  });

  test("a plain log: whole lines only, and the rest when its newline arrives", async () => {
    const id = "session-grow-4";
    const dir = join(project, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "session.v4.jsonl");
    const second = reply("p2", 1, T + 2000, 100);
    writeFileSync(path, headerLine(id) + reply("p1", 0, T + 1000, 100) + second.slice(0, 40));
    const adapter = createDeepseekAdapter({ dshHome: home });
    const mine = async () => (await collect(adapter.scanUsage({}))).filter((r) => r.sessionId === id).map((r) => r.id);
    expect(await mine()).toEqual(["p1"]);
    append(path, new TextEncoder().encode(second.slice(40)));
    expect(await mine()).toEqual(["p1", "p2"]);
  });
});

describe("DeepseekAdapter.watchSessions", () => {
  test("fires when a turn opens or closes, an approval is asked or decided, or a session appears; not for other writes", async () => {
    const watchHome = mkdtempSync(join(tmpdir(), "signalbox-dsh-watch-"));
    try {
      const dir = join(watchHome, "sessions", "--Users-test-delta--");
      const mk = async (id: string, batches: string[]) => {
        mkdirSync(join(dir, id), { recursive: true });
        const p = join(dir, id, "session.v4.jsonl.zstd");
        writeFileSync(p, concat(await Promise.all(batches.map(frame))));
        return p;
      };
      const now = Date.now();
      const a = await mk("session-w1", [headerLine("session-w1"), ev("turn/start", 0, now)]);
      // Next to the logs: a credentials-like file that is never opened.
      writeFileSync(join(dir, "session-w1", "credentials.json"), MARK);
      const spy = spyIO();
      const adapter = createDeepseekAdapter({ dshHome: watchHome, watchPollMs: 15, io: spy.io });
      expect((await adapter.listSessions!()).map((s) => [s.sessionId, s.status])).toEqual([["session-w1", "busy"]]);

      let fired = 0;
      const stop = adapter.watchSessions(() => fired++);
      const settle = () => sleep(120);
      await settle();
      expect(fired).toBe(0); // what was there at the start is the baseline

      appendFileSync(a, await frame(ev("tool/call", 1, now + 1, { name: "bash" }) + ev("step/end", 2, now + 2, { turn: 1, step: 1 })));
      await settle();
      expect(fired).toBe(0); // a write that changes no status

      appendFileSync(a, await frame(ev("turn/end", 3, now + 3, { turn: 1, reason: { kind: "completed" } })));
      await settle();
      expect(fired).toBe(1);

      appendFileSync(a, await frame(ev("turn/start", 4, now + 4, { turn: 2 })));
      await settle();
      expect(fired).toBe(2);

      appendFileSync(a, await frame(ev("approval/asked", 5, now + 5, { id: "apr-1", toolName: "bash", reason: MARK })));
      await settle();
      expect(fired).toBe(3);
      expect((await adapter.listSessions!())[0]).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });

      appendFileSync(a, await frame(ev("approval/decided", 6, now + 6, { id: "apr-1", outcome: "allowed-once" })));
      await settle();
      expect(fired).toBe(4);

      // A new session: its folder first (the harness publishes the log a moment later), then the log.
      mkdirSync(join(dir, "session-w2"));
      await settle();
      expect(fired).toBe(4);
      await mk("session-w2", [headerLine("session-w2"), ev("turn/start", 0, now + 7)]);
      await settle();
      expect(fired).toBe(5);

      // A session in a project folder that did not exist before.
      mkdirSync(join(watchHome, "sessions", "--Users-test-epsilon--", "session-w3"), { recursive: true });
      writeFileSync(join(watchHome, "sessions", "--Users-test-epsilon--", "session-w3", "session.v4.jsonl.zstd"), concat(await Promise.all([headerLine("session-w3")].map(frame))));
      await settle();
      expect(fired).toBe(6);

      stop();
      appendFileSync(a, await frame(ev("turn/end", 7, now + 8, { turn: 2, reason: { kind: "completed" } })));
      await settle();
      expect(fired).toBe(6);
      expect(spy.reads.every((r) => /\/session\.v4\.jsonl\.zstd$/.test(r.path))).toBe(true);
    } finally {
      rmSync(watchHome, { recursive: true, force: true });
    }
  });
});
