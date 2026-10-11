// watchDir and ClaudeCodeAdapter.watchSessions against temp dirs (synthetic files only).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/index.ts";
import { isRegistryFileName } from "../src/sessions.ts";
import { watchDir, type DirWatch } from "../src/watch.ts";

const root = mkdtempSync(join(tmpdir(), "signalbox-watch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function freshDir(create = true): string {
  const d = join(root, `d${++n}`);
  if (create) mkdirSync(d);
  return d;
}

/** Waits until `count()` passes `min`, or fails after `ms`. */
async function until(count: () => number, min: number, ms: number): Promise<void> {
  const deadline = performance.now() + ms;
  while (count() < min) {
    if (performance.now() > deadline) throw new Error(`still ${count()} after ${ms} ms (wanted ${min})`);
    await sleep(10);
  }
}

function counting(dir: string, opts: Partial<Parameters<typeof watchDir>[2]> = {}): { w: DirWatch; hits: () => number } {
  let hits = 0;
  const w = watchDir(dir, () => hits++, { accept: isRegistryFileName, pollMs: 50, ...opts });
  return { w, hits: () => hits };
}

describe("watchDir", () => {
  test("fs.watch: registry writes, atomic renames and removals fire; key files and other names don't", async () => {
    const dir = freshDir();
    const { w, hits } = counting(dir);
    try {
      expect(w.mode).toBe("fs.watch");
      await sleep(100);
      writeFileSync(join(dir, "123.abc.key"), "synthetic");
      writeFileSync(join(dir, "notes.txt"), "synthetic");
      await sleep(300);
      expect(hits()).toBe(0);

      writeFileSync(join(dir, "123.json"), '{"status":"busy"}');
      await until(hits, 1, 1000);
      const afterWrite = hits();
      writeFileSync(join(dir, "123.json.tmp"), '{"status":"waiting"}');
      renameSync(join(dir, "123.json.tmp"), join(dir, "123.json"));
      await until(hits, afterWrite + 1, 1000);
      const afterRename = hits();
      rmSync(join(dir, "123.json"));
      await until(hits, afterRename + 1, 1000);
    } finally {
      w.close();
    }
    expect(w.mode).toBe("closed");
  });

  test("poll mode sees changes by name, mtime and size, and never fires for its baseline", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "1.json"), "{}");
    const { w, hits } = counting(dir, { mode: "poll" });
    try {
      expect(w.mode).toBe("poll");
      await sleep(150);
      expect(hits()).toBe(0);
      writeFileSync(join(dir, "1.json"), '{"status":"waiting"}');
      await until(hits, 1, 1000);
      const h = hits();
      writeFileSync(join(dir, "9.abc.key"), "synthetic");
      await sleep(200);
      expect(hits()).toBe(h);
      writeFileSync(join(dir, "2.json"), "{}");
      await until(hits, h + 1, 1000);
    } finally {
      w.close();
    }
  });

  test("a missing dir is polled until it appears, then watched", async () => {
    const dir = freshDir(false);
    const { w, hits } = counting(dir);
    try {
      expect(w.mode).toBe("poll");
      await sleep(120);
      mkdirSync(dir);
      await until(hits, 1, 1000);
      await until(() => (w.mode === "fs.watch" ? 1 : 0), 1, 1000);
      const h = hits();
      writeFileSync(join(dir, "5.json"), "{}");
      await until(hits, h + 1, 1000);
    } finally {
      w.close();
    }
  });

  test("a throwing listener doesn't stop the watch", async () => {
    const dir = freshDir();
    let calls = 0;
    const w = watchDir(
      dir,
      () => {
        calls++;
        throw new Error("listener bug");
      },
      { accept: isRegistryFileName },
    );
    try {
      writeFileSync(join(dir, "1.json"), "{}");
      await until(() => calls, 1, 1000);
      await sleep(100);
      const c = calls;
      writeFileSync(join(dir, "1.json"), '{"x":1}');
      await until(() => calls, c + 1, 1000);
    } finally {
      w.close();
    }
  });
});

describe("ClaudeCodeAdapter.watchSessions", () => {
  test("follows <configDir>/sessions and stops when asked", async () => {
    const configDir = freshDir();
    mkdirSync(join(configDir, "sessions"));
    const a = createClaudeAdapter({ configDir, spoolDir: join(configDir, "spool") });
    let hits = 0;
    const stop = a.watchSessions(() => hits++);
    expect(a.sessionWatchMode()).toBe("fs.watch");
    await sleep(100);
    writeFileSync(join(configDir, "sessions", "42.json"), '{"status":"waiting"}');
    await until(() => hits, 1, 1000);
    stop();
    expect(a.sessionWatchMode()).toBe("closed");
    const h = hits;
    writeFileSync(join(configDir, "sessions", "42.json"), '{"status":"busy"}');
    await sleep(300);
    expect(hits).toBe(h);
  });

  test("watchMode \"poll\" for filesystems without change events", async () => {
    const configDir = freshDir();
    mkdirSync(join(configDir, "sessions"));
    const a = createClaudeAdapter({ configDir, spoolDir: join(configDir, "spool"), watchMode: "poll", watchPollMs: 50 });
    let hits = 0;
    const stop = a.watchSessions(() => hits++);
    try {
      expect(a.sessionWatchMode()).toBe("poll");
      await sleep(120);
      writeFileSync(join(configDir, "sessions", "43.json"), "{}");
      await until(() => hits, 1, 1000);
    } finally {
      stop();
    }
  });
});
