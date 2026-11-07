// Accounts: transcript account lines, the Claude app's folder names, each config dir's login (Claude Code's global
// config), several config dirs, and limits kept apart per account. Every id, email and title here is SYNTHETIC; the
// canaries must never reach any output, and neither may a raw account or organization id.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountId, buildHistory, embeddedPriceTables } from "../../core/src/index.ts";
import { redactIdFolders } from "../src/claude-app.ts";
import { ConfigLoginReader, loginFromConfigText, topLevelObjectText, type LoginFs } from "../src/config-account.ts";
import { createClaudeAdapter, type ClaudeAdapterOptions } from "../src/index.ts";

const CANARY = "CANARY_SECRET";
const EMAIL = "someone@example.invalid";
const ACCT_MAX = "0a0a0a0a-1111-4111-8111-00000000000a";
const ORG_MAX = "0c0c0c0c-1111-4111-8111-00000000000c";
const ACCT_TEAM = "0b0b0b0b-2222-4222-8222-00000000000b";
const ORG_TEAM = "0d0d0d0d-2222-4222-8222-00000000000d";
const RAW_IDS = [ACCT_MAX, ORG_MAX, ACCT_TEAM, ORG_TEAM];

const SID_DESK = "d0000000-0000-4000-8000-000000000001"; // desktop, bridge line (Max)
const SID_LEDGER = "d0000000-0000-4000-8000-000000000002"; // desktop, artifact ledger only (Team, no org)
const SID_TERM = "d0000000-0000-4000-8000-000000000003"; // terminal in the main dir (inferred Max)
const SID_TEAM = "d0000000-0000-4000-8000-000000000004"; // terminal in the Team dir (inferred Team)
const SID_BARE = "d0000000-0000-4000-8000-000000000005"; // desktop, nothing names its account
const SID_APP = "d0000000-0000-4000-8000-000000000006"; // desktop, only the app's folder names it (Team)
const SID_SDK = "d0000000-0000-4000-8000-000000000007"; // SDK run in the Team dir: often an API key, so not inferred
const SID_OLD = "d0000000-0000-4000-8000-000000000008"; // an old spool whose transcript is gone

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

let root: string;
let mainDir: string;
let teamDir: string;
let appDir: string;
let spoolDir: string;
let envLog: string;
let fakeClaude: string;

function line(o: Record<string, unknown>): string {
  return `${JSON.stringify(o)}\n`;
}

function transcript(sid: string, entrypoint: string, extra: Record<string, unknown>[] = []): string {
  const cwd = "/Users/test/accounts";
  return (
    line({ type: "user", cwd, sessionId: sid, timestamp: iso(0), message: { role: "user", content: `${CANARY} prompt` } }) +
    line({
      type: "assistant",
      cwd,
      sessionId: sid,
      entrypoint,
      version: "2.1.293",
      timestamp: iso(1),
      requestId: `req_${sid.slice(-4)}`,
      message: { id: `msg_${sid.slice(-4)}`, model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: CANARY }] },
    }) +
    extra.map(line).join("")
  );
}

function writeTranscript(dir: string, sid: string, text: string): void {
  const proj = join(dir, "projects", "-Users-test-accounts");
  mkdirSync(proj, { recursive: true });
  const p = join(proj, `${sid}.jsonl`);
  writeFileSync(p, text);
  const t = new Date(T0 + 5 * 60_000);
  utimesSync(p, t, t);
}

function globalConfig(acct: string, org: string): string {
  return JSON.stringify({
    numStartups: 3,
    oauthAccount: { accountUuid: acct, organizationUuid: org, emailAddress: EMAIL, displayName: CANARY, fullName: CANARY, organizationName: CANARY, billingType: "x" },
    mcpServers: { secret: { env: { API_KEY: CANARY } } },
    projects: { "/Users/test/accounts": { history: [{ display: `${CANARY} old prompt` }] } },
  });
}

