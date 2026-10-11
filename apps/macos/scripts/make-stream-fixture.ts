#!/usr/bin/env bun
// Prints what the real `signalbox watch --ndjson` writes for SYNTHETIC agent homes: one hello, commands, health,
// report (7 days, then 1 day), fleet, history and error line. The Swift contract tests decode every line and check
// that no field is lost. Nothing here comes from a real machine: the Claude Code home, tap spool, registry row and
// Claude app session records are written below, and the Codex home is the adapter's own test fixture (credential
// decoys excluded). Regenerate with:
//   bun apps/macos/scripts/make-stream-fixture.ts > apps/macos/Fixtures/stream-v1.ndjson
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const MAIN = join(REPO, "apps", "cli", "src", "main.ts");
const SID = "5e1f0c2a-3b4d-4e6f-8a9b-0c1d2e3f4a5b";
const CWD = "/Users/you/code/a-rather-long-project-name-for-layout-checks";
const FAKE_ROOT = "/tmp/signalbox-synthetic";
const FAKE_PID = 4242;
/** The Claude app's ids for the synthetic session (merged with the transcript) and two sessions it alone lists. */
const APP_MERGED = "local_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const APP_ONLY = "local_1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const APP_ARCHIVED = "local_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

/** Runs the CLI against freshly written synthetic homes and returns the normalized NDJSON lines. */
export async function captureSyntheticStream(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "signalbox-stream-fixture-"));
  const home = join(root, "home");
  const claude = join(home, ".claude");
  const project = join(claude, "projects", CWD.replaceAll("/", "-"));
  const spool = join(home, "Library", "Application Support", "signalbox", "spool");
  const appSessions = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const appAccount = join(appSessions, "acct-synthetic", "org-synthetic");
  for (const dir of [project, join(claude, "sessions"), spool, appAccount, join(root, "bin"), join(root, "tmp")]) mkdirSync(dir, { recursive: true });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const response = (id: string, msAgo: number, model: string) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: SID,
      cwd: CWD,
      gitBranch: "main",
      entrypoint: "cli",
      version: "2.1.300",
      timestamp: ago(msAgo),
      requestId: `req_${id}`,
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "synthetic" }],
        usage: { input_tokens: 1200, output_tokens: 640, cache_read_input_tokens: 48000, cache_creation_input_tokens: 2400 },
      },
    });
  // Two priced responses and one from a model with no price row (it must land in unpricedModels), the title
  // lines the history reads (a generated one, then one set with /rename: the custom one wins), and a cost-state
  // row, Claude Code's own ledger (the report's reconciliation and the history's ledgerUsd).
  const titles = [
    JSON.stringify({ type: "ai-title", aiTitle: "Synthetic generated title", sessionId: SID }),
    JSON.stringify({ type: "custom-title", customTitle: "Synthetic session title", sessionId: SID }),
  ];
  const costState = JSON.stringify({
    type: "cost-state",
    sessionId: SID,
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 2400, outputTokens: 1280, cacheReadInputTokens: 96000, cacheCreationInputTokens: 4800, costUSD: 0.9 },
    },
  });
  writeFileSync(
    join(project, `${SID}.jsonl`),
    `${[response("msg_S1", 3_600_000, "claude-opus-5-5"), ...titles, response("msg_S2", 1_800_000, "claude-opus-5-5"), costState, response("msg_S3", 900_000, "claude-experimental-x")].join("\n")}\n`,
  );
  // A live session: the registry row points at this script's pid, which is alive while the CLI runs.
  writeFileSync(
    join(claude, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status: "waiting", waitingFor: "permission prompt", kind: "interactive", entrypoint: "cli", name: "synthetic session" }),
  );
  // A tap spool reading: official context and two plan limits. claude-opus-5-5 runs a 1M window, which is
  // the one window with a known Claude Code auto-compact point, so the fixture carries autoCompactAtPercent.
  writeFileSync(
    join(spool, `${SID}.json`),
    JSON.stringify({
      v: 1,
      seq: 3,
      agent: "claude-code",
      sessionId: SID,
      writtenAt: ago(60_000),
      event: "session.measure",
      usage: {
        context: { tokens: 51_600, window: 1_000_000, percent: 5.2 },
        rateLimits: [
          { kind: "five_hour", percentUsed: 37, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
          { kind: "seven_day", percentUsed: 64, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        ],
        cost: { usd: 1.23 },
      },
    }),
  );
  // The Claude app's session list: a record for the transcript's session (its title wins), one for a session whose
  // transcript isn't here, and an archived one. Fields the CLI must drop (a summary, prompt suggestions) are written
  // too, with synthetic text, so a leak would show up in the fixture.
  const appRecord = (id: string, extra: Record<string, unknown>) =>
    writeFileSync(
      join(appAccount, `${id}.json`),
      JSON.stringify({
        sessionId: id,
        cwd: CWD,
        originCwd: CWD,
        model: "claude-opus-5-5",
        effort: "high",
        titleSource: "auto",
        isArchived: false,
        postTurnSummary: { text: "synthetic summary that must never be read into the stream" },
        promptSuggestion: "synthetic suggestion",
        ...extra,
      }),
    );
  const msAgo = (ms: number) => Date.now() - ms;
  appRecord(APP_MERGED, { cliSessionId: SID, title: "Synthetic app title", titleSource: "user", createdAt: msAgo(3_700_000), lastActivityAt: msAgo(900_000) });
  appRecord(APP_ONLY, { title: "Synthetic app-only session", createdAt: msAgo(86_400_000), lastActivityAt: msAgo(82_800_000), transcriptUnavailable: true });
  appRecord(APP_ARCHIVED, { title: "Synthetic archived session", createdAt: msAgo(2 * 86_400_000), lastActivityAt: msAgo(2 * 86_400_000 - 600_000), isArchived: true, effort: undefined });

  // A made-up custom command and skill, so the commands line carries custom entries (names and descriptions only).
  mkdirSync(join(claude, "commands"), { recursive: true });
  writeFileSync(join(claude, "commands", "release-notes.md"), "---\ndescription: Draft release notes from merged pull requests\n---\nsynthetic body\n");
  mkdirSync(join(claude, "skills", "pdf-tools"), { recursive: true });
  writeFileSync(join(claude, "skills", "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\ndescription: Fill, merge and split PDF files\n---\nsynthetic body\n");
  cpSync(join(REPO, "packages", "adapter-codex", "test", "fixtures", "codex-home"), join(home, ".codex"), {
    recursive: true,
    filter: (src) => !/auth/.test(src.slice(src.lastIndexOf("/") + 1)),
  });

  const proc = Bun.spawn([process.execPath, MAIN, "watch", "--ndjson"], {
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(home, ".codex"),
      SIGNALBOX_CLAUDE_APP_DIR: appSessions,
      SIGNALBOX_CLAUDE_BIN: "/nonexistent",
      SIGNALBOX_BIN_DIRS: "",
      PATH: join(root, "bin"),
      TMPDIR: join(root, "tmp"),
      TZ: "UTC",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  type Line = { type: string; days?: number; pid?: number; data?: unknown };
  const lines: string[] = [];
  const parsed: Line[] = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const text = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(text);
        parsed.push(JSON.parse(text) as Line);
      }
    }
  })();

  async function waitFor(pred: (l: Line) => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!parsed.some(pred)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${parsed.map((l) => l.type).join(",")}`);
      await Bun.sleep(20);
    }
  }

  try {
    await waitFor((l) => l.type === "commands", "commands");
    await waitFor((l) => l.type === "fleet", "fleet");
    await waitFor((l) => l.type === "health", "health");
    await waitFor((l) => l.type === "report" && l.days === 7, "report 7");
    // The history follows the first fleet and report.
    await waitFor((l) => l.type === "history", "history");
    proc.stdin.write(`${JSON.stringify({ cmd: "report", days: 1 })}\n`);
    proc.stdin.flush();
    await waitFor((l) => l.type === "report" && l.days === 1, "report 1");
    proc.stdin.write(`${JSON.stringify({ cmd: "bogus" })}\n`);
    proc.stdin.flush();
    await waitFor((l) => l.type === "error", "error");
    proc.stdin.end();
    await proc.exited;
    await pump;
  } finally {
    proc.kill();
    rmSync(root, { recursive: true, force: true });
  }

  // One line of each kind, in arrival order, with the temp paths and pids made stable.
  const seen = new Set<string>();
  const keep = lines.filter((text, i) => {
    const l = parsed[i]!;
    const key = l.type === "report" ? `report:${l.days}` : l.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out = keep.map((text) =>
    text
      .replaceAll(root, FAKE_ROOT)
      .replaceAll(`"pid":${proc.pid}`, `"pid":${FAKE_PID}`)
      .replaceAll(`"pid":${process.pid}`, `"pid":${FAKE_PID + 1}`),
  );
  return `${out.join("\n")}\n`;
}

if (import.meta.main) process.stdout.write(await captureSyntheticStream());
