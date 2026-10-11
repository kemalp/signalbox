// Change signals for a directory of small files (the session registry), for status pushes between
// polls. fs.watch first: on macOS it is FSEvents, measured at ~12 ms from write to event on the
// internal disk and on an external APFS volume alike. When fs.watch can't start (the dir doesn't
// exist yet, an unsupported filesystem) or fails later, a poll of names, mtimes and sizes takes over
// and switches back once the dir can be watched. Only names passing `accept` are ever stat'ed, and
// nothing is opened.
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DirWatchOptions {
  /** Only changes to names passing this filter count. An event without a name always counts. */
  accept(name: string): boolean;
  /** Poll interval while fs.watch is unavailable. Default 2000 ms. */
  pollMs?: number;
  /** "poll" never uses fs.watch (tests, filesystems where events don't arrive). Default "auto". */
  mode?: "auto" | "poll";
}

export type DirWatchMode = "fs.watch" | "poll" | "closed";

export interface DirWatch {
  readonly mode: DirWatchMode;
  close(): void;
}

export const DEFAULT_POLL_MS = 2000;

/** Calls `onChange` (possibly several times per change, possibly spuriously) when an accepted file in `dir` is created, written or removed. */
export function watchDir(dir: string, onChange: () => void, opts: DirWatchOptions): DirWatch {
  return new DirWatcher(dir, onChange, opts);
}

class DirWatcher implements DirWatch {
  private fsw?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  /** Last poll's view of the dir; `null` = not taken yet, `undefined` = the dir was missing. */
  private sig: string | undefined | null = null;
  private closed = false;
  private readonly pollMs: number;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly opts: DirWatchOptions,
  ) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    if (opts.mode === "poll" || !this.tryWatch()) this.startPoll();
  }

  get mode(): DirWatchMode {
    return this.closed ? "closed" : this.fsw ? "fs.watch" : "poll";
  }

  close(): void {
    this.closed = true;
    this.fsw?.close();
    this.fsw = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    if (this.closed) return;
    try {
      this.onChange();
    } catch {
      // the listener's problem; keep watching
    }
  }

  private tryWatch(): boolean {
    let w: FSWatcher;
    try {
      w = watch(this.dir, { persistent: false }, (_event, name) => {
        if (name === null || name === undefined || this.opts.accept(String(name))) this.fire();
      });
    } catch {
      return false;
    }
    w.on("error", () => {
      w.close();
      if (this.fsw !== w) return;
      this.fsw = undefined;
      this.sig = null;
      this.startPoll();
      this.fire();
    });
    this.fsw = w;
    return true;
  }

  private startPoll(): void {
    if (this.closed || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const sig = await signature(this.dir, this.opts.accept);
      if (this.closed) return;
      const changed = this.sig !== null && sig !== this.sig;
      this.sig = sig;
      if (changed) this.fire();
      if (sig !== undefined && this.opts.mode !== "poll" && this.tryWatch()) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } finally {
      this.polling = false;
    }
  }
}

/** "name:mtime:size" of every accepted file, sorted; undefined when the dir can't be listed. */
async function signature(dir: string, accept: (name: string) => boolean): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(accept).sort();
  } catch {
    return undefined;
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      const s = await stat(join(dir, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      // removed between readdir and stat: its absence shows in the names
    }
  }
  return parts.join("\n");
}
