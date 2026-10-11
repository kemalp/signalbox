import { join } from "node:path";
import {
  chooseTitle,
  projectOf,
  resumeCommand,
  sanitizeTitle,
  type Adapter,
  type AdapterHealth,
  type CompactionEvent,
  type ContextSnapshot,
  type HistoryOptions,
  type HistorySession,
  type LimitSnapshot,
  type ScanOptions,
  type SessionInfo,
  type UsageRecord,
} from "@signalbox/core";
import { guardIO, isForbiddenName, nodeIO, readText, resolveCodexHome, type CodexIO } from "./io.ts";
import { isObj, isoTs, isRolloutName, parseRolloutName, str } from "./normalize.ts";
import { AGENT, lastTurnState, parseRollout, type RolloutSummary } from "./rollout.ts";

export interface CodexAdapterOptions {
  /** Defaults to $CODEX_HOME, then ~/.codex. */
  codexHome?: string;
  now?: () => Date;
  /** Filesystem seam for tests. Every read still goes through the credential-name guard. */
  io?: CodexIO;
  /** How often watchSessions checks the rollouts. Default 2000 ms. */
  watchPollMs?: number;
}

export interface CodexAdapter extends Adapter {
  readonly codexHome: string;
  /**
   * Polls the newest rollouts (today's and yesterday's date dirs, and every rollout the last
   * listSessions found active): stat only, plus a read of the bytes appended since the last look.
   * Fires when a turn opens or closes, or a new rollout appears.
   */
  watchSessions(onChange: () => void): () => void;
  /** Main-thread rollouts (archived ones too) with their session_index names and every record of the session. */
  listHistory(opts?: HistoryOptions): Promise<HistorySession[]>;
}

export interface RolloutFile {
  path: string;
  name: string;
  archived: boolean;
  mtimeMs: number;
  size: number;
  startMs?: number;
  threadId?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** listSessions / readContext consider rollouts written in this window. */
const ACTIVE_WINDOW_MS = DAY;
/** readLimits looks this far back: one weekly window plus a day. */
const LIMIT_LOOKBACK_MS = 8 * DAY;
/** An open turn counts as busy only while the rollout keeps being written. */
const BUSY_FRESH_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const CACHE_MAX = 2000;
/** watchSessions reads at most this much of what a rollout appended since its last look. */
const WATCH_READ_MAX = 256 * 1024;

const pad2 = (n: number) => String(n).padStart(2, "0");

export function createCodexAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  const home = resolveCodexHome(opts.codexHome);
  const now = opts.now ?? (() => new Date());
  const io = guardIO(opts.io ?? nodeIO);
  const sessionsDir = join(home, "sessions");
  const archivedDir = join(home, "archived_sessions");
  const indexPath = join(home, "session_index.jsonl");

  const cache = new Map<string, { mtimeMs: number; size: number; summary: RolloutSummary }>();
  const inflight = new Map<string, Promise<RolloutSummary | undefined>>();
  /** Earliest timestamp seen per record id over this adapter's lifetime, across every rollout parsed. */
  const earliest = new Map<string, number>();
  /** Main-thread rollouts the last listSessions found active; watchSessions checks them too. */
  let activePaths = new Set<string>();

  async function walk(dir: string, depth: number, archived: boolean, out: RolloutFile[]): Promise<void> {
    for (const e of await io.readdir(dir)) {
      const p = join(dir, e.name);
      if (e.kind === "dir") {
        if (depth > 0) await walk(p, depth - 1, archived, out);
        continue;
      }
      if (e.kind !== "file" || !isRolloutName(e.name) || isForbiddenName(e.name)) continue;
      const st = await io.stat(p);
      if (!st?.isFile) continue;
      const { startMs, threadId } = parseRolloutName(e.name);
      out.push({ path: p, name: e.name, archived, mtimeMs: st.mtimeMs, size: st.size, startMs, threadId });
    }
  }