function registry(dir: string, sid: string, entrypoint: string): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "sessions", `${process.pid}${sid.slice(-1)}.json`),
    JSON.stringify({ pid: process.pid, sessionId: sid, cwd: "/Users/test/accounts", kind: "interactive", entrypoint, status: "idle", version: "2.1.293" }),
  );
}

function spool(sid: string, used: number, resetsAt: string, configDir?: string | null): void {
  mkdirSync(spoolDir, { recursive: true });
  const body: Record<string, unknown> = {
    v: 1,
    seq: 1,
    agent: "claude-code",
    sessionId: sid,
    writtenAt: iso(4),
    event: "session.measure",
    usage: { rateLimits: [{ kind: "five_hour", percentUsed: used, resetsAt }] },
  };
  if (configDir !== undefined) body.configDir = configDir;
  writeFileSync(join(spoolDir, `${sid}.json`), JSON.stringify(body));
}

function appRecord(acct: string, org: string, appId: string, sid: string): void {
  const dir = join(appDir, acct, org);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `local_${appId}.json`),
    JSON.stringify({ sessionId: `local_${appId}`, cliSessionId: sid, title: "Synthetic app title", createdAt: T0, lastActivityAt: T0 + 3 * 60_000, postTurnSummary: CANARY }),
  );
}

