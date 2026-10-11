// The Claude app's session list: the allow-list (which paths are listed, lstat'd and opened), the field
// allow-list (nothing but the kept fields survives a parse), and the merge into listHistory. Synthetic data only
// (claude-app-fixture.ts); every file the reader must not open is a decoy, most of them unreadable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildHistory, embeddedPriceTables, type AppSessionRecord } from "../../core/src/index.ts";
import {
  CLAUDE_APP_PATH,
  CLAUDE_APP_TRACE_ENV,
  ClaudeAppReader,
  claudeAppSetting,
  createClaudeAdapter,
  defaultClaudeAppFs,
  nodeClaudeAppFs,
  parseAppSession,
  tracedClaudeAppFs,
  type ClaudeAppFs,
} from "../src/index.ts";
import {
  APP_ARCHIVED,
  APP_CANARY,
  APP_GONE,
  APP_IDS,
  APP_LINKED,
  APP_TITLES,
  makeTreeRemovable,
  writeClaudeAppTree,
  type AppTree,
  type AppTreeTimes,
} from "./claude-app-fixture.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const TIMES: AppTreeTimes = {
  linked: { createdAt: NOW - 30 * H, lastActivityAt: NOW - 2 * H },
  archived: { createdAt: NOW - 50 * H, lastActivityAt: NOW - 40 * H },
  gone: { createdAt: NOW - 100 * H, lastActivityAt: NOW - 90 * H },
  noCli: { createdAt: NOW - 10 * H, lastActivityAt: NOW - 9 * H },
};
const RECORD_KEYS = new Set([
  "agent",
  "appSessionId",
  "agentSessionId",
  "title",
  "titleSource",
  "cwd",
  "originCwd",
  "createdAt",
  "lastActivityAt",
  "archived",
  "model",
  "effort",
  "transcriptUnavailable",
]);

let root: string;
let tree: AppTree;

/** Wraps the real fs calls and records every path the reader touches. */
function spyFs() {
  const seen = { readdir: [] as string[], lstat: [] as string[], readFile: [] as string[] };
  const fs: ClaudeAppFs = {
    readdir: (dir) => (seen.readdir.push(dir), nodeClaudeAppFs.readdir(dir)),
    lstat: (p) => (seen.lstat.push(p), nodeClaudeAppFs.lstat(p)),
    readFile: (p, max) => (seen.readFile.push(p), nodeClaudeAppFs.readFile(p, max)),
  };
  return { fs, seen };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-claude-app-"));
  tree = writeClaudeAppTree(root, TIMES);
});
afterAll(() => {
  makeTreeRemovable(tree);
  rmSync(root, { recursive: true, force: true });
});

