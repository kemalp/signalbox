// CodexAdapter.watchSessions and the tail turn-state reader, against synthetic rollouts in a temp home.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "../src/adapter.ts";
import { ForbiddenFileError, guardIO, isForbiddenName, nodeIO, type CodexIO } from "../src/io.ts";
import { lastTurnState } from "../src/rollout.ts";

const home = mkdtempSync(join(tmpdir(), "signalbox-codex-watch-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type, turn_id: "t1", ...extra } })}\n`;
const meta = (id: string) => `${JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, cwd: "/Users/test/codex", cli_version: "0.0.0", originator: "codex_cli_rs" } })}\n`;

describe("lastTurnState", () => {
  test("the last turn event decides; other lines and partial lines don't count", () => {
    expect(lastTurnState("")).toBeUndefined();
    expect(lastTurnState(ev("token_count"))).toBeUndefined();
    expect(lastTurnState(ev("task_started"))).toBe(true);
    expect(lastTurnState(ev("task_started") + ev("token_count"))).toBe(true);
    expect(lastTurnState(ev("task_started") + ev("task_complete"))).toBe(false);
    expect(lastTurnState(ev("task_complete") + ev("task_started"))).toBe(true);
    expect(lastTurnState(ev("task_started") + ev("turn_aborted"))).toBe(false);
    // A cut-off first line and a response item that merely mentions the word.
    const cut = ev("task_complete").slice(20);
    expect(lastTurnState(cut + ev("task_started"))).toBe(true);
    const mention = `${JSON.stringify({ type: "response_item", payload: { type: "message", text: '"task_complete"' } })}\n`;
    expect(lastTurnState(ev("task_started") + mention)).toBe(true);
  });
});

describe("guardIO.readRange", () => {
  test("reads a byte range and refuses credential-like names", async () => {
    const p = join(home, "range.txt");
    writeFileSync(p, "0123456789");
    const io = guardIO(nodeIO);
    expect(new TextDecoder().decode(await io.readRange!(p, 3, 4))).toBe("3456");
    expect(new TextDecoder().decode(await io.readRange!(p, 8, 100))).toBe("89");
    await expect(io.readRange!(join(home, "auth.json"), 0, 10)).rejects.toBeInstanceOf(ForbiddenFileError);
    // An IO without readRange falls back to readFile.
    const { readRange: _drop, ...noRange } = nodeIO;
    expect(new TextDecoder().decode(await guardIO(noRange as CodexIO).readRange!(p, 1, 2))).toBe("12");
  });
});

describe("CodexAdapter.watchSessions", () => {
  test("fires when a turn opens or closes or a rollout appears, not for other writes", async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(day, { recursive: true });
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-00`;
    const a = join(day, `rollout-${stamp}-01a10000-0000-7000-8000-0000000000a1.jsonl`);
    writeFileSync(a, meta("01a10000-0000-7000-8000-0000000000a1") + ev("task_started"));
    // A credential-like name in the same dir: never stat'ed, never read.
    const decoy = join(day, `rollout-${stamp}-auth-decoy.jsonl`);
    writeFileSync(decoy, ev("task_started"));

    const touched: string[] = [];
    const spy: CodexIO = {
      readFile: (p) => (touched.push(p), nodeIO.readFile(p)),
      stat: (p) => (touched.push(p), nodeIO.stat(p)),
      readdir: (p) => nodeIO.readdir(p),
      readRange: (p, s, l) => (touched.push(p), nodeIO.readRange!(p, s, l)),
    };
    const adapter = createCodexAdapter({ codexHome: home, io: spy, watchPollMs: 40 });
    let hits = 0;
    const until = async (min: number) => {
      const deadline = performance.now() + 1500;
      while (hits < min) {
        if (performance.now() > deadline) throw new Error(`hits=${hits}, wanted ${min}`);
        await sleep(10);
      }
    };
    const stop = adapter.watchSessions(() => hits++);
    try {
      await sleep(150);
      expect(hits).toBe(0); // the baseline never fires

      appendFileSync(a, ev("token_count"));
      await sleep(200);
      expect(hits).toBe(0);

      appendFileSync(a, ev("task_complete"));
      await until(1);

      // Half a line: nothing yet. The rest of it: the turn opened.
      const line = ev("task_started");
      appendFileSync(a, line.slice(0, 30));
      await sleep(200);
      expect(hits).toBe(1);
      appendFileSync(a, line.slice(30));
      await until(2);

      const b = join(day, `rollout-${stamp}-01a10000-0000-7000-8000-0000000000b2.jsonl`);
      writeFileSync(b, meta("01a10000-0000-7000-8000-0000000000b2"));
      await until(3);
    } finally {
      stop();
    }
    const h = hits;
    appendFileSync(a, ev("task_complete"));
    await sleep(200);
    expect(hits).toBe(h);
    expect(touched.filter((p) => isForbiddenName(p))).toEqual([]);
  });

  test("an active rollout outside the newest date dirs is baselined once listSessions finds it, then followed", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "signalbox-codex-watch-old-"));
    try {
      const old = new Date(Date.now() - 3 * 86_400_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const dir = join(home2, "sessions", String(old.getFullYear()), pad(old.getMonth() + 1), pad(old.getDate()));
      mkdirSync(dir, { recursive: true });
      const id = "01a10000-0000-7000-8000-0000000000c3";
      const p = join(dir, `rollout-${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}T08-00-00-${id}.jsonl`);
      writeFileSync(p, meta(id) + ev("task_started"));
      const adapter = createCodexAdapter({ codexHome: home2, watchPollMs: 40 });
      let hits = 0;
      const stop = adapter.watchSessions(() => hits++);
      try {
        await sleep(120);
        const sessions = await adapter.listSessions!();
        expect(sessions.map((s) => [s.sessionId, s.status])).toEqual([[id, "busy"]]);
        await sleep(200);
        expect(hits).toBe(0);
        appendFileSync(p, ev("task_complete"));
        const deadline = performance.now() + 1500;
        while (hits < 1 && performance.now() < deadline) await sleep(10);
        expect(hits).toBe(1);
      } finally {
        stop();
      }
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});
