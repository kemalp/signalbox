// Per-transcript parse results, reused while a file's mtime and size are unchanged. Transcripts are
// append-only, so a long-running reader (the app's `watch` helper, `serve`) re-reads only the files
// that grew instead of every file in the window on every tick.

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface Entry<T> extends FileStamp {
  value: T;
  usedAt: number;
}

/** An entry not used for this long is dropped, e.g. the extra files of a 30-day window after switching back to 7. */
export const FILE_CACHE_IDLE_MS = 10 * 60_000;

export class FileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly idleMs = FILE_CACHE_IDLE_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The value stored for `path` if it was stored for exactly this stamp. */
  get(path: string, stamp: FileStamp): T | undefined {
    const e = this.entries.get(path);
    if (!e || e.mtimeMs !== stamp.mtimeMs || e.size !== stamp.size) return undefined;
    e.usedAt = this.clock();
    return e.value;
  }

  /**
   * Stores `value` under the stamp taken BEFORE the file was read: if the file grew while it was being
   * read, the next stat differs and the file is read again.
   */
  set(path: string, stamp: FileStamp, value: T): void {
    this.entries.set(path, { mtimeMs: stamp.mtimeMs, size: stamp.size, value, usedAt: this.clock() });
  }

  /** Drops entries idle for longer than `idleMs` (files that left every window, or no longer exist). */
  prune(): void {
    const cutoff = this.clock() - this.idleMs;
    for (const [k, e] of this.entries) if (e.usedAt < cutoff) this.entries.delete(k);
  }
}
