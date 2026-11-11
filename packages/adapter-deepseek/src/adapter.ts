import { join } from "node:path";
import {
  chooseTitle,
  projectOf,
  type Adapter,
  type AdapterHealth,
  type CompactionEvent,
  type ContextSnapshot,
  type HistoryOptions,
  type HistorySession,
  type ScanOptions,
  type SessionInfo,
  type SessionStatus,
  type UsageRecord,
} from "@signalbox/core";
import { guardIO, nodeIO, parseLogName, resolveDshHome, type DshIO } from "./io.ts";
import { AGENT, CHECKED_GENERATION, SessionLogFold, type SessionLogSummary } from "./session-log.ts";
import { inflateFrames } from "./zstd.ts";

export interface DeepseekAdapterOptions {
  /** Defaults to $DSH_HOME, then ~/.dsh. */
  dshHome?: string;
  now?: () => Date;
  /** Filesystem seam for tests. Every call still goes through the session-log allow-list. */
  io?: DshIO;
  /** How often watchSessions checks the logs. Default 2000 ms. */
  watchPollMs?: number;
}

export interface DeepseekAdapter extends Adapter {
  readonly dshHome: string;
  /**
   * Polls the logs of the sessions the last listSessions found active, and each project folder for new
   * sessions: stat only, plus a read of the frames appended since the last look. Fires when a turn opens or
   * closes, an approval is asked for or decided, or a new session appears.
   */
  watchSessions(onChange: () => void): () => void;
  /** Sessions the user started, with their titles and every record of the session, delegated sessions included. */
  listHistory(opts?: HistoryOptions): Promise<HistorySession[]>;
  /** What the last read of the logs had to leave out, as sentences without a full stop (the CLI adds it). */
  scanIssues(): string[];
}

/** One session's log: the highest generation in its folder. */
export interface LogFile {
  path: string;
  /** The session folder's name: the session id, made safe for a path. */
  dirName: string;
  generation: number;
  compressed: boolean;
  mtimeMs: number;
  size: number;
}

const HOUR = 3_600_000;
/** listSessions / readContext consider logs written in this window. */
const ACTIVE_WINDOW_MS = 24 * HOUR;
/** An open turn counts as busy only while the session's logs keep being written. */
const BUSY_FRESH_MS = 5 * 60_000;
const CACHE_MAX = 2000;
/** A log is read in windows of this many bytes, so a long one is never in memory whole. */
const READ_WINDOW = 8 * 1024 * 1024;
/** A single frame (one append batch) larger than this is not read. */
const MAX_FRAME_WINDOW = 256 * 1024 * 1024;
/** Bytes kept from the end of what was folded, to tell that a grown file is still the same log. */
const TAIL_CHECK = 32;
/** A new session folder is looked at this many times for its log before it is given up on. */
const NEW_LOG_TRIES = 30;
const HEALTH = "deepseek-harness:session-logs";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** Bytes folded so far: the end of the last complete frame (or line, in a plain log). */
  scannedTo: number;
  tail: Uint8Array;
  fold: SessionLogFold;
  summary: SessionLogSummary;
  damaged: boolean;
}

/** A log with where its usage rolls up to. */
interface Linked {
  file: LogFile;
  s: SessionLogSummary;
  /** The session the user started: this one, or the root of the chain that delegated it. */
  rootId: string;
  kind: "main" | "subagent" | "workflow";
}

const decoder = new TextDecoder();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The last TAIL_CHECK bytes of `prev` followed by `added`. */
function tailOf(prev: Uint8Array, added: Uint8Array): Uint8Array {
  if (added.length >= TAIL_CHECK) return added.slice(added.length - TAIL_CHECK);
  const joined = new Uint8Array(prev.length + added.length);
  joined.set(prev);
  joined.set(added, prev.length);
  return joined.slice(Math.max(0, joined.length - TAIL_CHECK));
}

function statusKey(s: SessionLogSummary): string {
  return `${s.turnOpen ? "open" : "closed"}:${s.pendingApprovals > 0 ? "asked" : ""}`;
}

