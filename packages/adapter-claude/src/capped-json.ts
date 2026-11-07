// Small allow-listed reads of files that hold more than Signalbox may keep (Claude Code's global config and its
// settings files): a regular file only (lstat, then fstat on a descriptor opened with O_NOFOLLOW), a size cap, the
// result reused while the file's mtime and size are unchanged, and the last good result kept through a read that
// fails in passing (a file caught mid-write), for a few seconds, so what it shows doesn't blink. A lasting failure (a
// symlink, a file over the cap, no permission) is reported at once. `parse` gets the text and must keep only what it
// needs; it throws on a file it can't read.
import { errorCode, nodeClaudeAppFs, type ClaudeAppFs } from "./claude-app.ts";
import { FileCache } from "./file-cache.ts";

export type CappedRead<T> =
  | { path: string; state: "ok"; value?: T }
  | { path: string; state: "missing" | "not-a-file" | "too-large" | "unparsable" | "changed" }
  | { path: string; state: "unreadable"; code: string };

export type CappedFs = Pick<ClaudeAppFs, "lstat" | "readFile">;

export const CONFIG_TRACE_ENV = "SIGNALBOX_CLAUDE_CONFIG_TRACE";

/** The real calls, traced to stderr when $SIGNALBOX_CLAUDE_CONFIG_TRACE is 1 (paths only). */
export function defaultConfigFs(env: Record<string, string | undefined> = process.env): ClaudeAppFs {
  if (env[CONFIG_TRACE_ENV] !== "1") return nodeClaudeAppFs;
  const log = (line: string) => process.stderr.write(`signalbox claude-config: ${line}\n`);
  return {
    readdir: (dir) => (log(`readdir ${dir}`), nodeClaudeAppFs.readdir(dir)),
    lstat: (path) => (log(`lstat ${path}`), nodeClaudeAppFs.lstat(path)),
    readFile: (path, max) => (log(`open ${path}`), nodeClaudeAppFs.readFile(path, max)),
  };
}

/** How long a file that keeps failing in passing is answered with its last good result. */
export const CAPPED_GRACE_MS = 10_000;

export interface CappedJsonReaderOptions {
  graceMs?: number;
  now?: () => number;
}

export class CappedJsonReader<T> {
  private readonly cache = new FileCache<CappedRead<T>>();
  private readonly lastGood = new Map<string, CappedRead<T>>();
  /** When each path's current run of passing failures began. */
  private readonly failingSince = new Map<string, number>();
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly parse: (text: string) => T | undefined,
    private readonly maxBytes: number,
    private readonly fs: CappedFs = defaultConfigFs(),
    opts: CappedJsonReaderOptions = {},
  ) {
    this.graceMs = opts.graceMs ?? CAPPED_GRACE_MS;
    this.now = opts.now ?? Date.now;
  }

  async read(path: string): Promise<CappedRead<T>> {
    const r = await this.readOnce(path);
    if (r.state === "unparsable" || r.state === "changed") {
      const good = this.lastGood.get(path);
      const since = this.failingSince.get(path) ?? this.now();
      this.failingSince.set(path, since);
      return good && this.now() - since < this.graceMs ? good : r;
    }
    this.failingSince.delete(path);
    if (r.state === "ok") this.lastGood.set(path, r);
    else this.lastGood.delete(path);
    return r;
  }

  private async readOnce(path: string): Promise<CappedRead<T>> {
    let st: { isFile(): boolean; size: number; mtimeMs: number };
    try {
      st = await this.fs.lstat(path);
    } catch (err) {
      const code = errorCode(err);
      return code === "ENOENT" ? { path, state: "missing" } : { path, state: "unreadable", code };
    }
    if (!st.isFile()) return { path, state: "not-a-file" };
    if (st.size > this.maxBytes) return { path, state: "too-large" };
    const stamp = { mtimeMs: st.mtimeMs, size: st.size };
    const hit = this.cache.get(path, stamp);
    if (hit) return hit;
    let text: string | undefined;
    try {
      text = await this.fs.readFile(path, this.maxBytes);
    } catch (err) {
      const code = errorCode(err);
      // Removed or replaced between the lstat and the open: the next read sees what's there now.
      return code === "ENOENT" ? { path, state: "changed" } : { path, state: "unreadable", code };
    }
    // Not a regular file once open, or it grew past the cap (or while being read): try again next time.
    if (text === undefined) return { path, state: "changed" };
    let out: CappedRead<T>;
    try {
      const value = this.parse(text);
      out = value === undefined ? { path, state: "ok" } : { path, state: "ok", value };
    } catch {
      out = { path, state: "unparsable" };
    }
    this.cache.set(path, stamp, out);
    return out;
  }
}
