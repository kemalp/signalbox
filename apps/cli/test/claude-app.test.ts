// The Claude app's session list end to end: `history --json`, the watch stream and `snapshot --json` against a
// synthetic home (claude-app-home.ts), with and without --no-claude-app. The fields the reader must drop hold
// CANARY, and the decoy files around the list are unreadable: a read of one would show up as an error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CLAUDE_APP_PATH, CLAUDE_APP_TRACE_ENV } from "@signalbox/adapter-claude";
import type { AdapterHealth, HistorySnapshot, SessionHistoryEntry } from "@signalbox/core";
import { APP_ARCHIVED, APP_GONE, APP_IDS, APP_LINKED, APP_TITLES, CANARY, MAIN, makeAppHome, runCli, TRANSCRIPT_ONLY, type AppHome } from "./claude-app-home.ts";

let home: AppHome;
beforeAll(() => {
  home = makeAppHome();
});
afterAll(() => home.cleanup());

const FIGURES = ["responses", "tokens", "costUsd", "unpricedTokens", "placeholderShare", "ledgerUsd", "compactions", "subagentFiles", "workflowRuns", "resume", "transcriptPath"] as const;
const byId = (h: HistorySnapshot) => new Map<string, SessionHistoryEntry>(h.entries.map((e) => [e.sessionId, e]));
/** Entries without the parts that depend on when a run happened. */
const stable = (h: HistorySnapshot) => JSON.stringify(h.entries.map(({ live: _live, ...e }) => e));