export function createDeepseekAdapter(opts: DeepseekAdapterOptions = {}): DeepseekAdapter {
  const home = resolveDshHome(opts.dshHome);
  const sessionsDir = join(home, "sessions");
  const now = opts.now ?? (() => new Date());
  const io = guardIO(opts.io ?? nodeIO, home, sessionsDir);

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<void>>();
  /** Root-attributed copies of a delegated session's records, per summary. */
  const rerooted = new WeakMap<SessionLogSummary, { rootId: string; kind: string; records: UsageRecord[] }>();
  /** The logs the last listSessions found active (sessions the user started, and what they delegated). */
  let activeFiles = new Map<string, LogFile>();
  let lastIssues: string[] = [];

  /** The log of one session folder: the highest generation, as the harness itself picks. */
  async function pickLog(sessionDir: string, dirName: string): Promise<LogFile | undefined> {
    let best: { name: string; generation: number; compressed: boolean } | undefined;
    for (const e of await io.readdir(sessionDir)) {
      if (e.kind !== "file") continue;
      const n = parseLogName(e.name);
      if (!n) continue;
      if (!best || n.generation > best.generation || (n.generation === best.generation && n.compressed && !best.compressed)) best = { name: e.name, ...n };
    }
    if (!best) return undefined;
    const path = join(sessionDir, best.name);
    const st = await io.lstat(path);
    if (!st?.isFile) return undefined;
    return { path, dirName, generation: best.generation, compressed: best.compressed, mtimeMs: st.mtimeMs, size: st.size };
  }

  /** sessions/<project folder>/<session folder>/session[.vN].jsonl[.zstd], one log per session, sorted by path. */
  async function listLogs(): Promise<LogFile[]> {
    const out: LogFile[] = [];
    for (const project of await io.readdir(sessionsDir)) {
      if (project.kind !== "dir") continue;
      const projectDir = join(sessionsDir, project.name);
      for (const session of await io.readdir(projectDir)) {
        if (session.kind !== "dir") continue;
        const f = await pickLog(join(projectDir, session.name), session.name);
        if (f) out.push(f);
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Folds what `f` holds beyond what the cache has already folded (all of it, the first time). */
  async function readInto(f: LogFile, hit: CacheEntry | undefined): Promise<void> {
    let entry = hit && !hit.damaged && hit.scannedTo > 0 && f.size >= hit.scannedTo ? hit : undefined;
    if (entry) {
      // The harness only ever appends to a log. If the bytes just before our mark changed, this is another file.
      const from = entry.scannedTo - entry.tail.length;
      const tail = await io.readRange(f.path, from, entry.tail.length);
      if (!sameBytes(tail, entry.tail)) entry = undefined;
    }
    const fold = entry?.fold ?? new SessionLogFold(f.path, f.dirName);
    let scannedTo = entry?.scannedTo ?? 0;
    let tail = entry?.tail ?? new Uint8Array(0);
    let damaged = false;
    let window = READ_WINDOW;
    while (scannedTo < f.size) {
      const want = Math.min(window, f.size - scannedTo);
      const chunk = await io.readRange(f.path, scannedTo, want);
      if (chunk.length === 0) break;
      let consumed: number;
      if (f.compressed) {
        const r = inflateFrames(chunk, (plain) => fold.pushText(decoder.decode(plain)));
        consumed = r.consumed;
        damaged = r.corrupt;
      } else {
        // A plain log: whole lines only. The last line may still be being written.
        consumed = chunk.lastIndexOf(10) + 1;
        if (consumed > 0) fold.pushText(decoder.decode(chunk.subarray(0, consumed)));
      }
      if (consumed > 0) {
        tail = tailOf(tail, chunk.subarray(0, consumed));
        scannedTo += consumed;
      }
      if (damaged) break;
      if (consumed === 0) {
        // No complete frame or line in the window: the tail of a write in progress, or one frame larger than it.
        if (chunk.length < want || scannedTo + want >= f.size || window >= MAX_FRAME_WINDOW) break;
        window *= 2;
      }
    }
    const summary = fold.summary();
    if (damaged) summary.damaged = true;
    cache.delete(f.path);
    cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, scannedTo, tail, fold, summary, damaged });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }

  /** The summary of a log as of `f`'s size and mtime; cached per file, and extended in place when the file grew. */
  async function foldFile(f: LogFile): Promise<SessionLogSummary | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const hit = cache.get(f.path);
      if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
        cache.delete(f.path);
        cache.set(f.path, hit);
        return hit.summary;
      }
      const running = inflight.get(f.path);
      if (running) {
        // Another caller is folding it, perhaps from an older stat: wait, then look again.
        await running;
        continue;
      }
      const job = readInto(f, hit)
        .catch(() => {
          cache.delete(f.path); // vanished or unreadable: nothing half-folded is kept
        })
        .finally(() => inflight.delete(f.path));
      inflight.set(f.path, job);
      await job;
      return cache.get(f.path)?.summary;
    }
    return cache.get(f.path)?.summary;
  }

  /** Summaries of the logs `keep` lets through, each with the session it rolls up to. */
  async function load(keep?: (f: LogFile) => boolean): Promise<Linked[]> {
    const loaded: Array<{ file: LogFile; s: SessionLogSummary }> = [];
    let unreadable = 0;
    let damaged = 0;
    for (const file of await listLogs()) {
      if (keep && !keep(file)) continue;
      const s = await foldFile(file);
      if (!s) {
        unreadable++;
        continue;
      }
      if (s.damaged) damaged++;
      loaded.push({ file, s });
    }
    // The CLI prints each as "<agent>: <issue>." so they carry neither the agent's name nor a full stop.
    const issues: string[] = [];
    if (unreadable) issues.push(`${unreadable} session ${unreadable === 1 ? "log" : "logs"} could not be read, so ${unreadable === 1 ? "its" : "their"} usage is missing`);
    if (damaged) issues.push(`${damaged} session ${damaged === 1 ? "log has" : "logs have"} a damaged frame, so the usage after it is missing`);
    lastIssues = issues;

    const byId = new Map<string, SessionLogSummary>();
    const workflowChildren = new Set<string>();
    for (const { s } of loaded) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
      for (const child of s.workflowChildIds) workflowChildren.add(child);
    }
    return loaded.map(({ file, s }) => {
      if (s.kind === "main") return { file, s, rootId: s.sessionId, kind: "main" };
      // Up the delegation chain as far as the loaded logs go; a parent that isn't loaded is taken as the root.
      let rootId = s.parentId ?? s.sessionId;
      const seen = new Set([s.sessionId]);
      for (let parent = byId.get(rootId); parent?.parentId && !seen.has(parent.sessionId); parent = byId.get(rootId)) {
        seen.add(parent.sessionId);
        rootId = parent.parentId;
      }
      return { file, s, rootId, kind: workflowChildren.has(s.sessionId) ? "workflow" : "subagent" };
    });
  }

  /** A log's records under the session they roll up to. Compaction calls stay auxiliary. */
  function recordsOf(l: Linked): UsageRecord[] {
    if (l.kind === "main") return l.s.records;
    const hit = rerooted.get(l.s);
    if (hit && hit.rootId === l.rootId && hit.kind === l.kind) return hit.records;
    const records = l.s.records.map((r) => ({ ...r, sessionId: l.rootId, kind: r.kind === "auxiliary" ? r.kind : l.kind }));
    rerooted.set(l.s, { rootId: l.rootId, kind: l.kind, records });
    return records;
  }

  /**
   * Records by id, the earliest copy winning. A fork's inherited records are already left out by the fold; this
   * covers a log copied by hand, or one whose id repeats for any other reason.
   */
  function dedup(linked: readonly Linked[]): Map<string, { t: number; r: UsageRecord }> {
    const first = new Map<string, { t: number; r: UsageRecord }>();
    for (const l of linked) {
      for (const r of recordsOf(l)) {
        const t = Date.parse(r.ts);
        const prev = first.get(r.id);
        if (!prev || t < prev.t) first.set(r.id, { t, r });
      }
    }
    return first;
  }

  function inRange(t: number, sinceMs: number | undefined, untilMs: number | undefined): boolean {
    if (!Number.isFinite(t)) return false;
    if (sinceMs !== undefined && t < sinceMs) return false;
    if (untilMs !== undefined && t >= untilMs) return false;
    return true;
  }

  /** A log last written before `since` holds nothing in the range. */
  function tooOld(f: LogFile, sinceMs: number | undefined): boolean {
    return sinceMs !== undefined && f.mtimeMs < sinceMs - HOUR;
  }

  const adapter: DeepseekAdapter = {
    id: AGENT,
    displayName: "DeepSeek Harness",
    dshHome: home,

    async detect() {
      return Boolean((await io.stat(sessionsDir))?.isDirectory);
    },

    async health(): Promise<AdapterHealth[]> {
      // No home: the harness isn't installed here. That is nothing to report, and no failing source to count.
      const homeStat = await io.stat(home);
      if (!homeStat?.isDirectory) return [];
      const files = await listLogs();
      if (files.length === 0) return [{ name: HEALTH, stability: "internal", ok: false, detail: `no session logs under ${sessionsDir}` }];
      const t = now().getTime();
      const active = files.filter((f) => t - f.mtimeMs <= ACTIVE_WINDOW_MS).length;
      let newest = files[0]!;
      for (const f of files) if (f.mtimeMs > newest.mtimeMs) newest = f;
      const s = await foldFile(newest);

      const parts = [`${files.length} session ${files.length === 1 ? "log" : "logs"} (${active} written in the last 24h)`];
      let ok = true;
      if (!s) {
        ok = false;
        parts.push("newest log could not be read");
      } else {
        parts.push(`newest: format v${s.header.version ?? newest.generation}, ${s.stats.records} ${s.stats.records === 1 ? "response" : "responses"} with usage`);
        if (s.stats.usageLines >= 3 && s.stats.records === 0 && s.stats.inherited === 0) {
          ok = false;
          parts.push("usage lines present but none parsed; the log format may have changed");
        }
        if (s.damaged) parts.push("a damaged frame; what follows it was not read");
        const unknown = Object.keys(s.stats.unknownTypes);
        if (unknown.length) parts.push(`unknown event types passed over: ${unknown.join(", ")}`);
        if (s.stats.badLines) parts.push(`${s.stats.badLines} unparseable ${s.stats.badLines === 1 ? "line" : "lines"}`);
      }
      const older = files.filter((f) => f.generation < CHECKED_GENERATION).length;
      if (older) parts.push(`${older} in an older format, read as far as it matches`);
      const newer = files.filter((f) => f.generation > CHECKED_GENERATION).length;
      if (newer) parts.push(`${newer} in a format newer than v${CHECKED_GENERATION}, the one this reader was checked against`);
      return [{ name: HEALTH, stability: "internal", ok, detail: parts.join("; ") }];
    },

    // opts.wholeSessions is ignored: the harness keeps no cost ledger to reconcile against.
    async *scanUsage(opts: ScanOptions): AsyncIterable<UsageRecord> {
      const sinceMs = opts.since?.getTime();
      const untilMs = opts.until?.getTime();
      const first = dedup(await load((f) => !tooOld(f, sinceMs)));
      const out = [...first.values()].filter(({ t }) => inRange(t, sinceMs, untilMs));
      out.sort((a, b) => a.t - b.t || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
      for (const { r } of out) yield r;
    },

    async listSessions(): Promise<SessionInfo[]> {
      const t = now().getTime();
      const linked = await load((f) => t - f.mtimeMs <= ACTIVE_WINDOW_MS);
      // What a session's delegated sessions add to it: their newest write, and an approval one of them waits for.
      const below = new Map<string, { mtimeMs: number; lastMs: number; asked: boolean; files: LogFile[] }>();
      for (const l of linked) {
        if (l.kind === "main") continue;
        const b = below.get(l.rootId) ?? { mtimeMs: 0, lastMs: -Infinity, asked: false, files: [] };
        b.mtimeMs = Math.max(b.mtimeMs, l.file.mtimeMs);
        if (l.s.lastTs) b.lastMs = Math.max(b.lastMs, Date.parse(l.s.lastTs));
        if (l.s.pendingApprovals > 0) b.asked = true;
        b.files.push(l.file);
        below.set(l.rootId, b);
      }
      const out: SessionInfo[] = [];
      const active = new Map<string, LogFile>();
      for (const l of linked) {
        if (l.kind !== "main") continue;
        const s = l.s;
        const kids = below.get(s.sessionId);
        active.set(l.file.path, l.file);
        for (const f of kids?.files ?? []) active.set(f.path, f);
        const fresh = t - Math.max(l.file.mtimeMs, kids?.mtimeMs ?? 0) <= BUSY_FRESH_MS;
        const asked = s.turnOpen && (s.pendingApprovals > 0 || kids?.asked === true);
        const status: SessionStatus = asked ? "waiting" : s.turnOpen ? (fresh ? "busy" : "unknown") : s.statusChangedAt ? "idle" : "unknown";
        const info: SessionInfo = { agent: AGENT, sessionId: s.sessionId, status, source: "session-log" };
        const cwd = s.cwd ?? s.header.cwd;
        if (cwd) info.cwd = cwd;
        if (s.title) info.name = s.title;
        if (s.statusChangedAt && status !== "unknown") info.statusSince = s.statusChangedAt;
        // The harness logs an approval request for a tool call; Claude Code's label for the same thing.
        if (status === "waiting") info.waitingFor = "permission prompt";
        if (s.model) info.model = s.model;
        if (s.effort) info.effort = s.effort;
        const startedAt = s.header.createdAt ?? s.firstTs;
        if (startedAt) info.startedAt = startedAt;
        const lastMs = Math.max(s.lastTs ? Date.parse(s.lastTs) : -Infinity, kids?.lastMs ?? -Infinity);
        info.lastActivity = new Date(Number.isFinite(lastMs) ? lastMs : l.file.mtimeMs).toISOString();
        out.push(info);
      }
      out.sort((a, b) => Date.parse(b.lastActivity ?? "") - Date.parse(a.lastActivity ?? "") || a.sessionId.localeCompare(b.sessionId));
      activeFiles = active;
      return out;
    },

    watchSessions(onChange: () => void): () => void {
      const seen = new Map<string, { mtimeMs: number; size: number; key: string }>();
      /** Per project folder: its mtime and the session folders already known in it. */
      const projects = new Map<string, { mtimeMs: number; sessions: Set<string> }>();
      /** New session folders whose log had not been published yet. */
      const awaited = new Map<string, { dirName: string; tries: number }>();
      let baseline = true;
      let running = false;
      let stopped = false;

      /** Logs of sessions that appeared since the last check. A project folder's mtime moves when one is added. */
      const newLogs = async (): Promise<LogFile[]> => {
        const found: LogFile[] = [];
        for (const p of await io.readdir(sessionsDir)) {
          if (p.kind !== "dir") continue;
          const dir = join(sessionsDir, p.name);
          const st = await io.lstat(dir);
          if (!st?.isDirectory) continue;
          const known = projects.get(dir);
          if (known && known.mtimeMs === st.mtimeMs) continue;
          const sessions = new Set<string>();
          for (const s of await io.readdir(dir)) {
            if (s.kind !== "dir") continue;
            sessions.add(s.name);
            if (!baseline && !known?.sessions.has(s.name)) awaited.set(join(dir, s.name), { dirName: s.name, tries: 0 });
          }
          projects.set(dir, { mtimeMs: st.mtimeMs, sessions });
        }
        for (const [sessionDir, a] of awaited) {
          const f = await pickLog(sessionDir, a.dirName);
          if (f) found.push(f);
          if (f || ++a.tries >= NEW_LOG_TRIES) awaited.delete(sessionDir);
        }
        return found;
      };

      const check = async () => {
        if (running || stopped) return;
        running = true;
        try {
          const targets = new Map<string, { file: LogFile; isNew: boolean }>();
          for (const f of await newLogs()) targets.set(f.path, { file: f, isNew: true });
          for (const [path, f] of activeFiles) {
            if (targets.has(path)) continue;
            const st = await io.lstat(path);
            if (st?.isFile) targets.set(path, { file: { ...f, mtimeMs: st.mtimeMs, size: st.size }, isNew: false });
          }
          let changed = false;
          for (const [path, { file, isNew }] of targets) {
            const prev = seen.get(path);
            if (prev && prev.mtimeMs === file.mtimeMs && prev.size === file.size) continue;
            const s = await foldFile(file);
            const key = s ? statusKey(s) : (prev?.key ?? "");
            seen.set(path, { mtimeMs: file.mtimeMs, size: file.size, key });
            if (baseline) continue;
            // New through a project folder: a new session. New only through listSessions: an older log, taken as a baseline.
            if (prev ? key !== prev.key : isNew) changed = true;
          }
          for (const path of seen.keys()) if (!targets.has(path)) seen.delete(path);
          baseline = false;
          if (changed && !stopped) onChange();
        } catch {
          // a vanished folder or file: the next check sees what is left
        } finally {
          running = false;
        }
      };
      void check();
      const timer = setInterval(() => void check(), opts.watchPollMs ?? 2000);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },

    async readContext(): Promise<ContextSnapshot[]> {
      const t = now().getTime();
      const out: ContextSnapshot[] = [];
      for (const l of await load((f) => t - f.mtimeMs <= ACTIVE_WINDOW_MS)) {
        if (l.kind !== "main" || !l.s.context) continue;
        const { ts, tokens, window } = l.s.context;
        const c: ContextSnapshot = { agent: AGENT, sessionId: l.s.sessionId, tokens, observedAt: ts, quality: "estimated", source: "session-log:assistant/message" };
        if (window) {
          c.window = window;
          c.windowSource = "agent";
          c.percent = Math.round((tokens / window) * 1000) / 10;
        }
        out.push(c);
      }
      return out;
    },

    async readCompactions(opts: ScanOptions): Promise<CompactionEvent[]> {
      const sinceMs = opts.since?.getTime();
      const untilMs = opts.until?.getTime();
      const out: CompactionEvent[] = [];
      for (const l of await load((f) => !tooOld(f, sinceMs))) {
        if (l.kind !== "main") continue;
        for (const c of l.s.compactions) if (inRange(Date.parse(c.ts), sinceMs, untilMs)) out.push(c);
      }
      return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    },

    // Every log is folded (cached per file), so a session's delegated logs count even when its own is older;
    // `since` filters whole sessions afterwards.
    async listHistory(opts: HistoryOptions = {}): Promise<HistorySession[]> {
      const sinceMs = opts.since?.getTime() ?? -Infinity;
      const linked = await load();
      const records = new Map<string, UsageRecord[]>();
      for (const { r } of dedup(linked).values()) {
        const list = records.get(r.sessionId) ?? [];
        list.push(r);
        records.set(r.sessionId, list);
      }
      const below = new Map<string, Linked[]>();
      for (const l of linked) {
        if (l.kind === "main") continue;
        const list = below.get(l.rootId) ?? [];
        list.push(l);
        below.set(l.rootId, list);
      }
      const out: HistorySession[] = [];
      for (const l of linked) {
        if (l.kind !== "main") continue;
        const s = l.s;
        const kids = below.get(s.sessionId) ?? [];
        let firstMs = Infinity;
        let lastMs = -Infinity;
        for (const x of [s, ...kids.map((k) => k.s)]) {
          for (const ts of [x.header.createdAt, x.firstTs]) {
            const at = ts ? Date.parse(ts) : NaN;
            if (Number.isFinite(at)) firstMs = Math.min(firstMs, at);
          }
          const at = x.lastTs ? Date.parse(x.lastTs) : NaN;
          if (Number.isFinite(at)) lastMs = Math.max(lastMs, at);
        }
        if (!Number.isFinite(lastMs)) lastMs = l.file.mtimeMs;
        if (!Number.isFinite(firstMs)) firstMs = lastMs;
        lastMs = Math.max(lastMs, firstMs);
        if (lastMs < sinceMs) continue;
        const recs = (records.get(s.sessionId) ?? []).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const h: HistorySession = {
          agent: AGENT,
          sessionId: s.sessionId,
          ...chooseTitle(s.titleSource === "custom" ? { custom: s.title } : { ai: s.title }),
          startedAt: new Date(firstMs).toISOString(),
          lastActivityAt: new Date(lastMs).toISOString(),
          records: recs,
          compactions: s.compactions.length,
          subagentFiles: kids.filter((k) => k.kind === "subagent").length,
          workflowRuns: s.workflowRuns + kids.reduce((n, k) => n + k.s.workflowRuns, 0),
          transcriptPath: l.file.path,
        };
        const project = projectOf(recs) ?? s.header.cwd ?? s.cwd;
        if (project) h.project = project;
        if (recs.length === 0 && s.model) h.model = s.model;
        if (s.effort) h.effort = s.effort;
        // No resume command: the harness has no one command that reopens a session in every one of its apps.
        out.push(h);
      }
      return out;
    },

    scanIssues(): string[] {
      return [...lastIssues];
    },
  };
  return adapter;
}
