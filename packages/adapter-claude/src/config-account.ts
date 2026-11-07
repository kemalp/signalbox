// The terminal login of a Claude Code config dir, read-only (Stability "internal": an undocumented file).
//
// Claude Code's global config (~/.claude.json, or <dir>/.claude.json when CLAUDE_CONFIG_DIR is set) records the
// signed-in account under `oauthAccount`. The same file also holds the email address, names, MCP server settings
// (which can carry API keys) and per-project state, so the reader is an allow-list:
//   - a regular file only (lstat, then fstat on a descriptor opened with O_NOFOLLOW), at most 32 MiB;
//   - only the top-level `oauthAccount` object is cut out of the text and parsed (the rest of the file, MCP settings
//     included, is never parsed into objects); of it, `accountUuid` and `organizationUuid` are hashed into an account
//     id (accountEvidence) and everything else, the email and names included, is dropped at once;
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

/**
 * The two ids of `oauthAccount`, hashed; undefined when the file names no account. Throws on a file that doesn't look
 * whole (caught mid-write) or an `oauthAccount` that isn't valid JSON.
 */
export function loginFromConfigText(text: string): AccountEvidence | undefined {
  if (!/^\s*\{/.test(text) || !/\}\s*$/.test(text)) throw new SyntaxError("unparsable");
  const raw = topLevelObjectText(text, "oauthAccount");
  if (raw === undefined) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new SyntaxError("unparsable");
  }
  return isObj(o) ? accountEvidence(o.accountUuid, o.organizationUuid, "config-login", "inferred") : undefined;
}

/**
 * The raw text of the root object's `key` member when it is an object, found by scanning (strings, escapes and nesting
 * respected) instead of parsing the whole document; undefined when there is none. Throws a SyntaxError when the text
 * is cut off (a string, the member or the root object never closes), so a file caught mid-write never reads as
 * "signed out".
 */
export function topLevelObjectText(text: string, key: string): string | undefined {
  const n = text.length;
  const cut = () => new SyntaxError("unparsable");
  /** Index just past the string that opens at `j`. */
  const past = (j: number): number => {
    for (j++; j < n; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === '"') return j + 1;
    }
    throw cut();
  };
  let depth = 0;
  for (let i = 0; i < n; ) {
    const c = text[i];
    if (c === '"') {
      const end = past(i);
      if (depth === 1) {
        let k = end;
        while (k < n && /\s/.test(text[k]!)) k++;
        if (text[k] === ":") {
          let name: unknown;
          try {
            name = JSON.parse(text.slice(i, end));
          } catch {
            throw cut();
          }
          if (name === key) {
            let v = k + 1;
            while (v < n && /\s/.test(text[v]!)) v++;
            if (v >= n) throw cut();
            if (text[v] !== "{") return undefined;
            let d = 0;
            for (let j = v; j < n; ) {
              const ch = text[j];
              if (ch === '"') {
                j = past(j);
                continue;
              }
              if (ch === "{" || ch === "[") d++;
              else if (ch === "}" || ch === "]") {
                d--;
                if (d === 0) return text.slice(v, j + 1);
              }
              j++;
            }
            throw cut();
          }
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  if (depth !== 0) throw cut();
  return undefined;
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

/**
 * Reads logins, reusing a file's result while its mtime and size are unchanged. A read that fails in passing (caught
 * mid-write, unparsable, unreadable) answers with the file's last good login, if any, so accounts don't blink.
 */
export class ConfigLoginReader {
  private readonly cache = new FileCache<LoginRead>();
  private readonly lastGood = new Map<string, LoginRead>();

  constructor(private readonly fs: LoginFs = defaultLoginFs()) {}

  async read(path: string): Promise<LoginRead> {
    const r = await this.readOnce(path);
    if (r.state === "ok") this.lastGood.set(path, r);
    else if (r.state === "missing") this.lastGood.delete(path);
    else if (r.state === "unparsable" || r.state === "unreadable" || r.state === "not-a-file") return this.lastGood.get(path) ?? r;
    return r;
  }

  private async readOnce(path: string): Promise<LoginRead> {
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