describe("the allow-list", () => {
  test("opens only <a>/<b>/local_<id>.json regular files up to 1 MiB; never a decoy", async () => {
    const { fs, seen } = spyFs();
    const read = await new ClaudeAppReader(tree.base, { fs, now: () => NOW }).read();
    expect(seen.readFile.sort()).toEqual([...tree.allowed].sort());
    // lstat only for allow-listed names (the symlink, the 2 MiB file and the folder fail it); listing only the
    // base and its real <a> and <a>/<b> folders: never the symlinked org folder or anything deeper.
    for (const p of seen.lstat) expect(CLAUDE_APP_PATH.test(relative(tree.base, p))).toBe(true);
    expect(seen.lstat).toHaveLength(tree.allowed.length + 3);
    expect(seen.readdir.sort()).toEqual([tree.base, join(tree.base, "acct-0001"), join(tree.base, "acct-0001", "org-0001")].sort());
    const touched = new Set([...seen.readdir, ...seen.lstat, ...seen.readFile]);
    for (const d of tree.decoys) expect(seen.readFile).not.toContain(d);
    for (const p of touched) expect(p.startsWith(tree.base)).toBe(true);
    expect(read).toMatchObject({ dir: tree.base, dirExists: true, candidates: tree.allowed.length + 3, skipped: 3, errors: 2 });
    expect(read.records.map((r) => r.appSessionId).sort()).toEqual(Object.values(APP_IDS).sort());
  });

  test("the size cap holds once a file is open, and a symlink is refused at open too", async () => {
    // The default readFile is used after lstat; check its own guards directly.
    const big = join(root, "big.json");
    writeFileSync(big, "x".repeat(2048));
    expect(await nodeClaudeAppFs.readFile(big, 1024)).toBeUndefined();
    expect(await nodeClaudeAppFs.readFile(big, 4096)).toBe("x".repeat(2048));
    // A readable target, so only O_NOFOLLOW can refuse it.
    const target = join(root, "readable.json");
    writeFileSync(target, "{}");
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(await nodeClaudeAppFs.readFile(target, 1024)).toBe("{}");
    await expect(nodeClaudeAppFs.readFile(link, 1024)).rejects.toThrow();
  });

  test("the audit trace reports every call before it is made, and is off unless asked for", async () => {
    expect(defaultClaudeAppFs({})).toBe(nodeClaudeAppFs);
    expect(defaultClaudeAppFs({ [CLAUDE_APP_TRACE_ENV]: "0" })).toBe(nodeClaudeAppFs);
    expect(defaultClaudeAppFs({ [CLAUDE_APP_TRACE_ENV]: "1" })).not.toBe(nodeClaudeAppFs);
    const lines: string[] = [];
    const { fs, seen } = spyFs();
    await new ClaudeAppReader(tree.base, { fs: tracedClaudeAppFs(fs, (l) => lines.push(l)), now: () => NOW }).read();
    const expected = [
      ...seen.readdir.map((p) => `readdir ${p}`),
      ...seen.lstat.map((p) => `lstat ${p}`),
      ...seen.readFile.map((p) => `open ${p}`),
    ];
    expect([...lines].sort()).toEqual(expected.sort());
    expect(lines.filter((l) => l.startsWith("open ")).map((l) => l.slice(5)).sort()).toEqual([...tree.allowed].sort());
  });

  test("a missing folder is an empty list, not an error", async () => {
    const read = await new ClaudeAppReader(join(root, "nope")).read();
    expect(read).toMatchObject({ dirExists: false, records: [], candidates: 0, skipped: 0, errors: 0 });
  });

  test("an unchanged file is not read again", async () => {
    const { fs, seen } = spyFs();
    const reader = new ClaudeAppReader(tree.base, { fs, now: () => NOW });
    await reader.read();
    const first = seen.readFile.length;
    const again = await reader.read();
    expect(seen.readFile.length).toBe(first);
    expect(again.records).toHaveLength(4);
  });
});

describe("the field allow-list", () => {
  test("only the kept fields survive; summaries, suggestions, drafts and errors are dropped", async () => {
    const read = await new ClaudeAppReader(tree.base, { now: () => NOW }).read();
    const json = JSON.stringify(read);
    expect(json).not.toContain(APP_CANARY);
    for (const r of read.records) for (const k of Object.keys(r)) expect(RECORD_KEYS.has(k)).toBe(true);
    const linked = read.records.find((r) => r.appSessionId === APP_IDS.linked)!;
    expect(linked).toEqual({
      agent: "claude-code",
      appSessionId: APP_IDS.linked,
      agentSessionId: APP_LINKED,
      title: APP_TITLES.linked,
      titleSource: "auto",
      cwd: "/Users/you/code/app-project",
      originCwd: "/Users/you/code/app-project",
      createdAt: new Date(TIMES.linked.createdAt).toISOString(),
      lastActivityAt: new Date(TIMES.linked.lastActivityAt).toISOString(),
      archived: false,
      model: "claude-opus-5-5",
      effort: "high",
    } satisfies AppSessionRecord);
  });

  test("kept fields are validated: unsafe ids, free text in labels, relative paths and odd times are dropped", () => {
    const r = parseAppSession(
      JSON.stringify({
        sessionId: "local_ok-1",
        cliSessionId: "bad id; rm -rf /",
        title: `  Two\nlines‮  `,
        titleSource: "set by the user, see the prompt",
        cwd: "relative/path",
        originCwd: "/ok\u0007bell",
        createdAt: 12,
        lastActivityAt: NOW + 10 * 86_400_000,
        isArchived: "yes",
        model: "claude opus <script>",
        effort: "x".repeat(40),
        transcriptUnavailable: 1,
      }),
      NOW,
    );
    expect(r).toEqual({ agent: "claude-code", appSessionId: "local_ok-1", title: "Two lines" });
    expect(parseAppSession(JSON.stringify({ sessionId: "../escape" }))).toBeUndefined();
    expect(parseAppSession("[1,2]")).toBeUndefined();
    expect(parseAppSession("not json")).toBeUndefined();
    expect(parseAppSession(JSON.stringify({ sessionId: "local_m", model: "claude-opus-5-5[1m]" }))?.model).toBe("claude-opus-5-5[1m]");
  });
});

