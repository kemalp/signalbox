import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nodeIO, type CodexIO } from "../src/io.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const NOW = new Date("2026-10-09T12:00:00.000Z");
export const MARK = "SYNTHETIC-CONTENT-MARKER";

const id = (n: string) => `01a10000-0000-7000-8000-${n.padStart(12, "0")}`;
export const IDS = { A: id("a"), B: id("b"), C: id("c"), D: id("d"), E: id("e"), F: id("f"), G: id("10"), H: id("11") };

export const PATHS = {
  A: `sessions/2026/10/09/rollout-2026-10-09T11-00-00-${IDS.A}.jsonl`,
  B: `sessions/2026/10/09/rollout-2026-10-09T11-40-00-${IDS.B}.jsonl`,
  C: `sessions/2026/10/09/rollout-2026-10-09T12-50-00-${IDS.C}.jsonl`,
  D: `sessions/2026/09/01/rollout-2026-09-01T09-00-00-${IDS.D}.jsonl`,
  E: `archived_sessions/rollout-2026-08-15T10-00-00-${IDS.E}.jsonl`,
  F: `sessions/2026/10/08/rollout-2026-10-08T08-00-00-${IDS.F}.jsonl.zst`,
  authDecoy: "sessions/2026/10/09/rollout-2026-10-09T09-00-00-auth-decoy.jsonl",
  auth: "auth.json",
};

const MTIMES: Record<keyof typeof PATHS, string> = {
  A: "2026-10-09T10:32:01Z",
  B: "2026-10-09T10:40:04Z",
  C: "2026-10-09T11:58:00Z", // 2 minutes before NOW: the open turn counts as busy
  D: "2026-09-01T08:01:01Z",
  E: "2026-08-15T09:00:03Z",
  F: "2026-10-08T07:00:03Z", // 29 hours before NOW: not active
  authDecoy: "2026-10-09T11:59:00Z",
  auth: "2026-10-09T11:59:00Z",
};

export interface TempHome {
  home: string;
  path(key: keyof typeof PATHS): string;
  cleanup(): void;
}

/** Copies the synthetic codex home to a temp dir, adds a .jsonl.zst rollout, pins mtimes and locks the decoys (mode 000). */
export function makeHome(): TempHome {
  const home = mkdtempSync(join(tmpdir(), "signalbox-codex-"));
  cpSync(join(FIXTURES, "codex-home"), home, { recursive: true });
  const zstTarget = join(home, PATHS.F);
  mkdirSync(join(zstTarget, ".."), { recursive: true });
  const src = readFileSync(join(FIXTURES, "zst-source", basename(PATHS.F).replace(/\.zst$/, "")));
  writeFileSync(zstTarget, Bun.zstdCompressSync(src));
  for (const [key, iso] of Object.entries(MTIMES)) {
    const t = new Date(iso);
    utimesSync(join(home, PATHS[key as keyof typeof PATHS]), t, t);
  }
  chmodSync(join(home, PATHS.auth), 0o000);
  chmodSync(join(home, PATHS.authDecoy), 0o000);
  return {
    home,
    path: (key) => join(home, PATHS[key]),
    cleanup() {
      try {
        chmodSync(join(home, PATHS.auth), 0o600);
        chmodSync(join(home, PATHS.authDecoy), 0o600);
      } catch {}
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Wraps the real IO and records every path that reaches it. */
export function spyIO(): { io: CodexIO; reads: string[]; stats: string[] } {
  const reads: string[] = [];
  const stats: string[] = [];
  const io: CodexIO = {
    readFile(p) {
      reads.push(p);
      return nodeIO.readFile(p);
    },
    stat(p) {
      stats.push(p);
      return nodeIO.stat(p);
    },
    readdir: (p) => nodeIO.readdir(p),
  };
  return { io, reads, stats };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
