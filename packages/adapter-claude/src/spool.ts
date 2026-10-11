// TapSpool v1 files written by the signalbox-tap mod (preview). The mod's fs API cannot rename,
// so a reader can see a half-written file: parse failures are expected and fall back to the last
// good copy of that file.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContextSnapshot, LimitSnapshot, TapSpool } from "../../core/src/index.ts";
import { isObj, num, str, toIso } from "./util.ts";

const SPOOL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** Validates the parts of a TapSpool this adapter relies on. Unknown keys are ignored. */
export function parseSpool(text: string): TapSpool | undefined {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(d) || d.v !== 1) return undefined;
  if (d.agent !== undefined && d.agent !== "claude-code") return undefined;
  const sessionId = str(d.sessionId);
  const writtenAt = toIso(d.writtenAt);
  const seq = num(d.seq);
  if (!sessionId || !writtenAt || seq === undefined) return undefined;
  if (d.event !== "session.start" && d.event !== "session.measure" && d.event !== "session.end") return undefined;
  const spool: TapSpool = { v: 1, seq, agent: "claude-code", sessionId, writtenAt, event: d.event };
  if (isObj(d.usage)) spool.usage = d.usage as TapSpool["usage"];
  return spool;
}

export interface SpoolRead {
  dirExists: boolean;
  spools: TapSpool[];
  /** Files that failed to parse this round (half-written or foreign). */
  failed: number;
  /** Of those, how many were answered from the last good copy. */
  reused: number;
}

/** Reads every spool file; `cache` keeps the last good parse per path across calls. */
export async function readSpoolDir(dir: string, cache: Map<string, TapSpool>): Promise<SpoolRead> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    cache.clear();
    return { dirExists: false, spools: [], failed: 0, reused: 0 };
  }
  const present = new Set<string>();
  const spools: TapSpool[] = [];
  let failed = 0;
  let reused = 0;
  for (const name of names.filter((n) => SPOOL_FILE.test(n)).sort()) {
    const path = join(dir, name);
    present.add(path);
    let text: string | undefined;
    try {
      text = await Bun.file(path).text();
    } catch {
      text = undefined;
    }
    const parsed = text === undefined ? undefined : parseSpool(text);
    if (parsed) {
      cache.set(path, parsed);
      spools.push(parsed);
      continue;
    }
    failed++;
    const last = cache.get(path);
    if (last) {
      reused++;
      spools.push(last);
    }
  }
  for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
  return { dirExists: true, spools, failed, reused };
}

const LABELS: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 7 * 24 * 60 };

/** Freshest reading per kind across all sessions (limits are account-wide). Kinds kept verbatim. */
export function limitsFromSpools(spools: TapSpool[]): LimitSnapshot[] {
  const best = new Map<string, { snap: LimitSnapshot; at: number; seq: number }>();
  for (const sp of spools) {
    const list = sp.usage?.rateLimits;
    if (!Array.isArray(list)) continue;
    const at = Date.parse(sp.writtenAt);
    for (const rl of list as unknown[]) {
      if (!isObj(rl)) continue;
      const kind = str(rl.kind);
      const used = num(rl.percentUsed);
      if (!kind || used === undefined) continue;
      const snap: LimitSnapshot = {
        agent: "claude-code",
        kind,
        usedPercent: used,
        observedAt: sp.writtenAt,
        sessionId: sp.sessionId,
        source: "spool",
      };
      const label = LABELS[kind];
      if (label) snap.label = label;
      const win = WINDOW_MINUTES[kind];
      if (win) snap.windowMinutes = win;
      const resets = toIso(rl.resetsAt);
      if (resets) snap.resetsAt = resets;
      const prev = best.get(kind);
      if (!prev || at > prev.at || (at === prev.at && sp.seq > prev.seq)) best.set(kind, { snap, at, seq: sp.seq });
    }
  }
  return [...best.values()].map((b) => b.snap).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Official context reading from a spool, when it carries one. */
export function contextFromSpool(sp: TapSpool): ContextSnapshot | undefined {
  const c = sp.usage?.context;
  if (!isObj(c)) return undefined;
  const tokens = num(c.tokens);
  if (tokens === undefined) return undefined;
  const snap: ContextSnapshot = {
    agent: "claude-code",
    sessionId: sp.sessionId,
    tokens,
    observedAt: sp.writtenAt,
    quality: "official",
    source: "spool",
  };
  const window = num(c.window);
  if (window !== undefined && window > 0) {
    snap.window = window;
    snap.windowSource = "agent";
  }
  const percent = num(c.percent);
  if (percent !== undefined) snap.percent = percent;
  else if (snap.window) snap.percent = (tokens / snap.window) * 100;
  return snap;
}
