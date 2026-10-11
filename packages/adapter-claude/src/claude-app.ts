// The Claude app's own session list, read-only (Stability "internal": the app's undocumented format).
//
// The app keeps one JSON record per Claude Code session it lists, at
//   ~/Library/Application Support/Claude/claude-code-sessions/<a>/<b>/local_<id>.json   (observed 2026-10, 63 files)
// Its parent folder also holds the app's login, cookie and token files, so the reader is an allow-list:
//   - it lists only <base>/<a>/<b>/ (real directories, never symlinks) and opens only files whose path relative to
//     the base matches CLAUDE_APP_PATH; never archived-sessions.idx, scheduled-tasks.json or deleted_* files;
//   - a file must be a regular file (lstat, then fstat on a descriptor opened with O_NOFOLLOW) of at most 1 MiB;
//   - the fields in KEPT are copied out right after JSON.parse and everything else is dropped: the app's
//     conversation summaries (postTurnSummary), prompt suggestions and drafts, errors, plans, tool settings, …
// Nothing is ever written there. SIGNALBOX_CLAUDE_APP_TRACE=1 logs every path the reader lists, stats or opens to
// stderr, to audit a run against the allow-list.
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeTitle, type AppSessionRecord, type ClaudeAppOffReason } from "../../core/src/index.ts";
import { FileCache } from "./file-cache.ts";
import { isObj, label, toIso, type Obj } from "./util.ts";

/** Points the reader at another directory (tests, a copied list). */
export const CLAUDE_APP_DIR_ENV = "SIGNALBOX_CLAUDE_APP_DIR";

/** $SIGNALBOX_CLAUDE_APP_DIR, else ~/Library/Application Support/Claude/claude-code-sessions. */
export function defaultClaudeAppDir(): string {
  return process.env[CLAUDE_APP_DIR_ENV] || join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
}

/** Whether the CLI reads the Claude app's list, and from where; `off` says why not. */
export type ClaudeAppSetting = { dir: string } | { off: ClaudeAppOffReason; detail: string };

/**
 * The reader's setting for this run. `enabled` false is --no-claude-app. The app's records describe sessions of
 * its own Claude Code config (~/.claude): with CLAUDE_CONFIG_DIR pointing anywhere else, every record would look
 * like a session whose transcript is gone (and an experiment's temporary config would pull in the real app's
 * titles), so the reader is off then, unless SIGNALBOX_CLAUDE_APP_DIR names a list explicitly.
 */
export function claudeAppSetting(enabled: boolean, env: Record<string, string | undefined> = process.env, home = homedir()): ClaudeAppSetting {
  if (!enabled) return { off: "flag", detail: "off (--no-claude-app): history lists sessions with a transcript only" };
  const explicit = env[CLAUDE_APP_DIR_ENV];
  if (explicit) return { dir: explicit };
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir && resolve(configDir) !== resolve(home, ".claude")) {
    return {
      off: "claude-config-dir",
      detail:
        `off: CLAUDE_CONFIG_DIR is ${configDir}, not ~/.claude, and the Claude app's list describes ~/.claude sessions; ` +
        `history lists sessions with a transcript only (set ${CLAUDE_APP_DIR_ENV} to read a list anyway)`,
    };
  }
  return { dir: join(home, "Library", "Application Support", "Claude", "claude-code-sessions") };
}

/** The only files opened: <a>/<b>/local_<id>.json relative to the base. */
export const CLAUDE_APP_PATH = /^[^/]+\/[^/]+\/local_[0-9A-Za-z-]+\.json$/;
export const CLAUDE_APP_MAX_BYTES = 1024 * 1024;

/** The record fields Signalbox keeps; the rest of a parsed record is dropped at once. */
export const KEPT = [
  "sessionId",
  "cliSessionId",
  "title",
  "titleSource",
  "cwd",
  "originCwd",
  "createdAt",
  "lastActivityAt",
  "isArchived",
  "model",
  "effort",
  "transcriptUnavailable",
] as const;
type Kept = Partial<Record<(typeof KEPT)[number], unknown>>;

/** The filesystem calls the reader makes, so tests can watch exactly what it touches. */
export interface ClaudeAppFs {
  readdir(dir: string): Promise<Dirent[]>;
  lstat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  /**
   * The file's text, or undefined when it is not a regular file or is larger than `maxBytes` once open. Must not
   * follow a symlink and must not block on a FIFO.
   */
  readFile(path: string, maxBytes: number): Promise<string | undefined>;
}