function adapter(extra: Partial<ClaudeAdapterOptions> = {}) {
  return createClaudeAdapter({
    configDir: mainDir,
    extraConfigDirs: [teamDir],
    spoolDir,
    claudeBin: fakeClaude,
    claudeAppDir: appDir,
    now: () => new Date(T0 + 10 * 60_000),
    ...extra,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-accounts-"));
  mainDir = join(root, "claude-main");
  teamDir = join(root, "claude-team");
  appDir = join(root, "app-sessions");
  spoolDir = join(root, "spool");
  envLog = join(root, "agents-env.log");
  fakeClaude = join(root, "fake-claude");
  writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" >> "${envLog}"\necho '[]'\n`, { mode: 0o755 });

  writeTranscript(mainDir, SID_DESK, transcript(SID_DESK, "claude-desktop", [{ type: "bridge-session", sessionId: SID_DESK, bridgeSessionId: "b1", lastSequenceNum: 2, ownerAccountUuid: ACCT_MAX, ownerOrganizationUuid: ORG_MAX }]));
  writeTranscript(mainDir, SID_LEDGER, transcript(SID_LEDGER, "claude-desktop", [{ type: "artifact-autoreact-ledger", v: 1, sessionId: SID_LEDGER, accountUuid: ACCT_TEAM, artifacts: [{ title: CANARY }] }]));
  writeTranscript(mainDir, SID_TERM, transcript(SID_TERM, "cli"));
  writeTranscript(mainDir, SID_BARE, transcript(SID_BARE, "claude-desktop"));
  writeTranscript(mainDir, SID_APP, transcript(SID_APP, "claude-desktop"));
  writeTranscript(teamDir, SID_TEAM, transcript(SID_TEAM, "cli"));
  writeTranscript(teamDir, SID_SDK, transcript(SID_SDK, "sdk-ts"));
  writeFileSync(join(mainDir, ".claude.json"), globalConfig(ACCT_MAX, ORG_MAX));
  writeFileSync(join(teamDir, ".claude.json"), globalConfig(ACCT_TEAM, ORG_TEAM));
  registry(mainDir, SID_TERM, "cli");
  registry(teamDir, SID_TEAM, "cli");
  registry(mainDir, SID_BARE, "claude-desktop");
  appRecord(ACCT_TEAM, ORG_TEAM, "20000000-0000-4000-8000-000000000006", SID_APP);
  appRecord(ACCT_MAX, ORG_MAX, "20000000-0000-4000-8000-000000000001", SID_DESK);
  spool(SID_TERM, 40, iso(200));
  spool(SID_TEAM, 90, iso(250));
  spool(SID_BARE, 10, iso(260));
  // Weeks old, its window long reset: never shown, and no transcript is read for it.
  writeFileSync(
    join(spoolDir, `${SID_OLD}.json`),
    JSON.stringify({ v: 1, seq: 1, agent: "claude-code", sessionId: SID_OLD, writtenAt: "2026-09-20T10:00:00.000Z", event: "session.measure", usage: { rateLimits: [{ kind: "seven_day", percentUsed: 88, resetsAt: "2026-09-25T00:00:00.000Z" }] } }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const MAX = accountId(ACCT_MAX, ORG_MAX);
const TEAM = accountId(ACCT_TEAM, ORG_TEAM);
const TEAM_PARTIAL = accountId(ACCT_TEAM);

function assertNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const raw of RAW_IDS) expect(text).not.toContain(raw);
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(CANARY);
}

describe("history accounts", () => {
  test("each source, recorded before inferred, unknown left unknown", async () => {
    const a = adapter();
    const snap = buildHistory({ sessions: await a.listHistory(), tables: embeddedPriceTables() });
    const by = new Map(snap.entries.map((e) => [e.sessionId, e]));
    expect(by.get(SID_DESK)!.account).toEqual({ id: MAX, orgKnown: true, source: "claude-app-folder", quality: "recorded" });
    // Only the account half is on record; the one full id with that account (Team) completes it, marked inferred.
    expect(by.get(SID_LEDGER)!.account).toEqual({ id: TEAM, orgKnown: true, source: "account-match", quality: "inferred" });
    expect(by.get(SID_APP)!.account).toEqual({ id: TEAM, orgKnown: true, source: "claude-app-folder", quality: "recorded" });
    expect(by.get(SID_TERM)!.account).toEqual({ id: MAX, orgKnown: true, source: "config-login", quality: "inferred" });
    expect(by.get(SID_TEAM)!.account).toEqual({ id: TEAM, orgKnown: true, source: "config-login", quality: "inferred" });
    expect(by.get(SID_TEAM)!.configDir).toBe(teamDir);
    // `claude` finds a session only in the config dir it runs with, so the resume command names it.
    expect(by.get(SID_TEAM)!.resume?.command).toBe(`CLAUDE_CONFIG_DIR='${teamDir}' claude --resume ${SID_TEAM}`);
    // A desktop session runs on the app's own login, and an SDK run often on an API key: no inference for either.
    expect(by.get(SID_BARE)!.account).toBeUndefined();
    expect(by.get(SID_SDK)!.account).toBeUndefined();
    expect("account" in by.get(SID_BARE)!).toBe(false);
    assertNoLeak(snap);
  });

  test("health reports how sessions got their account, and each folder's login", async () => {
    const a = adapter();
    await a.listHistory();
    const h = await a.health();
    const accounts = h.find((r) => r.name === "claude-code:accounts")!;
    expect(accounts.detail).toContain("5 of 7 sessions have an account");
    expect(accounts.detail).toContain("2 from the Claude app's folder names, 0 from transcript account lines, 3 inferred");
    const logins = h.find((r) => r.name === "claude-code:logins")!;
    expect(logins.ok).toBe(true);
    expect(logins.detail).toContain(`${mainDir}: signed in as account ${MAX.slice(5, 11)}`);
    expect(logins.detail).toContain(`${teamDir}: signed in as account ${TEAM.slice(5, 11)}`);
    expect(h.find((r) => r.name === "claude-code:transcripts")!.detail).toContain(join(teamDir, "projects"));
    assertNoLeak(h);
  });
});

describe("live sessions and limits", () => {
  test("live sessions from both config dirs, with their accounts", async () => {
    const a = adapter();
    const sessions = await a.listSessions();
    const by = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(by.get(SID_TERM)).toMatchObject({ configDir: mainDir, account: { id: MAX, quality: "inferred" } });
    expect(by.get(SID_TEAM)).toMatchObject({ configDir: teamDir, account: { id: TEAM, quality: "inferred" } });
    expect(by.get(SID_BARE)!.account).toBeUndefined();
    assertNoLeak(sessions);
  });

  test("agents --json runs once per config dir, each with its own CLAUDE_CONFIG_DIR (the primary was given explicitly)", async () => {
    rmSync(envLog, { force: true });
    await adapter().listSessions();
    expect(readFileSync(envLog, "utf8").trim().split("\n").sort()).toEqual([teamDir, mainDir].sort());
  });

  test("two accounts never share a gauge; an unknown-account reading stays apart; an old spool shows nothing", async () => {
    const a = adapter();
    await a.listSessions();
    const limits = await a.readLimits();
    expect(limits.map((l) => [l.account?.id ?? "unknown", l.usedPercent])).toEqual([
      ...[
        [MAX, 40],
        [TEAM, 90],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      ["unknown", 10],
    ]);
    assertNoLeak(limits);
  });

  test("readAccounts: logins, app folders and transcript accounts, hashed", async () => {
    const a = adapter();
    await a.listHistory();
    const accounts = await a.readAccounts();
    // The Team account half named alone (an artifact line) is the same person as the full Team id: listed once.
    expect(accounts.map((x) => x.id).sort()).toEqual([MAX, TEAM].sort());
    expect(accounts.find((x) => x.id === MAX)).toMatchObject({ loginConfigDirs: [mainDir], claudeAppFolder: true });
    expect(accounts.find((x) => x.id === TEAM)).toMatchObject({ loginConfigDirs: [teamDir], claudeAppFolder: true });
    assertNoLeak(accounts);
  });
});

describe("Claude Code's default dir as an extra one", () => {
  test("agents --json without CLAUDE_CONFIG_DIR, its login from ~/.claude.json, and a resume that unsets the variable", async () => {
    const home = mkdtempSync(join(tmpdir(), "signalbox-home-"));
    try {
      const def = join(home, ".claude");
      const work = join(home, ".claude-work");
      writeTranscript(def, SID_TERM, transcript(SID_TERM, "cli"));
      writeTranscript(work, SID_TEAM, transcript(SID_TEAM, "cli"));
      writeFileSync(join(home, ".claude.json"), globalConfig(ACCT_MAX, ORG_MAX));
      writeFileSync(join(work, ".claude.json"), globalConfig(ACCT_TEAM, ORG_TEAM));
      mkdirSync(join(def, "sessions"), { recursive: true });
      rmSync(envLog, { force: true });
      const ad = createClaudeAdapter({ configDir: work, extraConfigDirs: [def], spoolDir: join(home, "spool"), claudeBin: fakeClaude, homeDir: home, now: () => new Date(T0 + 10 * 60_000) });
      await ad.listSessions();
      expect(readFileSync(envLog, "utf8").trim().split("\n").sort()).toEqual(["unset", work].sort());
      const snap = buildHistory({ sessions: await ad.listHistory(), tables: embeddedPriceTables() });
      const by = new Map(snap.entries.map((e) => [e.sessionId, e]));
      expect(by.get(SID_TERM)!.account?.id).toBe(MAX);
      expect(by.get(SID_TERM)!.resume?.command).toBe(`env -u CLAUDE_CONFIG_DIR claude --resume ${SID_TERM}`);
      expect(by.get(SID_TEAM)!.resume?.command).toBe(`claude --resume ${SID_TEAM}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("shared transcript trees", () => {
  test("a projects/ symlinked into another config dir is read once, and only the tap tells its sessions apart", async () => {
    const shared = mkdtempSync(join(tmpdir(), "signalbox-shared-"));
    try {
      const a = join(shared, "a");
      const b = join(shared, "b");
      writeTranscript(a, SID_TERM, transcript(SID_TERM, "cli"));
      writeTranscript(a, SID_TEAM, transcript(SID_TEAM, "cli"));
      writeFileSync(join(a, ".claude.json"), globalConfig(ACCT_MAX, ORG_MAX));
      mkdirSync(b, { recursive: true });
      writeFileSync(join(b, ".claude.json"), globalConfig(ACCT_TEAM, ORG_TEAM));
      symlinkSync(join(a, "projects"), join(b, "projects"));
      const sp = join(shared, "spool");
      mkdirSync(sp);
      writeFileSync(
        join(sp, `${SID_TEAM}.json`),
        JSON.stringify({ v: 1, seq: 1, agent: "claude-code", sessionId: SID_TEAM, writtenAt: iso(4), event: "session.measure", configDir: b }),
      );
      const ad = createClaudeAdapter({ configDir: a, extraConfigDirs: [b], spoolDir: sp, claudeBin: fakeClaude, now: () => new Date(T0 + 10 * 60_000) });
      const sessions = await ad.listHistory();
      expect(sessions.map((s) => s.sessionId).sort()).toEqual([SID_TERM, SID_TEAM].sort());
      const snap = buildHistory({ sessions, tables: embeddedPriceTables() });
      const by = new Map(snap.entries.map((e) => [e.sessionId, e]));
      // The tree is shared, so its location names no config dir; the tap's configDir does.
      expect(by.get(SID_TERM)!.account).toBeUndefined();
      expect(by.get(SID_TERM)!.configDir).toBeUndefined();
      expect(by.get(SID_TEAM)!.account).toEqual({ id: TEAM, orgKnown: true, source: "tap-config-dir", quality: "inferred" });
      const h = await ad.health();
      expect(h.find((r) => r.name === "claude-code:transcripts")!.detail).toContain("shared by");
      // The primary shares the tree, so a plain `claude` finds every session in it.
      expect(by.get(SID_TEAM)!.resume?.command).toBe(`claude --resume ${SID_TEAM}`);
      // Two extra dirs sharing a tree without the primary: the resume names the first of them.
      const p = join(shared, "primary");
      mkdirSync(p, { recursive: true });
      const ad2 = createClaudeAdapter({ configDir: p, extraConfigDirs: [a, b], spoolDir: sp, claudeBin: fakeClaude, now: () => new Date(T0 + 10 * 60_000) });
      const snap2 = buildHistory({ sessions: await ad2.listHistory(), tables: embeddedPriceTables() });
      expect(snap2.entries.find((e) => e.sessionId === SID_TERM)!.resume?.command).toBe(`CLAUDE_CONFIG_DIR='${a}' claude --resume ${SID_TERM}`);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });
});

describe("config login reader", () => {
  test("keeps the two ids, hashed; everything else is dropped", () => {
    const ev = loginFromConfigText(globalConfig(ACCT_MAX, ORG_MAX))!;
    expect(ev.ref).toEqual({ id: MAX, orgKnown: true, source: "config-login", quality: "inferred" });
    assertNoLeak(ev);
    expect(loginFromConfigText(JSON.stringify({ numStartups: 1 }))).toBeUndefined();
    expect(loginFromConfigText(JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }))).toBeUndefined();
    expect(() => loginFromConfigText("{oops")).toThrow();
  });

  test("only the top-level oauthAccount object is cut out and parsed", () => {
    const text = JSON.stringify({
      projects: { "/x": { note: '"oauthAccount": {"accountUuid": "decoy"}', oauthAccount: { accountUuid: ACCT_TEAM } } },
      mcpServers: { s: { env: { KEY: "}{\\\"" } } },
      oauthAccount: { accountUuid: ACCT_MAX, organizationUuid: ORG_MAX, emailAddress: EMAIL },
      after: [1, { oauthAccount: 2 }],
    });
    expect(JSON.parse(topLevelObjectText(text, "oauthAccount")!)).toEqual({ accountUuid: ACCT_MAX, organizationUuid: ORG_MAX, emailAddress: EMAIL });
    expect(loginFromConfigText(text)!.ref.id).toBe(MAX);
    expect(topLevelObjectText(JSON.stringify({ a: { oauthAccount: {} } }), "oauthAccount")).toBeUndefined();
    expect(topLevelObjectText(JSON.stringify({ oauthAccount: "not an object" }), "oauthAccount")).toBeUndefined();
  });

  test("a read that fails in passing keeps the last good login; a removed file doesn't", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-login-"));
    try {
      const f = join(dir, "claude.json");
      writeFileSync(f, globalConfig(ACCT_MAX, ORG_MAX));
      const r = new ConfigLoginReader();
      expect((await r.read(f)).state).toBe("ok");
      writeFileSync(f, '{"oauthAccount": {"accountUu'); // caught mid-write
      const mid = await r.read(f);
      expect(mid.state === "ok" && mid.evidence?.ref.id).toBe(MAX);
      rmSync(f);
      expect((await r.read(f)).state).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file cut off mid-write that happens to end in } is unparsable, not signed out", async () => {
    const cut = '{"numStartups":3,"projects":{"/x":{"a":{}';
    expect(() => topLevelObjectText(cut, "oauthAccount")).toThrow();
    expect(() => loginFromConfigText(cut)).toThrow();
    expect(() => loginFromConfigText('{"numStartups":3,"note":"}')).toThrow();
    expect(() => loginFromConfigText('{"oauthAccount": {"accountUuid": "x", "n": {}')).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "signalbox-login-"));
    try {
      const f = join(dir, "claude.json");
      writeFileSync(f, globalConfig(ACCT_MAX, ORG_MAX));
      const r = new ConfigLoginReader();
      expect((await r.read(f)).state).toBe("ok");
      writeFileSync(f, cut);
      const mid = await r.read(f);
      expect(mid.state === "ok" && mid.evidence?.ref.id).toBe(MAX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses symlinks, oversized files and parse failures; a missing file is just missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-login-"));
    try {
      const real = join(dir, "real.json");
      writeFileSync(real, globalConfig(ACCT_MAX, ORG_MAX));
      symlinkSync(real, join(dir, "link.json"));
      writeFileSync(join(dir, "bad.json"), "{nope");
      const r = new ConfigLoginReader();
      expect((await r.read(join(dir, "link.json"))).state).toBe("not-a-file");
      expect((await r.read(join(dir, "bad.json"))).state).toBe("unparsable");
      expect((await r.read(join(dir, "none.json"))).state).toBe("missing");
      const ok = await r.read(real);
      expect(ok.state === "ok" && ok.evidence?.ref.id).toBe(MAX);
      const opened: string[] = [];
      const huge: LoginFs = {
        lstat: async () => ({ isFile: () => true, size: 33 * 1024 * 1024, mtimeMs: 1 }),
        readFile: async (p) => (opened.push(p), "{}"),
      };
      expect((await new ConfigLoginReader(huge).read(real)).state).toBe("too-large");
      expect(opened).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Claude app trace", () => {
  test("account and organization folder names are redacted; file names are kept", () => {
    expect(redactIdFolders(`/base/${ACCT_MAX}/${ORG_MAX}/local_${ACCT_TEAM}.json`)).toBe(`/base/<id>/<id>/local_${ACCT_TEAM}.json`);
    expect(redactIdFolders(`/base/${ACCT_MAX}`)).toBe("/base/<id>");
  });

  test("under the list's folder, the first two folders are redacted whatever their shape", () => {
    const base = "/x/Application Support/Claude/claude-code-sessions";
    expect(redactIdFolders(`readdir ${base}`, base)).toBe(`readdir ${base}`);
    expect(redactIdFolders(`readdir ${base}/acct_123`, base)).toBe(`readdir ${base}/<id>`);
    expect(redactIdFolders(`lstat ${base}/acct_123/org.456/local_abc.json`, base)).toBe(`lstat ${base}/<id>/<id>/local_abc.json`);
  });
});

describe("edge cases", () => {
  test("a desktop session's account-only id isn't completed by a terminal login alone; a terminal session's is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-partial-"));
    try {
      const cfg = join(dir, "claude");
      const ledger = { type: "artifact-autoreact-ledger", v: 1, sessionId: SID_LEDGER, accountUuid: ACCT_TEAM, artifacts: [] };
      writeTranscript(cfg, SID_LEDGER, transcript(SID_LEDGER, "claude-desktop", [ledger]));
      writeTranscript(cfg, SID_TERM, transcript(SID_TERM, "cli", [{ ...ledger, sessionId: SID_TERM }]));
      writeFileSync(join(cfg, ".claude.json"), globalConfig(ACCT_TEAM, ORG_TEAM));
      const ad = createClaudeAdapter({ configDir: cfg, spoolDir: join(dir, "spool"), claudeBin: fakeClaude, claudeAppDir: false, now: () => new Date(T0 + 10 * 60_000) });
      const snap = buildHistory({ sessions: await ad.listHistory(), tables: embeddedPriceTables() });
      const by = new Map(snap.entries.map((e) => [e.sessionId, e]));
      expect(by.get(SID_LEDGER)!.account).toEqual({ id: TEAM_PARTIAL, orgKnown: false, source: "transcript", quality: "recorded" });
      expect(by.get(SID_TERM)!.account).toMatchObject({ id: TEAM, orgKnown: true, quality: "inferred" });
      // The account-only id is still in use, so it is listed beside the full one.
      expect((await ad.readAccounts()).map((x) => x.id).sort()).toEqual([TEAM, TEAM_PARTIAL].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same session copied into two unshared trees: the newest copy wins, subagents count once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-copy-"));
    try {
      const a = join(dir, "a");
      const b = join(dir, "b");
      // The newer copy is in the first tree read, so "the last one read" would get it wrong.
      for (const [cfg, min] of [[a, 8], [b, 5]] as const) {
        writeTranscript(cfg, SID_TERM, transcript(SID_TERM, "cli"));
        const t = new Date(T0 + min * 60_000);
        utimesSync(join(cfg, "projects", "-Users-test-accounts", `${SID_TERM}.jsonl`), t, t);
        const sub = join(cfg, "projects", "-Users-test-accounts", SID_TERM, "subagents");
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, "agent-a1.jsonl"), transcript(SID_TERM, "cli"));
      }
      const ad = createClaudeAdapter({ configDir: a, extraConfigDirs: [b], spoolDir: join(dir, "spool"), claudeBin: fakeClaude, claudeAppDir: false, now: () => new Date(T0 + 10 * 60_000) });
      const sessions = await ad.listHistory();
      expect(sessions.length).toBe(1);
      expect(sessions[0]).toMatchObject({ configDir: a, subagentFiles: 1, resume: { command: `claude --resume ${SID_TERM}` } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a desktop session just started gets its account on limits within seconds, not a minute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-newdesk-"));
    const start = Date.now();
    try {
      const cfg = join(dir, "claude");
      const app = join(dir, "app");
      mkdirSync(app, { recursive: true });
      writeTranscript(cfg, SID_BARE, transcript(SID_BARE, "claude-desktop"));
      registry(cfg, SID_BARE, "claude-desktop");
      const sp = join(dir, "spool");
      mkdirSync(sp);
      writeFileSync(
        join(sp, `${SID_BARE}.json`),
        JSON.stringify({ v: 1, seq: 1, agent: "claude-code", sessionId: SID_BARE, writtenAt: iso(4), event: "session.measure", usage: { rateLimits: [{ kind: "five_hour", percentUsed: 30, resetsAt: iso(200) }] } }),
      );
      const ad = createClaudeAdapter({ configDir: cfg, spoolDir: sp, claudeBin: fakeClaude, claudeAppDir: app, now: () => new Date(T0 + 10 * 60_000) });
      expect((await ad.readLimits())[0]!.account).toBeUndefined();
      // The app writes its record a moment later.
      mkdirSync(join(app, ACCT_TEAM, ORG_TEAM), { recursive: true });
      writeFileSync(join(app, ACCT_TEAM, ORG_TEAM, "local_20000000-0000-4000-8000-000000000005.json"), JSON.stringify({ sessionId: "local_20000000-0000-4000-8000-000000000005", cliSessionId: SID_BARE, createdAt: T0, lastActivityAt: T0 }));
      setSystemTime(new Date(start + 11_000));
      expect((await ad.readLimits())[0]!.account).toEqual({ id: TEAM, orgKnown: true, source: "claude-app-folder", quality: "recorded" });
    } finally {
      setSystemTime();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
