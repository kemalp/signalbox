// A SYNTHETIC home for end-to-end runs of the CLI with the Claude app's session list: Claude Code transcripts for
// two of the app's records plus one session the app doesn't list, and the app's folder from the adapter's fixture
// (decoys and CANARY fields included). Nothing outside the temp dir is read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ARCHIVED,
  APP_CANARY,
  APP_LINKED,
  makeTreeRemovable,
  writeClaudeAppTree,
  type AppTree,
} from "../../../packages/adapter-claude/test/claude-app-fixture.ts";

export { APP_ARCHIVED, APP_CANARY, APP_GONE, APP_IDS, APP_LINKED, APP_TITLES } from "../../../packages/adapter-claude/test/claude-app-fixture.ts";

export const MAIN = join(import.meta.dir, "..", "src", "main.ts");
/** A transcript session the app doesn't list. */
export const TRANSCRIPT_ONLY = "c3c3c3c3-0000-4000-8000-000000000001";
export const APP_CWD = "/Users/you/code/app-project";

export interface AppHome {
  root: string;
  tree: AppTree;
  /** Env for the CLI: temp HOME and agent homes, SIGNALBOX_CLAUDE_APP_DIR at the synthetic list. */
  env: Record<string, string>;
  cleanup(): void;
}

export function makeAppHome(): AppHome {
  const root = mkdtempSync(join(tmpdir(), "signalbox-app-home-"));
  const home = join(root, "home");
  const claude = join(home, ".claude");
  const proj = join(claude, "projects", APP_CWD.replaceAll("/", "-"));
  for (const d of [proj, join(claude, "sessions"), join(home, ".codex"), join(root, "bin"), join(root, "tmp")]) mkdirSync(d, { recursive: true });
  const now = Date.now();
  const H = 3_600_000;
  const line = (sid: string, id: string, ms: number) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: sid,
      cwd: APP_CWD,
      version: "2.1.300",
      timestamp: new Date(ms).toISOString(),
      requestId: `req_${id}`,
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "synthetic" }],
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  const write = (sid: string, rows: string[]) => writeFileSync(join(proj, `${sid}.jsonl`), `${rows.join("\n")}\n`);
  write(APP_LINKED, [JSON.stringify({ type: "ai-title", aiTitle: "Generated linked title", sessionId: APP_LINKED }), line(APP_LINKED, "msg_L1", now - 5 * H), line(APP_LINKED, "msg_L2", now - 4 * H)]);
  write(APP_ARCHIVED, [JSON.stringify({ type: "custom-title", customTitle: "Transcript archived title", sessionId: APP_ARCHIVED }), line(APP_ARCHIVED, "msg_A1", now - 30 * H)]);
  write(TRANSCRIPT_ONLY, [JSON.stringify({ type: "custom-title", customTitle: "Terminal session", sessionId: TRANSCRIPT_ONLY }), line(TRANSCRIPT_ONLY, "msg_T1", now - 3 * H)]);
  const tree = writeClaudeAppTree(
    root,
    {
      linked: { createdAt: now - 6 * H, lastActivityAt: now - 2 * H },
      archived: { createdAt: now - 31 * H, lastActivityAt: now - 29 * H },
      gone: { createdAt: now - 80 * H, lastActivityAt: now - 70 * H },
      noCli: { createdAt: now - 10 * H, lastActivityAt: now - 9 * H },
    },
    { cwd: APP_CWD },
  );
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(home, ".codex"),
    SIGNALBOX_CLAUDE_APP_DIR: tree.base,
    SIGNALBOX_CLAUDE_BIN: "/nonexistent",
    SIGNALBOX_BIN_DIRS: "",
    PATH: join(root, "bin"),
    TMPDIR: join(root, "tmp"),
    TZ: "UTC",
  };
  return {
    root,
    tree,
    env,
    cleanup() {
      makeTreeRemovable(tree);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Runs the CLI once and collects its output. */
export async function runCli(args: string[], env: Record<string, string>): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

export { APP_CANARY as CANARY };