/** Opens with O_NOFOLLOW | O_NONBLOCK, checks the open descriptor, and reads at most `maxBytes`. */
async function readRegularFile(path: string, maxBytes: number): Promise<string | undefined> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
    // One byte more than the size: a file still being written shows up as longer, and is left for the next read.
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > st.size ? undefined : buf.toString("utf8", 0, n);
  } finally {
    await fh.close();
  }
}

export const nodeClaudeAppFs: ClaudeAppFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (path) => lstat(path),
  readFile: readRegularFile,
};

/**
 * Set to 1 for an audit trail: one stderr line per filesystem call the reader makes ("signalbox claude-app: readdir
 * <dir>", "… lstat <path>", "… open <path>"), so a run can be checked against the allow-list. Paths only.
 */
export const CLAUDE_APP_TRACE_ENV = "SIGNALBOX_CLAUDE_APP_TRACE";

/** `fs` with each call reported to `log` before it is made. */
export function tracedClaudeAppFs(fs: ClaudeAppFs, log: (line: string) => void): ClaudeAppFs {
  return {
    readdir: (dir) => (log(`readdir ${dir}`), fs.readdir(dir)),
    lstat: (path) => (log(`lstat ${path}`), fs.lstat(path)),
    readFile: (path, maxBytes) => (log(`open ${path}`), fs.readFile(path, maxBytes)),
  };
}

/** The real calls, traced to stderr when $SIGNALBOX_CLAUDE_APP_TRACE is 1. */
export function defaultClaudeAppFs(env: Record<string, string | undefined> = process.env): ClaudeAppFs {
  if (env[CLAUDE_APP_TRACE_ENV] !== "1") return nodeClaudeAppFs;
  return tracedClaudeAppFs(nodeClaudeAppFs, (line) => process.stderr.write(`signalbox claude-app: ${line}\n`));
}

export interface ClaudeAppRead {
  dir: string;
  dirExists: boolean;
  /** The base folder exists (or may) but could not be listed, e.g. "EACCES". Unset when listed or simply absent. */
  dirError?: string;
  records: AppSessionRecord[];
  /** Files whose path matched the allow-list. */
  candidates: number;
  /** Matching names that were not read: not a regular file (a symlink, a directory) or over the size cap. */
  skipped: number;
  /** Files that could not be read or parsed, or held no usable session id. */
  errors: number;
}

