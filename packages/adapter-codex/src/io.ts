import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Minimal filesystem surface the adapter uses. Tests wrap it with a spy. */
export interface CodexIO {
  readFile(path: string): Promise<Uint8Array>;
  /** `undefined` when the path does not exist or cannot be stat'ed. */
  stat(path: string): Promise<FileStat | undefined>;
  /** Empty when the directory does not exist or cannot be listed. */
  readdir(path: string): Promise<DirEntry[]>;
  /** Bytes [start, start + length) of a file (fewer at its end). Optional: readers fall back to readFile. */
  readRange?(path: string, start: number, length: number): Promise<Uint8Array>;
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

// ~/.codex/auth.json holds the ChatGPT/API login. Anything that smells like a credential is off limits.
const FORBIDDEN_NAME = /auth|token|credential|oauth/i;

/** True for file names the adapter must never open (checked on the basename only). */
export function isForbiddenName(path: string): boolean {
  return FORBIDDEN_NAME.test(basename(path));
}

export class ForbiddenFileError extends Error {
  constructor(path: string) {
    super(`refusing to read credential-like file: ${basename(path)}`);
    this.name = "ForbiddenFileError";
  }
}

/** codexHome = explicit option, else $CODEX_HOME, else ~/.codex. */
export function resolveCodexHome(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  const raw = explicit?.trim() || env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export const nodeIO: CodexIO = {
  async readFile(path) {
    if (isForbiddenName(path)) throw new ForbiddenFileError(path);
    return new Uint8Array(await readFile(path));
  },
  async stat(path) {
    try {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  },
  async readRange(path, start, length) {
    if (isForbiddenName(path)) throw new ForbiddenFileError(path);
    const fh = await open(path, "r");
    try {
      const buf = new Uint8Array(Math.max(0, length));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
  async readdir(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
      if (e.isFile()) out.push({ name: e.name, kind: "file" });
      else if (e.isDirectory()) out.push({ name: e.name, kind: "dir" });
      else if (e.isSymbolicLink()) {
        const s = await nodeIO.stat(join(path, e.name));
        out.push({ name: e.name, kind: s?.isFile ? "file" : s?.isDirectory ? "dir" : "other" });
      } else out.push({ name: e.name, kind: "other" });
    }
    return out;
  },
};

/** Wraps any CodexIO so a forbidden name is rejected before the underlying reader is ever called. */
export function guardIO(io: CodexIO): CodexIO {
  return {
    readFile(path) {
      if (isForbiddenName(path)) return Promise.reject(new ForbiddenFileError(path));
      return io.readFile(path);
    },
    stat: (path) => io.stat(path),
    readdir: (path) => io.readdir(path),
    async readRange(path, start, length) {
      if (isForbiddenName(path)) throw new ForbiddenFileError(path);
      if (io.readRange) return io.readRange(path, start, length);
      return (await io.readFile(path)).subarray(start, start + length);
    },
  };
}

const decoder = new TextDecoder();

/** Reads a rollout as text, transparently inflating `.jsonl.zst`. */
export async function readText(io: CodexIO, path: string): Promise<string> {
  const bytes = await io.readFile(path);
  if (path.endsWith(".zst")) return decoder.decode(Bun.zstdDecompressSync(bytes));
  return decoder.decode(bytes);
}