describe("listHistory with the Claude app's list", () => {
  let configDir: string;
  const T0 = NOW - 6 * H;
  const line = (sid: string, id: string, ms: number) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: sid,
      cwd: "/Users/you/code/app-project",
      timestamp: new Date(ms).toISOString(),
      requestId: `req_${id}`,
      message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "synthetic" }], usage: { input_tokens: 10, output_tokens: 5 } },
    });

  beforeAll(() => {
    configDir = join(root, "claude-config");
    const proj = join(configDir, "projects", "-Users-you-code-app-project");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(configDir, "sessions"));
    writeFileSync(
      join(proj, `${APP_LINKED}.jsonl`),
      `${[JSON.stringify({ type: "ai-title", aiTitle: "Generated title", sessionId: APP_LINKED }), line(APP_LINKED, "m1", T0), line(APP_LINKED, "m2", T0 + H)].join("\n")}\n`,
    );
    const archived = join(proj, `${APP_ARCHIVED}.jsonl`);
    writeFileSync(archived, `${line(APP_ARCHIVED, "m3", NOW - 45 * H)}\n`);
    // An old file: the app's newer activity must still pull it in for a `since` after its mtime.
    const old = new Date(NOW - 44 * H);
    utimesSync(archived, old, old);
    writeFileSync(join(proj, "b2b2b2b2-0000-4000-8000-000000000009.jsonl"), `${line("b2b2b2b2-0000-4000-8000-000000000009", "m4", T0)}\n`);
  });

  const adapter = (claudeAppDir?: string | false) =>
    createClaudeAdapter({ configDir, spoolDir: join(root, "spool"), claudeBin: "/nonexistent", now: () => new Date(NOW), claudeAppDir });

  test("merged, app-only and transcript-only sessions; the app's title wins", async () => {
    const a = adapter(tree.base);
    const list = await a.listHistory();
    const h = buildHistory({ sessions: list, tables: embeddedPriceTables(), claudeApp: { enabled: true, records: 4 } });
    const by = new Map(h.entries.map((e) => [e.sessionId, e]));
    expect(by.get(APP_LINKED)).toMatchObject({
      hasTranscript: true,
      title: APP_TITLES.linked,
      titleSource: "app",
      appTitleSource: "auto",
      appSessionId: APP_IDS.linked,
      archived: false,
      effort: "high",
      responses: 2,
      startedAt: new Date(TIMES.linked.createdAt).toISOString(),
      lastActivityAt: new Date(TIMES.linked.lastActivityAt).toISOString(),
    });
    expect(by.get(APP_LINKED)!.resume?.command).toBe(`claude --resume ${APP_LINKED}`);
    expect(by.get(APP_ARCHIVED)).toMatchObject({ hasTranscript: true, title: APP_TITLES.archived, titleSource: "app", archived: true, responses: 1 });
    expect(by.get(APP_ARCHIVED)!.appTitleSource).toBeUndefined();
    for (const id of [APP_GONE, APP_IDS.noCli]) {
      const e = by.get(id)!;
      expect(e).toMatchObject({ hasTranscript: false, titleSource: "app", live: false });
      expect(e.responses).toBeUndefined();
      expect(e.costUsd).toBeUndefined();
      expect(e.tokens).toBeUndefined();
      expect(e.resume).toBeUndefined();
    }
    expect(by.get("b2b2b2b2-0000-4000-8000-000000000009")).toMatchObject({ hasTranscript: true, responses: 1 });
    expect(by.get("b2b2b2b2-0000-4000-8000-000000000009")!.appSessionId).toBeUndefined();
    expect(h.sources).toEqual({ transcripts: 3, claudeApp: { enabled: true, records: 4, merged: 2, appOnly: 2, archived: 2 } });
    expect(JSON.stringify(h)).not.toContain(APP_CANARY);
    expect(a.claudeAppStatus()).toMatchObject({ enabled: true, dir: tree.base, records: 4, merged: 2, appOnly: 2, archived: 2, skipped: 3, errors: 2 });
  });

  test("a session the app saw since `since` keeps its transcript even when the file is older", async () => {
    const list = await adapter(tree.base).listHistory({ since: new Date(NOW - 42 * H) });
    const archived = list.find((s) => s.sessionId === APP_ARCHIVED)!;
    expect(archived).toMatchObject({ appSessionId: APP_IDS.archived, archived: true });
    expect(archived.hasTranscript).not.toBe(false);
    expect(archived.records).toHaveLength(1);
    // Records with no activity since then and no listed transcript are left out, not turned into app-only rows.
    expect(list.some((s) => s.sessionId === APP_GONE)).toBe(false);
    const later = await adapter(tree.base).listHistory({ since: new Date(NOW - 20 * H) });
    expect(later.some((s) => s.sessionId === APP_ARCHIVED)).toBe(false);
    expect(later.find((s) => s.sessionId === APP_IDS.noCli)?.hasTranscript).toBe(false);
  });

  test("off (--no-claude-app) is the transcript-only history; unset adds no health row", async () => {
    const off = adapter(false);
    const offList = await off.listHistory();
    const plain = await adapter().listHistory();
    const strip = (xs: typeof plain) => JSON.stringify(xs.map(({ records, ...rest }) => ({ ...rest, n: records.length })).sort((x, y) => x.sessionId.localeCompare(y.sessionId)));
    expect(strip(offList)).toBe(strip(plain));
    expect(offList.some((s) => s.titleSource === "app" || s.appSessionId)).toBe(false);
    expect(offList.find((s) => s.sessionId === APP_LINKED)).toMatchObject({ title: "Generated title", titleSource: "ai" });
    expect(off.claudeAppStatus()).toEqual({ enabled: false, off: "flag" });
    expect((await off.health()).find((h) => h.name === "claude-app:sessions")).toMatchObject({ ok: true, stability: "internal", detail: expect.stringContaining("off") });
    expect((await adapter().health()).some((h) => h.name === "claude-app:sessions")).toBe(false);
    expect(adapter().claudeAppStatus()).toBeUndefined();
  });

  test("health row: the base path and counts, names only before the first history", async () => {
    const a = adapter(tree.base);
    const before = (await a.health()).find((h) => h.name === "claude-app:sessions")!;
    expect(before).toMatchObject({ stability: "internal", ok: true });
    expect(before.detail).toContain(tree.base);
    expect(before.detail).toContain(`${tree.allowed.length + 3} session record files`);
    expect(before.detail).toContain("read on demand");
    await a.listHistory();
    const after = (await a.health()).find((h) => h.name === "claude-app:sessions")!;
    expect(after.ok).toBe(false); // two allow-listed files held no usable record
    expect(after.detail).toContain("4 records read, 2 matched a transcript, 2 without a transcript, 2 archived, 3 skipped");
  });

  test("health row: no Claude app is not a fault; a folder that can't be listed is", async () => {
    // Terminal-only users have no app folder: a neutral note, no warning they can't act on.
    const missing = (await adapter(join(root, "no-app")).health()).find((h) => h.name === "claude-app:sessions")!;
    expect(missing).toMatchObject({ ok: true, stability: "internal" });
    expect(missing.detail).toBe(`Claude app not found at ${join(root, "no-app")}; history lists sessions with a transcript only`);
    // A base folder that exists but can't be listed (permissions) is a real failure.
    const denied: ClaudeAppFs = {
      ...nodeClaudeAppFs,
      readdir: async (dir) => {
        if (dir === tree.base) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return nodeClaudeAppFs.readdir(dir);
      },
    };
    const a = createClaudeAdapter({ configDir, spoolDir: join(root, "spool"), claudeBin: "/nonexistent", now: () => new Date(NOW), claudeAppDir: tree.base, claudeAppFs: denied });
    const row = (await a.health()).find((h) => h.name === "claude-app:sessions")!;
    expect(row).toMatchObject({ ok: false, detail: expect.stringContaining("(EACCES)") });
    expect((await new ClaudeAppReader(tree.base, { fs: denied }).read()).dirError).toBe("EACCES");
    expect((await new ClaudeAppReader(join(root, "no-app")).read())).toMatchObject({ dirExists: false, records: [] });
    expect((await new ClaudeAppReader(join(root, "no-app")).read()).dirError).toBeUndefined();
  });

  test("off for another reason: the health row says which", async () => {
    const off = createClaudeAdapter({
      configDir,
      spoolDir: join(root, "spool"),
      claudeBin: "/nonexistent",
      claudeAppDir: false,
      claudeAppOff: { reason: "claude-config-dir", detail: "off: CLAUDE_CONFIG_DIR is elsewhere" },
    });
    expect(off.claudeAppStatus()).toEqual({ enabled: false, off: "claude-config-dir" });
    expect((await off.health()).find((h) => h.name === "claude-app:sessions")).toMatchObject({ ok: true, detail: "off: CLAUDE_CONFIG_DIR is elsewhere" });
  });
});

