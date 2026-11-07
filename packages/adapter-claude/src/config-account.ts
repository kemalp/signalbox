// The terminal login of a Claude Code config dir, read-only (Stability "internal": an undocumented file).
//
// Claude Code's global config (~/.claude.json, or <dir>/.claude.json when CLAUDE_CONFIG_DIR is set) records the
// signed-in account under `oauthAccount`. The same file also holds the email address, names, MCP server settings
// (which can carry API keys) and per-project state, so the reader is an allow-list:
//   - a regular file only (lstat, then fstat on a descriptor opened with O_NOFOLLOW), at most 32 MiB;
//   - `oauthAccount.accountUuid` and `oauthAccount.organizationUuid` are hashed into an account id right after
//     JSON.parse (accountEvidence); everything else, the email and names included, is dropped at once;
//   - nothing is ever written.
// SIGNALBOX_CLAUDE_CONFIG_TRACE=1 logs every path the reader stats or opens to stderr, to audit a run.
import { accountEvidence, type AccountEvidence } from "../../core/src/index.ts";
import { errorCode, nodeClaudeAppFs, type ClaudeAppFs } from "./claude-app.ts";
import { FileCache } from "./file-cache.ts";
import { isObj } from "./util.ts";

export const CONFIG_LOGIN_MAX_BYTES = 32 * 1024 * 1024;
export const CONFIG_TRACE_ENV = "SIGNALBOX_CLAUDE_CONFIG_TRACE";

/** What one read found. "ok" without `evidence`: the file exists but names no signed-in account. */
export type LoginRead =
  | { path: string; state: "ok"; evidence?: AccountEvidence }
  | { path: string; state: "missing" | "not-a-file" | "too-large" | "unparsable" }
  | { path: string; state: "unreadable"; code: string };

/** The two ids of `oauthAccount`, hashed; undefined when the text names no account. The parse is dropped here. */
export function loginFromConfigText(text: string): AccountEvidence | undefined {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    throw new SyntaxError("unparsable");
  }
  const o = isObj(d) && isObj(d.oauthAccount) ? d.oauthAccount : undefined;
  return o ? accountEvidence(o.accountUuid, o.organizationUuid, "config-login", "inferred") : undefined;
}

export type LoginFs = Pick<ClaudeAppFs, "lstat" | "readFile">;

/** The real calls, traced to stderr when $SIGNALBOX_CLAUDE_CONFIG_TRACE is 1. */
export function defaultLoginFs(env: Record<string, string | undefined> = process.env): LoginFs {
  if (env[CONFIG_TRACE_ENV] !== "1") return nodeClaudeAppFs;
  const log = (line: string) => process.stderr.write(`signalbox claude-config: ${line}\n`);
  return {
    lstat: (path) => (log(`lstat ${path}`), nodeClaudeAppFs.lstat(path)),
    readFile: (path, max) => (log(`open ${path}`), nodeClaudeAppFs.readFile(path, max)),
  };
}

/** Reads logins, reusing a file's result while its mtime and size are unchanged. */
export class ConfigLoginReader {
  private readonly cache = new FileCache<LoginRead>();

  constructor(private readonly fs: LoginFs = defaultLoginFs()) {}

  async read(path: string): Promise<LoginRead> {
    let st: { isFile(): boolean; size: number; mtimeMs: number };
    try {
      st = await this.fs.lstat(path);
    } catch (err) {
      const code = errorCode(err);
      return code === "ENOENT" ? { path, state: "missing" } : { path, state: "unreadable", code };
    }
    if (!st.isFile()) return { path, state: "not-a-file" };
    if (st.size > CONFIG_LOGIN_MAX_BYTES) return { path, state: "too-large" };
    const stamp = { mtimeMs: st.mtimeMs, size: st.size };
    const hit = this.cache.get(path, stamp);
    if (hit) return hit;
    let text: string | undefined;
    try {
      text = await this.fs.readFile(path, CONFIG_LOGIN_MAX_BYTES);
    } catch (err) {
      return { path, state: "unreadable", code: errorCode(err) };
    }
    // Not a regular file once open, or it grew past the cap (or while being read): try again next time.
    if (text === undefined) return { path, state: "not-a-file" };
    let out: LoginRead;
    try {
      const evidence = loginFromConfigText(text);
      out = evidence ? { path, state: "ok", evidence } : { path, state: "ok" };
    } catch {
      out = { path, state: "unparsable" };
    }
    this.cache.set(path, stamp, out);
    return out;
  }
}