describe("history --json with the Claude app's list", () => {
  test("merges by transcript id, adds app-only sessions without figures, drops everything else", async () => {
    const { out, err, code } = await runCli(["history", "--json"], home.env);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).not.toContain(CANARY);
    const h = JSON.parse(out) as HistorySnapshot;
    expect(Object.keys(h)).toEqual(["v", "generatedAt", "entries", "total", "truncated", "sources"]);
    expect(h.sources).toEqual({ transcripts: 3, claudeApp: { enabled: true, records: 4, merged: 2, appOnly: 2, archived: 2 } });
    const by = byId(h);
    expect(by.get(APP_LINKED)).toMatchObject({ hasTranscript: true, title: APP_TITLES.linked, titleSource: "app", appTitleSource: "auto", appSessionId: APP_IDS.linked, archived: false, effort: "high", responses: 2 });
    expect(by.get(APP_LINKED)!.resume?.command).toBe(`claude --resume ${APP_LINKED}`);
    expect(by.get(APP_ARCHIVED)).toMatchObject({ hasTranscript: true, title: APP_TITLES.archived, titleSource: "app", archived: true, responses: 1 });
    expect(by.get(TRANSCRIPT_ONLY)).toMatchObject({ hasTranscript: true, title: "Terminal session", titleSource: "custom" });
    expect(by.get(TRANSCRIPT_ONLY)!.appSessionId).toBeUndefined();
    expect(by.get(TRANSCRIPT_ONLY)!.archived).toBeUndefined();
    for (const id of [APP_GONE, APP_IDS.noCli]) {
      const e = by.get(id)!;
      expect(e).toMatchObject({ agent: "claude-code", hasTranscript: false, titleSource: "app", live: false });
      for (const k of FIGURES) expect(k in e).toBe(false);
    }
    expect(by.get(APP_IDS.noCli)).toMatchObject({ title: APP_TITLES.noCli, archived: true, models: ["claude-opus-5"], project: "/Users/you/code/remote" });
    for (let i = 1; i < h.entries.length; i++) expect(h.entries[i - 1]!.lastActivityAt >= h.entries[i]!.lastActivityAt).toBe(true);
  }, 20_000);

  test("--no-claude-app is the history without the app's list: transcript titles, no app fields", async () => {
    const off = JSON.parse((await runCli(["history", "--json", "--no-claude-app"], home.env)).out) as HistorySnapshot;
    // The same machine with no app list at all.
    const empty = join(home.root, "no-app-list");
    mkdirSync(empty, { recursive: true });
    const none = JSON.parse((await runCli(["history", "--json"], { ...home.env, SIGNALBOX_CLAUDE_APP_DIR: empty })).out) as HistorySnapshot;
    expect(stable(off)).toBe(stable(none));
    expect(off.sources).toEqual({ transcripts: 3, claudeApp: { enabled: false, records: 0, merged: 0, appOnly: 0, archived: 0, off: "flag" } });
    expect(none.sources).toEqual({ transcripts: 3, claudeApp: { enabled: true, records: 0, merged: 0, appOnly: 0, archived: 0 } });
    const by = byId(off);
    expect([...by.keys()].sort()).toEqual([APP_LINKED, APP_ARCHIVED, TRANSCRIPT_ONLY].sort());
    expect(by.get(APP_LINKED)).toMatchObject({ title: "Generated linked title", titleSource: "ai", hasTranscript: true });
    expect(by.get(APP_ARCHIVED)).toMatchObject({ title: "Transcript archived title", titleSource: "custom" });
    for (const e of off.entries) {
      expect(e.appSessionId).toBeUndefined();
      expect(e.archived).toBeUndefined();
    }
  }, 20_000);

  test("--agent codex leaves the app's list out entirely", async () => {
    const h = JSON.parse((await runCli(["history", "--json", "--agent", "codex"], home.env)).out) as HistorySnapshot;
    expect(h.entries).toEqual([]);
    expect(h.sources).toEqual({ transcripts: 0 });
  }, 20_000);

  test("the text table marks app-only and archived sessions", async () => {
    const { out, code } = await runCli(["history"], { ...home.env, COLUMNS: "120" });
    expect(code).toBe(0);
    expect(out).toContain(APP_TITLES.noCli);
    expect(out).toMatch(/app archived/);
    expect(out).toContain("app: listed by the Claude app, with no transcript on this Mac");
    expect(out).not.toContain(CANARY);
  }, 20_000);

  test("CLAUDE_CONFIG_DIR away from ~/.claude turns the reader off (nothing under the app's folder is touched)", async () => {
    // Same transcripts, moved config dir, no explicit list: the app's records describe ~/.claude sessions.
    const { SIGNALBOX_CLAUDE_APP_DIR: _explicit, ...rest } = home.env;
    const env = { ...rest, CLAUDE_CONFIG_DIR: `${home.env.CLAUDE_CONFIG_DIR}/`, [CLAUDE_APP_TRACE_ENV]: "1" };
    // A trailing slash is still ~/.claude: on, reading the default folder under the (temporary) HOME, which has none.
    const same = await runCli(["history", "--json"], env);
    expect((JSON.parse(same.out) as HistorySnapshot).sources?.claudeApp).toEqual({ enabled: true, records: 0, merged: 0, appOnly: 0, archived: 0 });
    const moved = join(home.root, "moved-config");
    mkdirSync(moved, { recursive: true });
    cpSync(home.env.CLAUDE_CONFIG_DIR!, moved, { recursive: true });
    const { out, err, code } = await runCli(["history", "--json"], { ...env, CLAUDE_CONFIG_DIR: moved });
    expect(code).toBe(0);
    expect(err).toBe(""); // no trace line: not even a readdir
    const h = JSON.parse(out) as HistorySnapshot;
    expect(h.sources).toEqual({ transcripts: 3, claudeApp: { enabled: false, records: 0, merged: 0, appOnly: 0, archived: 0, off: "claude-config-dir" } });
    expect(h.entries.every((e) => e.hasTranscript && !e.appSessionId)).toBe(true);
    const snap = JSON.parse((await runCli(["snapshot", "--json"], { ...rest, CLAUDE_CONFIG_DIR: moved })).out) as { health: AdapterHealth[] };
    const row = snap.health.find((r) => r.name === "claude-app:sessions")!;
    expect(row).toMatchObject({ ok: true, stability: "internal" });
    expect(row.detail).toContain(`CLAUDE_CONFIG_DIR is ${moved}`);
  }, 30_000);

  test("snapshot --json: the health row has the history's counts", async () => {
    const snap = JSON.parse((await runCli(["snapshot", "--json"], home.env)).out) as { history: HistorySnapshot; health: AdapterHealth[] };
    const row = snap.health.find((h) => h.name === "claude-app:sessions")!;
    expect(row.ok).toBe(false); // the fixture's two allow-listed files with no usable record
    expect(row.detail).toContain("4 records read, 2 matched a transcript, 2 without a transcript, 2 archived");
    expect(row.detail).not.toContain("read on demand");
  }, 20_000);

  test("snapshot --json --no-claude-app", async () => {
    const snap = JSON.parse((await runCli(["snapshot", "--json", "--no-claude-app"], home.env)).out) as { history: HistorySnapshot; health: AdapterHealth[] };
    expect(snap.history.sources?.claudeApp?.enabled).toBe(false);
    expect(snap.history.entries.every((e) => e.hasTranscript && !e.appSessionId)).toBe(true);
    expect(snap.health.find((h) => h.name === "claude-app:sessions")?.detail).toContain("off (--no-claude-app)");
  }, 20_000);
});

