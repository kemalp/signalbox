import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Minimal filesystem surface the adapter uses. Tests wrap it with a spy. */
export interface DshIO {
  /** Bytes [start, start + length) of a file (fewer at its end). */
  readRange(path: string, start: number, length: number): Promise<Uint8Array>;
  /** Follows symbolic links. `undefined` when the path does not exist or cannot be stat'ed. */
  stat(path: string): Promise<FileStat | undefined>;
  /** Never follows a symbolic link: one is neither a file nor a directory here. */
  lstat(path: string): Promise<FileStat | undefined>;
  /** Empty when the directory does not exist or cannot be listed. A symbolic link is "other". */
  readdir(path: string): Promise<DirEntry[]>;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
  size: number;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

/** `session.jsonl[.zstd]` is generation 0; `session.vN.jsonl[.zstd]` is generation N. */
const LOG_NAME = /^session(?:\.v(\d{1,4}))?\.jsonl(\.zstd)?$/;

export interface LogName {
  generation: number;
  compressed: boolean;
}

export function parseLogName(name: string): LogName | undefined {
  const m = LOG_NAME.exec(name);
  return m ? { generation: m[1] === undefined ? 0 : Number(m[1]), compressed: m[2] !== undefined } : undefined;
}

/**
 * True only for `<project dir>/<session dir>/session[.vN].jsonl[.zstd]` under the sessions root: the one kind
 * of file this adapter opens. The harness home also holds `.credentials.yaml`, settings files with provider
 * keys and attachment blobs; none of them can match.
 */
export function isSessionLogPath(sessionsDir: string, path: string): boolean {
  const rel = relative(sessionsDir, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.length === 3 && parts.every((p) => p !== "" && p !== "." && p !== "..") && parseLogName(parts[2]!) !== undefined;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class ForbiddenFileError extends Error {
  constructor(path: string) {
    super(`refusing to read a file that is not a session log: ${path.split(sep).pop() ?? ""}`);
    this.name = "ForbiddenFileError";
  }
}

/** dshHome = explicit option, else $DSH_HOME (unless blank), else ~/.dsh: the harness's own rule. */
export function resolveDshHome(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME;
  const raw = explicit?.trim() || (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), ".dsh"));
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

function toStat(s: { isFile(): boolean; isDirectory(): boolean; mtimeMs: number; size: number }): FileStat {
  return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
}

export const nodeIO: DshIO = {
  async readRange(path, start, length) {
    const fh = await open(path, "r");
    try {
      const buf = new Uint8Array(Math.max(0, length));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  },
  async stat(path) {
    try {
      return toStat(await stat(path));
    } catch {
      return undefined;
    }
  },
  async lstat(path) {
    try {
      return toStat(await lstat(path));
    } catch {
      return undefined;
    }
  },
  async readdir(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.map((e) => ({ name: e.name, kind: e.isFile() ? "file" : e.isDirectory() ? "dir" : "other" }) as DirEntry);
  },
};

/**
 * Wraps any DshIO so that nothing outside the adapter's allow-list reaches it: reads only of session logs, and
 * directory listings and lstat only inside the sessions root. `stat` (which follows links) answers for the home
 * and the sessions root alone, so a home on another volume still works.
 */
export function guardIO(io: DshIO, home: string, sessionsDir: string): DshIO {
  return {
    readRange(path, start, length) {
      if (!isSessionLogPath(sessionsDir, path)) return Promise.reject(new ForbiddenFileError(path));
      return io.readRange(path, start, length);
    },
    stat(path) {
      return path === home || path === sessionsDir ? io.stat(path) : Promise.resolve(undefined);
    },
    lstat(path) {
      return isInside(sessionsDir, path) ? io.lstat(path) : Promise.resolve(undefined);
    },
    readdir(path) {
      return isInside(sessionsDir, path) ? io.readdir(path) : Promise.resolve([]);
    },
  };
}