/** A shell-safe id, like core's resumeCommand check. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Model ids, including Claude Code's "[1m]"-style suffixes. */
const MODEL_ID = /^[A-Za-z0-9._:/[\]-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function safeId(v: unknown): string | undefined {
  return typeof v === "string" && SAFE_ID.test(v) ? v : undefined;
}

function absPath(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("/") && v.length <= 4096 && !CONTROL.test(v) ? v : undefined;
}

/** Epoch ms (or an ISO string) from 2000 up to a day from now; anything else is unknown. */
function appTime(v: unknown, now: number): string | undefined {
  const iso = toIso(v);
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return t >= Date.UTC(2000, 0, 1) && t <= now + 86_400_000 ? iso : undefined;
}

/** Copies the allow-listed fields out of a parsed record; the caller drops the record itself. */
export function keepFields(raw: unknown): Kept | undefined {
  if (!isObj(raw)) return undefined;
  const out: Kept = {};
  for (const k of KEPT) if (Object.hasOwn(raw, k)) out[k] = (raw as Obj)[k];
  return out;
}

/** One record's kept fields → an AppSessionRecord, or undefined without a usable app session id. */
export function toAppSession(k: Kept, now = Date.now()): AppSessionRecord | undefined {
  const appSessionId = safeId(k.sessionId);
  if (!appSessionId) return undefined;
  const r: AppSessionRecord = { agent: "claude-code", appSessionId };
  const agentSessionId = safeId(k.cliSessionId);
  if (agentSessionId) r.agentSessionId = agentSessionId;
  const title = sanitizeTitle(k.title);
  if (title) r.title = title;
  const titleSource = label(k.titleSource, 32);
  if (titleSource && /^[A-Za-z0-9_.-]+$/.test(titleSource)) r.titleSource = titleSource;
  const cwd = absPath(k.cwd);
  if (cwd) r.cwd = cwd;
  const originCwd = absPath(k.originCwd);
  if (originCwd) r.originCwd = originCwd;
  const createdAt = appTime(k.createdAt, now);
  if (createdAt) r.createdAt = createdAt;
  const lastActivityAt = appTime(k.lastActivityAt, now);
  if (lastActivityAt) r.lastActivityAt = lastActivityAt;
  if (typeof k.isArchived === "boolean") r.archived = k.isArchived;
  if (typeof k.model === "string" && MODEL_ID.test(k.model)) r.model = k.model;
  const effort = label(k.effort, 24);
  if (effort) r.effort = effort;
  if (typeof k.transcriptUnavailable === "boolean") r.transcriptUnavailable = k.transcriptUnavailable;
  return r;
}

/** Parses one record's text: JSON.parse, then the allow-list at once. */
export function parseAppSession(text: string, now = Date.now()): AppSessionRecord | undefined {
  let kept: Kept | undefined;
  try {
    kept = keepFields(JSON.parse(text));
  } catch {
    return undefined;
  }
  return kept ? toAppSession(kept, now) : undefined;
}

async function dirs(fs: ClaudeAppFs, dir: string): Promise<Dirent[] | undefined> {
  try {
    return await fs.readdir(dir);
  } catch {
    return undefined;
  }
}

/** The error code of a failed call ("EACCES", …), or "error" when it has none. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
}

export interface ClaudeAppReaderOptions {
  fs?: ClaudeAppFs;
  now?: () => number;
}

/** Reads the app's records, reusing a file's parse while its mtime and size are unchanged. */
export class ClaudeAppReader {
  private readonly fs: ClaudeAppFs;
  private readonly now: () => number;
  private readonly cache = new FileCache<AppSessionRecord | null>();

  constructor(
    readonly dir: string,
    opts: ClaudeAppReaderOptions = {},
  ) {
    this.fs = opts.fs ?? defaultClaudeAppFs();
    this.now = opts.now ?? Date.now;
  }

  /**
   * The allow-listed record paths (relative to the base); names only, nothing is opened. A missing base folder (no
   * Claude app) is `dirExists: false`; one that can't be listed also sets `dirError`.
   */
  async list(): Promise<{ dirExists: boolean; dirError?: string; paths: string[] }> {
    let top: Dirent[];
    try {
      top = await this.fs.readdir(this.dir);
    } catch (err) {
      const code = errorCode(err);
      return code === "ENOENT" ? { dirExists: false, paths: [] } : { dirExists: false, dirError: code, paths: [] };
    }
    const paths: string[] = [];
    for (const a of top) {
      if (!a.isDirectory()) continue; // a symlink to a directory is not followed
      for (const b of (await dirs(this.fs, join(this.dir, a.name))) ?? []) {
        if (!b.isDirectory()) continue;
        for (const f of (await dirs(this.fs, join(this.dir, a.name, b.name))) ?? []) {
          const rel = `${a.name}/${b.name}/${f.name}`;
          if (CLAUDE_APP_PATH.test(rel)) paths.push(rel);
        }
      }
    }
    paths.sort();
    return { dirExists: true, paths };
  }

  async read(): Promise<ClaudeAppRead> {
    const { dirExists, dirError, paths } = await this.list();
    const out: ClaudeAppRead = { dir: this.dir, dirExists, records: [], candidates: paths.length, skipped: 0, errors: 0 };
    if (dirError) out.dirError = dirError;
    this.cache.prune();
    const now = this.now();
    for (const rel of paths) {
      const path = join(this.dir, rel);
      let st: { isFile(): boolean; size: number; mtimeMs: number };
      try {
        st = await this.fs.lstat(path);
      } catch {
        out.errors++;
        continue;
      }
      if (!st.isFile() || st.size > CLAUDE_APP_MAX_BYTES) {
        out.skipped++;
        continue;
      }
      const stamp = { mtimeMs: st.mtimeMs, size: st.size };
      let rec = this.cache.get(path, stamp);
      if (rec === undefined) {
        let text: string | undefined;
        try {
          text = await this.fs.readFile(path, CLAUDE_APP_MAX_BYTES);
        } catch {
          out.errors++;
          continue;
        }
        if (text === undefined) {
          out.skipped++;
          continue;
        }
        rec = parseAppSession(text, now) ?? null;
        this.cache.set(path, stamp, rec);
      }
      if (rec) out.records.push(rec);
      else out.errors++;
    }
    return out;
  }
}