describe("claudeAppSetting (whether the CLI reads the list, and where)", () => {
  const home = "/Users/you";
  const appDir = "/Users/you/Library/Application Support/Claude/claude-code-sessions";

  test("on by default, from the app's folder; --no-claude-app turns it off", () => {
    expect(claudeAppSetting(true, {}, home)).toEqual({ dir: appDir });
    expect(claudeAppSetting(false, {}, home)).toMatchObject({ off: "flag", detail: expect.stringContaining("--no-claude-app") });
    // The flag wins over an explicit list too.
    expect(claudeAppSetting(false, { SIGNALBOX_CLAUDE_APP_DIR: "/tmp/list" }, home)).toMatchObject({ off: "flag" });
  });

  test("CLAUDE_CONFIG_DIR at ~/.claude (however spelled) keeps it on; anywhere else turns it off", () => {
    for (const dir of ["/Users/you/.claude", "/Users/you/.claude/", "/Users/you/x/../.claude"]) {
      expect(claudeAppSetting(true, { CLAUDE_CONFIG_DIR: dir }, home)).toEqual({ dir: appDir });
    }
    expect(claudeAppSetting(true, { CLAUDE_CONFIG_DIR: "" }, home)).toEqual({ dir: appDir });
    const off = claudeAppSetting(true, { CLAUDE_CONFIG_DIR: "/tmp/experiment/.claude" }, home);
    expect(off).toMatchObject({ off: "claude-config-dir" });
    expect("detail" in off && off.detail).toContain("/tmp/experiment/.claude");
  });

  test("SIGNALBOX_CLAUDE_APP_DIR names a list explicitly, whatever CLAUDE_CONFIG_DIR is", () => {
    expect(claudeAppSetting(true, { SIGNALBOX_CLAUDE_APP_DIR: "/tmp/list", CLAUDE_CONFIG_DIR: "/tmp/experiment" }, home)).toEqual({ dir: "/tmp/list" });
  });
});
