import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { constants, createZstdCompress } from "node:zlib";
import { nodeIO, type DshIO } from "../src/io.ts";

export const FIXTURES = join(import.meta.dir, "fixtures", "logs");
export const NOW = new Date("2026-11-09T12:00:00.000Z");
export const MARK = "SYNTHETIC-CONTENT-MARKER";

const uuid = (n: string) => `d5a10000-0000-4000-8000-${n.padStart(12, "0")}`;
/** Sessions the user started are "session-<uuid>"; the ones they delegate are a bare uuid. */
export const IDS = {
  A: `session-${uuid("a")}`,
  B: uuid("b"),
  C: uuid("c"),
  D: `session-${uuid("d")}`,
  E: `session-${uuid("e")}`,
  F: `session-${uuid("f")}`,
  G: uuid("10"),
  H: `session-${uuid("11")}`,
};

const ALPHA = "--Users-test-alpha--";
const BETA = "--Users-test-beta--";

/** Where each fixture goes under sessions/, and when it was last written. */
const LOGS = {
  A: { src: "alpha-main.jsonl", rel: `${ALPHA}/${IDS.A}/session.v4.jsonl.zstd`, mtime: "2026-11-09T10:32:01Z" },
  B: { src: "alpha-subagent.jsonl", rel: `${ALPHA}/${IDS.B}/session.v4.jsonl.zstd`, mtime: "2026-11-09T10:31:01Z" },
  C: { src: "alpha-fork.jsonl", rel: `${ALPHA}/${IDS.C}/session.v4.jsonl.zstd`, mtime: "2026-11-09T10:10:31Z" },
  D: { src: "beta-waiting.jsonl", rel: `${BETA}/${IDS.D}/session.v4.jsonl.zstd`, mtime: "2026-11-09T11:58:00Z" }, // 2 minutes before NOW
  G: { src: "beta-workflow-agent.jsonl", rel: `${BETA}/${IDS.G}/session.v4.jsonl.zstd`, mtime: "2026-11-09T11:51:34Z" },
  E: { src: "alpha-old.jsonl", rel: `${ALPHA}/${IDS.E}/session.v4.jsonl.zstd`, mtime: "2026-09-01T08:01:05Z" },
  E0: { src: "alpha-old-generation-0.jsonl", rel: `${ALPHA}/${IDS.E}/session.jsonl.zstd`, mtime: "2026-09-01T08:01:05Z" },
  F: { src: "plain-busy.jsonl", rel: `_no-cwd/${IDS.F}/session.v4.jsonl`, mtime: "2026-11-09T11:58:30Z" }, // a plain log, mid-write
  H: { src: "beta-yesterday.jsonl", rel: `${BETA}/${IDS.H}/session.v4.jsonl.zstd`, mtime: "2026-11-08T07:00:01Z" }, // 29 hours before NOW
} as const;
export type LogKey = keyof typeof LOGS;

/** Files that must never be opened, stat'ed or listed: mode 000, so a read that got through would also fail loudly. */
const DECOYS = [".credentials.yaml", "settings.yaml.imported", "cordis.patch.yml", `sessions/${ALPHA}/${IDS.A}/credentials.json`, `sessions/${ALPHA}/token-notes.jsonl`];

/** One Zstandard frame, written the way the harness writes them: streamed, so no content size, and checksummed. */
export function frame(text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const z = createZstdCompress({ params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const parts: Buffer[] = [];
    z.on("data", (c: Buffer) => parts.push(c));
    z.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
    z.on("error", reject);
    z.end(text);
  });
}

/** A fixture's append batches (separated by a blank line) as one frame each, concatenated. */
export async function compressBatches(text: string): Promise<Uint8Array> {
  const frames = await Promise.all(
    text
      .split("\n\n")
      .filter((b) => b.trim().length > 0)
      .map((b) => frame(b.endsWith("\n") ? b : `${b}\n`)),
  );
  return concat(frames);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface TempHome {
  home: string;
  sessions: string;
  path(key: LogKey): string;
  decoys: string[];
  cleanup(): void;
}

/** Builds a synthetic harness home in a temp dir: the fixture logs as frames, pinned mtimes, decoys locked (mode 000). */
export async function makeHome(): Promise<TempHome> {
  const home = mkdtempSync(join(tmpdir(), "signalbox-dsh-"));
  const sessions = join(home, "sessions");
  for (const { src, rel, mtime } of Object.values(LOGS)) {
    const target = join(sessions, rel);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(join(FIXTURES, src), "utf8");
    // A plain log keeps its batches as they are, minus the separating blank lines.
    writeFileSync(target, rel.endsWith(".zstd") ? await compressBatches(text) : text.replace(/\n\n/g, "\n"));
    const t = new Date(mtime);
    utimesSync(target, t, t);
  }
  // What a real home also holds next to the logs.
  writeFileSync(join(sessions, ALPHA, IDS.A, "session.lock"), "");
  mkdirSync(join(sessions, ALPHA, "no-log-yet"));
  writeFileSync(join(sessions, ALPHA, "no-log-yet", "session.lock"), "");
  writeFileSync(join(sessions, "notes.txt"), `${MARK} not a project folder`);
  // A session folder that is a symbolic link is never followed.
  const outside = join(home, "outside", "linked-session");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "session.v4.jsonl"), `${JSON.stringify({ type: "session", version: 4, id: "linked", createdAt: 1 })}\n`);
  symlinkSync(outside, join(sessions, BETA, "linked-session"));
  const decoys = DECOYS.map((rel) => join(home, rel));
  for (const d of decoys) {
    writeFileSync(d, `${MARK} secret`);
    chmodSync(d, 0o000);
  }
  return {
    home,
    sessions,
    path: (key) => join(sessions, LOGS[key].rel),
    decoys,
    cleanup() {
      for (const d of decoys) {
        try {
          chmodSync(d, 0o600);
        } catch {}
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface Spy {
  io: DshIO;
  /** Every path a read reached, with the byte range asked for. */
  reads: Array<{ path: string; start: number; length: number }>;
  stats: string[];
  lists: string[];
}

/** Wraps the real IO and records every path that reaches it. */
export function spyIO(): Spy {
  const reads: Spy["reads"] = [];
  const stats: string[] = [];
  const lists: string[] = [];
  const io: DshIO = {
    readRange(p, start, length) {
      reads.push({ path: p, start, length });
      return nodeIO.readRange(p, start, length);
    },
    stat(p) {
      stats.push(p);
      return nodeIO.stat(p);
    },
    lstat(p) {
      stats.push(p);
      return nodeIO.lstat(p);
    },
    readdir(p) {
      lists.push(p);
      return nodeIO.readdir(p);
    },
  };
  return { io, reads, stats, lists };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** An event line as the harness writes it. */
export function ev(type: string, seq: number, time: number, data: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type, seq, time, data })}\n`;
}

export function headerLine(id: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "session", version: 4, id, createdAt: 1794218400000, cwd: "/Users/test/gamma", isSeeded: false, delegationDepth: 0, agentPreset: "standard", ...extra })}\n`;
}