describe("the audit trace (SIGNALBOX_CLAUDE_APP_TRACE=1)", () => {
  /** The trace lines on stderr; anything else there fails the test. */
  function traceOf(err: string): Array<{ op: string; path: string }> {
    return err
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^signalbox claude-app: (readdir|lstat|open) (.+)$/.exec(l);
        if (!m) throw new Error(`unexpected stderr line: ${l}`);
        return { op: m[1]!, path: m[2]! };
      });
  }

  test("every path touched is inside the list; only allow-listed records are opened, never a decoy", async () => {
    const env = { ...home.env, [CLAUDE_APP_TRACE_ENV]: "1" };
    const { out, err, code } = await runCli(["history", "--json"], env);
    expect(code).toBe(0);
    expect(out).not.toContain(CANARY);
    const base = home.tree.base;
    const trace = traceOf(err);
    for (const { path } of trace) expect(path === base || path.startsWith(`${base}/`)).toBe(true);
    const opened = trace.filter((t) => t.op === "open").map((t) => t.path);
    expect(opened.sort()).toEqual([...home.tree.allowed].sort());
    for (const p of [...opened, ...trace.filter((t) => t.op === "lstat").map((t) => t.path)]) {
      expect(CLAUDE_APP_PATH.test(relative(base, p))).toBe(true);
    }
    for (const d of home.tree.decoys) expect(opened).not.toContain(d);
    // `doctor` (the health row) lists names and opens nothing.
    const doctor = traceOf((await runCli(["doctor"], env)).err);
    expect(doctor.length).toBeGreaterThan(0);
    expect(doctor.filter((t) => t.op !== "readdir")).toEqual([]);
  }, 20_000);
});

describe("watch --ndjson with the Claude app's list", () => {
  type Line = { type: string; data?: unknown };
  /** Reads the stream until `done` holds (default: a history and a health line), then closes stdin. */
  async function streamUntilHistory(args: string[], done = (lines: Line[]) => lines.some((l) => l.type === "history") && lines.some((l) => l.type === "health")): Promise<{ text: string; lines: Line[] }> {
    const proc = Bun.spawn([process.execPath, MAIN, "watch", "--ndjson", ...args], { env: home.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let text = "";
    const lines: Line[] = [];
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 20_000;
    try {
      while (!done(lines)) {
        if (Date.now() > deadline) throw new Error(`no history line; got ${lines.map((l) => l.type).join(",")}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        lines.length = 0;
        const complete = text.slice(0, text.lastIndexOf("\n") + 1);
        for (const l of complete.split("\n")) if (l.trim()) lines.push(JSON.parse(l) as Line);
      }
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill();
    }
    return { text, lines };
  }

  test("the history line carries the app's sessions; no dropped field reaches the stream", async () => {
    const { text, lines } = await streamUntilHistory([]);
    expect(text).not.toContain(CANARY);
    const h = lines.find((l) => l.type === "history")!.data as HistorySnapshot;
    expect(h.sources?.claudeApp).toEqual({ enabled: true, records: 4, merged: 2, appOnly: 2, archived: 2 });
    expect(byId(h).get(APP_IDS.noCli)).toMatchObject({ hasTranscript: false });
    const row = (lines.find((l) => l.type === "health")!.data as AdapterHealth[]).find((r) => r.name === "claude-app:sessions")!;
    expect(row).toMatchObject({ stability: "internal" });
    expect(row.detail).toContain(home.tree.base);
  }, 30_000);

  test("a health line follows the first history, with what it read", async () => {
    const after = (lines: Line[]) => {
      const i = lines.findIndex((l) => l.type === "history");
      return i >= 0 && lines.slice(i + 1).some((l) => l.type === "health");
    };
    const { lines } = await streamUntilHistory([], after);
    const i = lines.findIndex((l) => l.type === "history");
    const row = (lines.slice(i + 1).find((l) => l.type === "health")!.data as AdapterHealth[]).find((r) => r.name === "claude-app:sessions")!;
    expect(row.detail).toContain("4 records read, 2 matched a transcript");
    expect(row.ok).toBe(false); // two unusable records in the fixture: flagged without waiting 5 minutes
  }, 30_000);

  test("--no-claude-app: no app sessions in the stream", async () => {
    const { text, lines } = await streamUntilHistory(["--no-claude-app"]);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("local_");
    const h = lines.find((l) => l.type === "history")!.data as HistorySnapshot;
    expect(h.sources?.claudeApp?.enabled).toBe(false);
    expect(h.entries.map((e) => e.sessionId).sort()).toEqual([APP_LINKED, APP_ARCHIVED, TRANSCRIPT_ONLY].sort());
  }, 30_000);
});
