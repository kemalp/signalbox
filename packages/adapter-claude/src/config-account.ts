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
import { CappedJsonReader, CONFIG_TRACE_ENV, defaultConfigFs, type CappedFs } from "./capped-json.ts";
import { topLevelObjectText } from "./json-scan.ts";
import { isObj } from "./util.ts";

export { CONFIG_TRACE_ENV, topLevelObjectText };
export const CONFIG_LOGIN_MAX_BYTES = 32 * 1024 * 1024;

/** What one read found. "ok" without `evidence`: the file exists but names no signed-in account. */
export type LoginRead =
  | { path: string; state: "ok"; evidence?: AccountEvidence }
  | { path: string; state: "missing" | "not-a-file" | "too-large" | "unparsable" | "changed" }
  | { path: string; state: "unreadable"; code: string };

/**
 * The two ids of `oauthAccount`, hashed; undefined when the file names no account. Throws on a file that isn't valid
 * JSON (one caught mid-write, say).
 */
export function loginFromConfigText(text: string): AccountEvidence | undefined {
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

export type LoginFs = CappedFs;

/** The real calls, traced to stderr when $SIGNALBOX_CLAUDE_CONFIG_TRACE is 1. */
export const defaultLoginFs = defaultConfigFs;

/**
 * Reads logins, reusing a file's result while its mtime and size are unchanged. A read that fails in passing (a file
 * caught mid-write) answers with the file's last good login for a few seconds, so accounts don't blink.
 */
export class ConfigLoginReader {
  private readonly inner: CappedJsonReader<AccountEvidence>;

  constructor(fs: LoginFs = defaultLoginFs()) {
    this.inner = new CappedJsonReader(loginFromConfigText, CONFIG_LOGIN_MAX_BYTES, fs);
  }

  async read(path: string): Promise<LoginRead> {
    const r = await this.inner.read(path);
    if (r.state !== "ok") return r;
    return r.value ? { path, state: "ok", evidence: r.value } : { path, state: "ok" };
  }
}