  /** sessions/YYYY/MM/DD/rollout-*.jsonl[.zst] plus archived_sessions/, sorted by path. */
  async function listRollouts(): Promise<RolloutFile[]> {
    const out: RolloutFile[] = [];
    await walk(sessionsDir, 4, false, out);
    await walk(archivedDir, 4, true, out);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async function summarize(f: RolloutFile): Promise<RolloutSummary | undefined> {
    const hit = cache.get(f.path);
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
      cache.delete(f.path);
      cache.set(f.path, hit);
      return hit.summary;
    }
    const running = inflight.get(f.path);
    if (running) return running;
    const job = (async () => {
      try {
        const summary = parseRollout(await readText(io, f.path), f.path, f.threadId);
        cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, summary });
        for (const r of summary.records) {
          const t = Date.parse(r.ts);
          if (!((earliest.get(r.id) ?? Infinity) <= t)) earliest.set(r.id, t);
        }
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
        return summary;
      } catch {
        return undefined;
      } finally {
        inflight.delete(f.path);
      }
    })();
    inflight.set(f.path, job);
    return job;
  }

  /** session_index.jsonl: {id, thread_name, updated_at}; the newest line per id wins. */
  async function readIndex(): Promise<Map<string, { name?: string; updatedAt?: string }>> {
    const out = new Map<string, { name?: string; updatedAt?: string }>();
    let text: string;
    try {
      text = await readText(io, indexPath);
    } catch {
      return out;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(j)) continue;
      const id = str(j.id);
      if (!id) continue;
      const updatedAt = isoTs(j.updated_at);
      const prev = out.get(id);
      if (prev?.updatedAt && updatedAt && Date.parse(prev.updatedAt) > Date.parse(updatedAt)) continue;
      out.set(id, { name: str(j.thread_name) ?? prev?.name, updatedAt: updatedAt ?? prev?.updatedAt });
    }
    return out;
  }

  async function recentSummaries(windowMs: number, includeArchived: boolean): Promise<Array<{ file: RolloutFile; summary: RolloutSummary }>> {
    const cutoff = now().getTime() - windowMs;
    const out: Array<{ file: RolloutFile; summary: RolloutSummary }> = [];
    for (const file of await listRollouts()) {
      if (file.mtimeMs < cutoff || (file.archived && !includeArchived)) continue;
      const summary = await summarize(file);
      if (summary) out.push({ file, summary });
    }
    return out;
  }

  /** Plain (.jsonl) rollouts watchSessions checks: the date dirs of the last day (local and UTC) and the active ones. */
  async function watchTargets(): Promise<Map<string, { mtimeMs: number; size: number; inDateDir: boolean }>> {
    const t = now();
    const dirs = new Set<string>();
    for (const d of [t, new Date(t.getTime() - DAY)]) {
      dirs.add(join(sessionsDir, String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())));
      dirs.add(join(sessionsDir, String(d.getUTCFullYear()), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate())));
    }
    const inDateDir = new Set<string>();
    for (const dir of dirs) {
      for (const e of await io.readdir(dir)) {
        if (e.kind === "file" && isRolloutName(e.name) && !e.name.endsWith(".zst") && !isForbiddenName(e.name)) inDateDir.add(join(dir, e.name));
      }
    }
    const out = new Map<string, { mtimeMs: number; size: number; inDateDir: boolean }>();
    for (const p of new Set([...inDateDir, ...activePaths])) {
      if (isForbiddenName(p)) continue;
      const st = await io.stat(p);
      if (st?.isFile) out.set(p, { mtimeMs: st.mtimeMs, size: st.size, inDateDir: inDateDir.has(p) });
    }
    return out;
  }

  /** Turn state in bytes [from, size) of a rollout, and where the last complete line ends. */
  async function turnStateSince(path: string, from: number, size: number): Promise<{ open?: boolean; scannedTo: number }> {
    const start = Math.max(from, size - WATCH_READ_MAX);
    let bytes: Uint8Array;
    try {
      bytes = await io.readRange!(path, start, size - start);
    } catch {
      return { scannedTo: from };
    }
    const lastNl = bytes.lastIndexOf(10);
    if (lastNl === -1) return { scannedTo: from };
    return { open: lastTurnState(new TextDecoder().decode(bytes.subarray(0, lastNl))), scannedTo: start + lastNl + 1 };
  }

  function inRange(ts: string, sinceMs: number | undefined, untilMs: number | undefined): boolean {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return false;
    if (sinceMs !== undefined && t < sinceMs) return false;
    if (untilMs !== undefined && t >= untilMs) return false;
    return true;
  }

  /** Files that cannot hold anything in [since, until): written before `since`, or started after `until`. */
  function outOfRange(f: RolloutFile, sinceMs: number | undefined, untilMs: number | undefined): boolean {
    if (sinceMs !== undefined && f.mtimeMs < sinceMs - HOUR) return true;
    // File names carry local time; a day of slack covers any UTC offset.
    if (untilMs !== undefined && f.startMs !== undefined && f.startMs > untilMs + DAY) return true;
    return false;
  }

  const adapter: CodexAdapter = {
    id: AGENT,
    displayName: "Codex",
    codexHome: home,

    async detect() {
      const [s, a, i] = await Promise.all([io.stat(sessionsDir), io.stat(archivedDir), io.stat(indexPath)]);
      return Boolean(s?.isDirectory || a?.isDirectory || i?.isFile);
    },

    async health(): Promise<AdapterHealth[]> {
      const homeStat = await io.stat(home);
      if (!homeStat?.isDirectory) {
        return [{ name: "codex:rollouts", stability: "internal", ok: false, detail: `${home} not found` }];
      }
      const t = now().getTime();
      const files = await listRollouts();
      const archived = files.filter((f) => f.archived).length;
      const active = files.filter((f) => t - f.mtimeMs <= ACTIVE_WINDOW_MS).length;
      let newest: RolloutFile | undefined;
      for (const f of files) if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
      const s = newest ? await summarize(newest) : undefined;

      const parts = [`${files.length} rollout files (${archived} archived, ${active} written in the last 24h)`];
      let ok = files.length > 0;
      if (newest && !s) {
        ok = false;
        parts.push("newest rollout could not be read");
      } else if (s) {
        parts.push(`newest: ${s.stats.usageRecords} token_usage_record, ${s.stats.legacyRecords} legacy token_count rows`);
        if (s.stats.usageLines > 0 && s.records.length === 0) {
          ok = false;
          parts.push("usage lines present but none parsed; the rollout format may have changed");
        }
        const unknown = Object.keys(s.stats.unknownTypes);
        if (unknown.length) parts.push(`unknown line types passed through: ${unknown.join(", ")}`);
        if (s.stats.badLines) parts.push(`${s.stats.badLines} unparseable lines`);
      }
      if (!files.length) parts.push(`no rollouts under ${sessionsDir}`);

      const limits = await adapter.readLimits!();
      const freshest = limits.reduce<LimitSnapshot | undefined>((a, b) => (!a || Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a), undefined);

      const index = await io.stat(indexPath);
      return [
        { name: "codex:rollouts", stability: "internal", ok, detail: parts.join("; ") },
        {
          name: "codex:rate-limits",
          stability: "internal",
          ok: limits.length > 0,
          detail: freshest
            ? `${limits.length} windows, freshest reading ${freshest.observedAt}${freshest.plan ? ` (plan ${freshest.plan})` : ""}`
            : "no rate_limits readings in token_count events",
        },
        {
          name: "codex:session-index",
          stability: "internal",
          ok: Boolean(index?.isFile),
          detail: index?.isFile ? "session names from session_index.jsonl" : "session_index.jsonl not found; sessions have no names",
        },
      ];
    },

    // opts.wholeSessions is ignored: Codex keeps no local cost ledger to reconcile against.
    async *scanUsage(opts: ScanOptions): AsyncIterable<UsageRecord> {
      const sinceMs = opts.since?.getTime();
      const untilMs = opts.until?.getTime();
      // A forked or re-imported rollout may repeat an earlier response. Dedup runs before the time
      // filter and keeps the earliest occurrence, so a copy can't stand in for an original that
      // falls outside the range.
      const first = new Map<string, { t: number; r: UsageRecord }>();
      for (const f of await listRollouts()) {
        if (outOfRange(f, sinceMs, untilMs)) continue;
        const s = await summarize(f);
        if (!s) continue;
        for (const r of s.records) {
          const t = Date.parse(r.ts);
          const prev = first.get(r.id);
          if (!prev || t < prev.t) first.set(r.id, { t, r });
        }
      }
      const out = [...first.values()].filter(({ t, r }) => inRange(r.ts, sinceMs, untilMs) && !((earliest.get(r.id) ?? t) < t));
      out.sort((a, b) => a.t - b.t || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
      for (const { r } of out) yield r;
    },

    async listSessions(): Promise<SessionInfo[]> {
      const t = now().getTime();
      const index = await readIndex();
      const out: SessionInfo[] = [];
      const covered = new Set<string>();
      const active = new Set<string>();
      for (const { file, summary: s } of await recentSummaries(ACTIVE_WINDOW_MS, false)) {
        covered.add(s.threadId);
        if (s.kind !== "main") continue;
        if (!file.name.endsWith(".zst")) active.add(file.path);
        const fresh = t - file.mtimeMs <= BUSY_FRESH_MS;
        const status = s.turnOpen ? (fresh ? "busy" : "unknown") : s.turnChangedAt ? "idle" : "unknown";
        const entry = index.get(s.threadId);
        const info: SessionInfo = { agent: AGENT, sessionId: s.threadId, status, source: entry ? "rollout+session_index" : "rollout" };
        const cwd = s.lastTurn?.cwd ?? s.meta.cwd;
        if (cwd) info.cwd = cwd;
        if (entry?.name) info.name = entry.name;
        if (s.turnChangedAt && status !== "unknown") info.statusSince = s.turnChangedAt;
        if (s.meta.originator) info.entrypoint = s.meta.originator;
        if (s.meta.cliVersion) info.version = s.meta.cliVersion;
        if (s.lastTurn?.model) info.model = s.lastTurn.model;
        if (s.lastTurn?.effort) info.effort = s.lastTurn.effort;
        const startedAt = s.meta.startedAt ?? s.firstTs;
        if (startedAt) info.startedAt = startedAt;
        info.lastActivity = s.lastTs ?? new Date(file.mtimeMs).toISOString();
        out.push(info);
      }
      for (const [id, entry] of index) {
        if (covered.has(id) || !entry.updatedAt || t - Date.parse(entry.updatedAt) > ACTIVE_WINDOW_MS) continue;
        const info: SessionInfo = { agent: AGENT, sessionId: id, status: "unknown", lastActivity: entry.updatedAt, source: "session_index" };
        if (entry.name) info.name = entry.name;
        out.push(info);
      }
      out.sort((a, b) => Date.parse(b.lastActivity ?? "") - Date.parse(a.lastActivity ?? "") || a.sessionId.localeCompare(b.sessionId));
      activePaths = active;
      return out;
    },

    watchSessions(onChange: () => void): () => void {
      const seen = new Map<string, { mtimeMs: number; size: number; scannedTo: number; open?: boolean }>();
      let baseline = true;
      let running = false;
      let stopped = false;
      const check = async () => {
        if (running || stopped) return;
        running = true;
        try {
          let changed = false;
          for (const [path, st] of await watchTargets()) {
            const prev = seen.get(path);
            if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
            // A rollout only grows; one that shrank was replaced, so read its tail afresh.
            const from = prev && st.size >= prev.scannedTo ? prev.scannedTo : 0;
            const r = await turnStateSince(path, from, st.size);
            const open = r.open ?? (from > 0 ? prev?.open : undefined);
            seen.set(path, { mtimeMs: st.mtimeMs, size: st.size, scannedTo: r.scannedTo, open });
            if (baseline) continue;
            // New in a date dir: a new session. New only through activePaths: an older rollout the
            // first listSessions found, taken as a baseline.
            if (prev ? open !== undefined && open !== prev.open : st.inDateDir) changed = true;
          }
          baseline = false;
          if (changed && !stopped) onChange();
        } catch {
          // a vanished dir or file: the next check sees what is left
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

    async readLimits(): Promise<LimitSnapshot[]> {
      const t = now().getTime();
      const files = (await listRollouts()).sort((a, b) => b.mtimeMs - a.mtimeMs);
      // The window ends at the last activity, so an idle account still shows its last known
      // (expired, greyed-out) gauges instead of nothing.
      const anchor = Math.min(t, files[0]?.mtimeMs ?? t);
      const cutoff = anchor - LIMIT_LOOKBACK_MS;
      const best = new Map<string, LimitSnapshot>();
      for (const f of files) {
        if (f.mtimeMs < cutoff) break;
        const s = await summarize(f);
        if (!s) continue;
        for (const l of s.limits) {
          const at = Date.parse(l.observedAt);
          if (at > t + CLOCK_SKEW_MS) continue;
          const prev = best.get(l.kind);
          if (!prev || at > Date.parse(prev.observedAt)) best.set(l.kind, l);
        }
      }
      return [...best.values()].sort((a, b) => a.kind.localeCompare(b.kind));
    },

    async readContext(): Promise<ContextSnapshot[]> {
      const out: ContextSnapshot[] = [];
      for (const { summary: s } of await recentSummaries(ACTIVE_WINDOW_MS, false)) {
        if (s.kind !== "main" || !s.context) continue;
        const c: ContextSnapshot = {
          agent: AGENT,
          sessionId: s.threadId,
          tokens: s.context.tokens,
          observedAt: s.context.ts,
          quality: "estimated",
          source: "rollout:token_count",
        };
        if (s.context.window) {
          c.window = s.context.window;
          c.windowSource = "agent";
          c.percent = Math.round((s.context.tokens / s.context.window) * 1000) / 10;
        }
        out.push(c);
      }
      return out;
    },

    async readCompactions(opts: ScanOptions): Promise<CompactionEvent[]> {
      const sinceMs = opts.since?.getTime();
      const untilMs = opts.until?.getTime();
      const out: CompactionEvent[] = [];
      for (const f of await listRollouts()) {
        if (outOfRange(f, sinceMs, untilMs)) continue;
        const s = await summarize(f);
        if (!s) continue;
        for (const c of s.compactions) if (inRange(c.ts, sinceMs, untilMs)) out.push(c);
      }
      return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    },

    // Every rollout is summarized (cached per file), so a session's subagent rollouts count even when the
    // main one is older; `since`/`until` filter whole sessions afterwards.
    async listHistory(opts: HistoryOptions = {}): Promise<HistorySession[]> {
      const sinceMs = opts.since?.getTime() ?? -Infinity;
      const index = await readIndex();
      const mains = new Map<string, { file: RolloutFile; summary: RolloutSummary }>();
      const others = new Map<string, RolloutSummary[]>();
      // Dedup by record id, earliest copy wins, like scanUsage.
      const first = new Map<string, { t: number; r: UsageRecord }>();
      for (const file of await listRollouts()) {
        const s = await summarize(file);
        if (!s) continue;
        for (const r of s.records) {
          const t = Date.parse(r.ts);
          const prev = first.get(r.id);
          if (!prev || t < prev.t) first.set(r.id, { t, r });
        }
        if (s.kind === "main") {
          const prev = mains.get(s.threadId);
          if (!prev || file.mtimeMs > prev.file.mtimeMs) mains.set(s.threadId, { file, summary: s });
        } else {
          const list = others.get(s.sessionId) ?? [];
          list.push(s);
          others.set(s.sessionId, list);
        }
      }
      const records = new Map<string, UsageRecord[]>();
      for (const { r } of first.values()) {
        const list = records.get(r.sessionId) ?? [];
        list.push(r);
        records.set(r.sessionId, list);
      }
      const out: HistorySession[] = [];
      for (const [sessionId, { file, summary: s }] of mains) {
        const extra = others.get(sessionId) ?? [];
        let firstMs = Infinity;
        let lastMs = -Infinity;
        for (const x of [s, ...extra]) {
          for (const ts of [x.meta.startedAt, x.firstTs]) {
            const t = ts ? Date.parse(ts) : NaN;
            if (Number.isFinite(t)) firstMs = Math.min(firstMs, t);
          }
          const t = x.lastTs ? Date.parse(x.lastTs) : NaN;
          if (Number.isFinite(t)) lastMs = Math.max(lastMs, t);
        }
        if (!Number.isFinite(lastMs)) lastMs = file.mtimeMs;
        if (!Number.isFinite(firstMs)) firstMs = file.startMs ?? lastMs;
        lastMs = Math.max(lastMs, firstMs);
        if (lastMs < sinceMs) continue;
        const recs = (records.get(sessionId) ?? []).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const project = projectOf(recs) ?? s.meta.cwd;
        const h: HistorySession = {
          agent: AGENT,
          sessionId,
          ...chooseTitle({ index: index.get(s.threadId)?.name }),
          startedAt: new Date(firstMs).toISOString(),
          lastActivityAt: new Date(lastMs).toISOString(),
          records: recs,
          compactions: s.compactions.length,
          subagentFiles: extra.filter((x) => x.kind === "subagent").length,
          workflowRuns: 0,
          transcriptPath: file.path,
        };
        if (project) h.project = project;
        const branch = sanitizeTitle(s.meta.gitBranch);
        if (branch) h.gitBranch = branch;
        const entrypoint = sanitizeTitle(s.meta.originator, 48);
        if (entrypoint) h.entrypoint = entrypoint;
        const version = sanitizeTitle(s.meta.cliVersion, 48);
        if (version) h.version = version;
        const resume = resumeCommand("codex resume", s.threadId, project);
        if (resume) h.resume = resume;
        out.push(h);
      }
      return out;
    },
  };
  return adapter;
}
