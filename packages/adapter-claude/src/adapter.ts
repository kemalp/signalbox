import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  chooseTitle,
  embeddedModelTables,
  fillContextWindow,
  mergeAppSessions,
  projectOf,
  resumeCommand,
  type Adapter,
  type AdapterHealth,
  type AppSessionRecord,
  type ClaudeAppOffReason,
  type CompactionEvent,
  type ContextSnapshot,
  type HistoryOptions,
  type HistorySession,
  type LedgerEntry,
  type LimitSnapshot,
  type ModelTable,
  type ScanOptions,
  type SessionInfo,
  type SessionListOptions,
  type TapSpool,
  type UsageRecord,
} from "../../core/src/index.ts";
import { ClaudeAppReader, type ClaudeAppFs, type ClaudeAppRead } from "./claude-app.ts";
import { lastMainResponse } from "./context.ts";
import { FileCache, type FileStamp } from "./file-cache.ts";
import { forEachLine } from "./lines.ts";
import {
  defaultConfigDir,
  defaultSpoolDir,
  exists,
  fileStamp,
  indexMainTranscripts,
  listTranscripts,
  mtimeMs,
  type TranscriptFile,
} from "./paths.ts";
import { isPidAlive, isRegistryFileName, mergeSessions, readRegistry, runAgentsJson, type AgentsRun } from "./sessions.ts";
import { contextFromSpool, limitsFromSpools, readSpoolDir } from "./spool.ts";
import { TranscriptReader, type TranscriptParse } from "./transcript.ts";
import { emptyUsageStats, type UsageStats } from "./usage.ts";
import { watchDir, type DirWatchMode } from "./watch.ts";

export interface ClaudeAdapterOptions {
  /** Default: $CLAUDE_CONFIG_DIR, else ~/.claude. */
  configDir?: string;
  /** Default: $SIGNALBOX_CLAUDE_BIN, else `claude` on PATH. */
  claudeBin?: string;
  /** Default: ~/Library/Application Support/signalbox/spool. */
  spoolDir?: string;
  now?: () => Date;
  /** Timeout for `claude agents --json`. Default 5000 ms. */
  agentsTimeoutMs?: number;
  /** Context windows and Claude Code's auto-compact point. Default: the embedded models/*.json. */
  modelTables?: ModelTable[];
  /** How watchSessions follows the registry: "auto" (fs.watch, polling while it can't) or "poll". Default "auto". */
  watchMode?: "auto" | "poll";
  /** Registry poll interval while fs.watch is unavailable. Default 2000 ms. */
  watchPollMs?: number;
  /**
   * The Claude app's session list (read-only, allow-listed; see claude-app.ts), folded into listHistory. A
   * directory reads it from there (the CLI passes claudeAppSetting()); `false` means it was turned off
   * (--no-claude-app); undefined (the default) leaves it out and adds no health row.
   */
  claudeAppDir?: string | false;
  /** Why it is off when `claudeAppDir` is false (default "flag"), and the health row's text for that. */
  claudeAppOff?: { reason: ClaudeAppOffReason; detail: string };
  /** Filesystem calls of the Claude app reader (tests). */
  claudeAppFs?: ClaudeAppFs;
}

/** What the last listHistory took from the Claude app's list. */
export interface ClaudeAppStatus {
  enabled: boolean;
  /** Why it is off, when `enabled` is false. */
  off?: ClaudeAppOffReason;
  dir?: string;
  /** Records read by the last listHistory; undefined before the first one (or when off). */
  records?: number;
  /** From the last listHistory: sessions with both a record and a transcript, app-only sessions, archived ones. */
  merged?: number;
  appOnly?: number;
  archived?: number;
  skipped?: number;
  errors?: number;
}

export interface ClaudeCodeAdapter extends Adapter {
  readonly configDir: string;
  readonly spoolDir: string;
  /** `quick`: status from the registry plus the last agents --json result, without running it again. */
  listSessions(opts?: SessionListOptions): Promise<SessionInfo[]>;
  /** Follows <configDir>/sessions (registry files only; never the .key files). */
  watchSessions(onChange: () => void): () => void;
  /** How the most recent watchSessions call is watching, for diagnostics. */
  sessionWatchMode(): DirWatchMode | undefined;
  readLedger(opts: ScanOptions): Promise<LedgerEntry[]>;
  readLimits(): Promise<LimitSnapshot[]>;
  readContext(): Promise<ContextSnapshot[]>;
  readCompactions(opts: ScanOptions): Promise<CompactionEvent[]>;
  /** Sessions with a main transcript, their titles and every record (main, subagents, workflows). */
  listHistory(opts?: HistoryOptions): Promise<HistorySession[]>;
  /** Counters from the most recent completed scanUsage (dedup diagnostics), if any. */
  lastScanStats(): UsageStats | undefined;
  /** The Claude app reader's setting and what the last listHistory took from it; undefined when not configured. */
  claudeAppStatus(): ClaudeAppStatus | undefined;
}

/** Reuse one `claude agents --json` result across calls made in the same refresh. */
const AGENTS_TTL_MS = 2000;
/** A failed or timed-out run is not retried for this long, so a hung CLI doesn't stall every poll. */
const AGENTS_FAILED_TTL_MS = 60_000;
/** A spool for a session that no other source lists still counts as live for this long. */
const SPOOL_ONLY_LIVE_MS = 24 * 60 * 60 * 1000;

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): ClaudeCodeAdapter {
  return new ClaudeAdapter(opts);
}

/** forEachLine that reports a vanished or unreadable file as `false` instead of throwing. */
async function readLines(path: string, fn: (line: string) => void): Promise<boolean> {
  try {
    await forEachLine(path, fn);
    return true;
  } catch {
    return false;
  }
}

function range(opts: ScanOptions): { since: number; until: number } {
  return { since: opts.since?.getTime() ?? -Infinity, until: opts.until?.getTime() ?? Infinity };
}

/** One session's files while listHistory collects them. */
interface HistoryBucket {
  main?: TranscriptParse;
  mainPath?: string;
  records: UsageRecord[];
  ledger: LedgerEntry[];
  firstTsMs?: number;
  lastTsMs?: number;
  mtimeMs: number;
  subagentFiles: number;
  /** wf_<id> directories with at least one agent transcript. */
  workflows: Set<string>;
}

function addStats(into: UsageStats, from: UsageStats): void {
  for (const k of Object.keys(from) as Array<keyof UsageStats>) into[k] += from[k];
}

class ClaudeAdapter implements ClaudeCodeAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly configDir: string;
  readonly spoolDir: string;
  private readonly projectsDir: string;
  private readonly sessionsDir: string;
  private readonly now: () => Date;
  private readonly agentsTimeoutMs: number;
  private readonly agentsEnv: Record<string, string | undefined>;
  private readonly modelTables: ModelTable[];
  private readonly spoolCache = new Map<string, TapSpool>();
  private agentsCache?: { run: AgentsRun; at: number };
  private agentsInFlight?: Promise<AgentsRun>;
  private lastWatch?: { readonly mode: DirWatchMode };
  private usageStats?: UsageStats;
  private ledgerStats?: { files: number; sessions: number; entries: number };
  /** Sessions per title source in the last listHistory. */
  private titleStats?: Record<string, number>;
  // One parse per transcript (usage, cost-state, compactions, history metadata), reused while the file's
  // mtime and size are unchanged. Every reader below shares it, so a file is read once per change.
  private readonly transcripts = new FileCache<TranscriptParse>();
  private readonly parsing = new Map<string, Promise<TranscriptParse | undefined>>();
  private readonly claudeApp?: ClaudeAppReader;
  private appStatus?: ClaudeAppStatus;

  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.configDir = opts.configDir ?? defaultConfigDir();
    this.spoolDir = opts.spoolDir ?? defaultSpoolDir();
    this.projectsDir = join(this.configDir, "projects");
    this.sessionsDir = join(this.configDir, "sessions");
    this.now = opts.now ?? (() => new Date());
    this.agentsTimeoutMs = opts.agentsTimeoutMs ?? 5000;
    this.modelTables = opts.modelTables ?? embeddedModelTables();
    // Only point the child at a config dir we were explicitly given; setting CLAUDE_CONFIG_DIR
    // to the default path is not a no-op for Claude Code.
    this.agentsEnv = opts.configDir ? { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir } : process.env;
    if (typeof opts.claudeAppDir === "string") {
      this.claudeApp = new ClaudeAppReader(opts.claudeAppDir, { fs: opts.claudeAppFs, now: () => this.now().getTime() });
      this.appStatus = { enabled: true, dir: opts.claudeAppDir };
    } else if (opts.claudeAppDir === false) {
      this.appStatus = { enabled: false, off: opts.claudeAppOff?.reason ?? "flag" };
    }
  }

  claudeAppStatus(): ClaudeAppStatus | undefined {
    return this.appStatus ? { ...this.appStatus } : undefined;
  }

  async detect(): Promise<boolean> {
    return (await exists(this.projectsDir)) || (await exists(this.sessionsDir));
  }

  lastScanStats(): UsageStats | undefined {
    return this.usageStats ? { ...this.usageStats } : undefined;
  }

  /**
   * The cached parse of `file` for this stamp, or a fresh read (shared with a concurrent caller asking for
   * the same stamp). Undefined when the file vanished or could not be read.
   */
  private parse(file: TranscriptFile, stamp: FileStamp): Promise<TranscriptParse | undefined> {
    const hit = this.transcripts.get(file.path, stamp);
    if (hit) return Promise.resolve(hit);
    const key = `${stamp.mtimeMs}:${stamp.size}:${file.path}`;
    let job = this.parsing.get(key);
    if (!job) {
      job = (async () => {
        const reader = new TranscriptReader(file, stamp);
        if (!(await readLines(file.path, (line) => reader.addLine(line)))) return undefined;
        const parsed = reader.finish();
        this.transcripts.set(file.path, stamp, parsed);
        return parsed;
      })().finally(() => this.parsing.delete(key));
      this.parsing.set(key, job);
    }
    return job;
  }

  async *scanUsage(opts: ScanOptions): AsyncIterable<UsageRecord> {
    const { since, until } = range(opts);
    const whole = opts.wholeSessions === true;
    const stats = emptyUsageStats();
    const seen = new Set<string>();
    this.transcripts.prune();
    const files = await listTranscripts(this.projectsDir);
    const stamps: Array<{ mtimeMs: number; size: number } | undefined> = [];
    for (const file of files) stamps.push(await fileStamp(file.path));
    // wholeSessions: every file of a session that has any file touched since `since`, all records.
    const active = new Set<string>();
    if (whole) files.forEach((f, i) => (stamps[i]?.mtimeMs ?? -Infinity) >= since && active.add(f.sessionId));
    for (const [i, file] of files.entries()) {
      const stamp = stamps[i];
      if (stamp === undefined) continue;
      if (whole ? !active.has(file.sessionId) : stamp.mtimeMs < since) continue; // cheap skip of files untouched since `since`
      stats.files++;
      const parsed = await this.parse(file, stamp);
      if (!parsed) {
        stats.readErrors++;
        continue;
      }
      addStats(stats, parsed.stats);
      for (const { key, records } of parsed.responses) {
        // Guard against the same response in two files (never observed): first file wins.
        if (seen.has(key)) {
          stats.crossFileDuplicates++;
          continue;
        }
        seen.add(key);
        let counted = false;
        for (const rec of records) {
          const t = Date.parse(rec.ts);
          if (!whole && (t < since || t >= until)) continue;
          if (!counted) stats.responses++; // one API response, however many records it was split into
          counted = true;
          yield rec;
        }
      }
    }
    this.usageStats = stats;
  }

  async readLedger(opts: ScanOptions): Promise<LedgerEntry[]> {
    const { since, until } = range(opts);
    const out: LedgerEntry[] = [];
    let files = 0;
    let sessions = 0;
    this.transcripts.prune();
    for (const file of await listTranscripts(this.projectsDir)) {
      const stamp = await fileStamp(file.path);
      if (stamp === undefined || stamp.mtimeMs < since) continue;
      files++;
      const row = (await this.parse(file, stamp))?.ledger;
      if (!row) continue;
      if (row.start && Date.parse(row.start) >= until) continue;
      if (row.entries.length > 0) sessions++;
      out.push(...row.entries);
    }
    this.ledgerStats = { files, sessions, entries: out.length };
    return out;
  }

  async readCompactions(opts: ScanOptions): Promise<CompactionEvent[]> {
    const { since, until } = range(opts);
    const out: CompactionEvent[] = [];
    this.transcripts.prune();
    for (const file of await listTranscripts(this.projectsDir)) {
      // Main threads only: a subagent's compaction would otherwise look like the session's own.
      if (file.kind !== "main") continue;
      const stamp = await fileStamp(file.path);
      if (stamp === undefined || stamp.mtimeMs < since) continue;
      const found = (await this.parse(file, stamp))?.compactions;
      if (!found) continue;
      for (const ev of found) {
        const t = Date.parse(ev.ts);
        if (t >= since && t < until) out.push(ev);
      }
    }
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  async listHistory(opts: HistoryOptions = {}): Promise<HistorySession[]> {
    const since = opts.since?.getTime() ?? -Infinity;
    this.transcripts.prune();
    // The Claude app's list first: a session it saw activity in since `since` needs its transcript read even
    // when no transcript file changed since then, or it would look like a session without one.
    const app: ClaudeAppRead | undefined = this.claudeApp ? await this.claudeApp.read() : undefined;
    const files = await listTranscripts(this.projectsDir);
    const stamps: Array<FileStamp | undefined> = [];
    for (const file of files) stamps.push(await fileStamp(file.path));
    // A session counts when it has a main transcript and any of its files was written since `since`.
    const mains = new Set<string>();
    const active = new Set<string>();
    files.forEach((f, i) => {
      const st = stamps[i];
      if (!st) return;
      if (f.kind === "main") mains.add(f.sessionId);
      if (st.mtimeMs >= since) active.add(f.sessionId);
    });
    const appTime = (r: AppSessionRecord) => Date.parse(r.lastActivityAt ?? r.createdAt ?? "");
    for (const r of app?.records ?? []) if (r.agentSessionId && appTime(r) >= since) active.add(r.agentSessionId);
    const buckets = new Map<string, HistoryBucket>();
    for (const sid of active) {
      if (mains.has(sid)) buckets.set(sid, { records: [], ledger: [], mtimeMs: 0, subagentFiles: 0, workflows: new Set() });
    }
    // Path order and one seen-set across files, like scanUsage, so a response is counted once.
    const seen = new Set<string>();
    for (const [i, file] of files.entries()) {
      const stamp = stamps[i];
      const b = buckets.get(file.sessionId);
      if (!stamp || !b) continue;
      const parsed = await this.parse(file, stamp);
      if (!parsed) continue;
      if (file.kind === "main") {
        b.main = parsed;
        b.mainPath = file.path;
      } else if (file.kind === "subagent") {
        b.subagentFiles++;
      } else if (file.kind === "workflow") {
        b.workflows.add(basename(dirname(file.path)));
      }
      b.mtimeMs = Math.max(b.mtimeMs, stamp.mtimeMs);
      const { firstTsMs, lastTsMs } = parsed.meta;
      if (firstTsMs !== undefined && (b.firstTsMs === undefined || firstTsMs < b.firstTsMs)) b.firstTsMs = firstTsMs;
      if (lastTsMs !== undefined && (b.lastTsMs === undefined || lastTsMs > b.lastTsMs)) b.lastTsMs = lastTsMs;
      b.ledger.push(...parsed.ledger.entries);
      for (const { key, records } of parsed.responses) {
        if (seen.has(key)) continue;
        seen.add(key);
        // A record belongs to the session it names, like in the report (never observed to differ from the file's).
        for (const rec of records) (buckets.get(rec.sessionId) ?? b).records.push(rec);
      }
    }
    const out: HistorySession[] = [];
    for (const [sessionId, b] of buckets) {
      if (!b.main) continue; // the main transcript vanished or could not be read
      const meta = b.main.meta;
      // A session with no response has no record to take it from; its first line's working directory stands in.
      const project = projectOf(b.records) ?? meta.cwd;
      // A transcript with no timestamped line (e.g. only title lines) falls back to its mtime.
      const first = b.firstTsMs ?? b.mtimeMs;
      const last = Math.max(b.lastTsMs ?? b.mtimeMs, first);
      const s: HistorySession = {
        agent: "claude-code",
        sessionId,
        ...chooseTitle({ custom: meta.customTitle, ai: meta.aiTitle, agentName: meta.agentName }),
        startedAt: new Date(first).toISOString(),
        lastActivityAt: new Date(last).toISOString(),
        records: b.records,
        compactions: b.main.compactions.length,
        subagentFiles: b.subagentFiles,
        workflowRuns: b.workflows.size,
      };
      if (project) s.project = project;
      if (meta.gitBranch) s.gitBranch = meta.gitBranch;
      if (meta.entrypoint) s.entrypoint = meta.entrypoint;
      if (meta.version) s.version = meta.version;
      if (b.ledger.length > 0) s.ledger = b.ledger;
      const resume = resumeCommand("claude --resume", sessionId, project);
      if (resume) s.resume = resume;
      if (b.mainPath) s.transcriptPath = b.mainPath;
      out.push(s);
    }
    const titles: Record<string, number> = { custom: 0, ai: 0, "agent-name": 0, none: 0 };
    for (const s of out) titles[s.titleSource] = (titles[s.titleSource] ?? 0) + 1;
    this.titleStats = titles;
    if (!app) return out;
    // A record with no activity since `since` matters only for a transcript session that is listed anyway; alone it
    // would fall outside the window (and its transcript, unread, would look missing).
    const records = app.records.filter((r) => appTime(r) >= since || (r.agentSessionId !== undefined && buckets.has(r.agentSessionId)));
    const merged = mergeAppSessions(out, records);
    let withTranscript = 0;
    let appOnly = 0;
    let archived = 0;
    for (const s of merged) {
      if (!s.appSessionId) continue;
      if (s.hasTranscript === false) appOnly++;
      else withTranscript++;
      if (s.archived) archived++;
    }
    this.appStatus = {
      enabled: true,
      dir: app.dir,
      records: app.records.length,
      merged: withTranscript,
      appOnly,
      archived,
      skipped: app.skipped,
      errors: app.errors,
    };
    return merged;
  }

  private claudeBin(): string | undefined {
    return this.opts.claudeBin ?? (process.env.SIGNALBOX_CLAUDE_BIN || undefined) ?? Bun.which("claude") ?? undefined;
  }

  /** Claude Code's global config file: in the config dir when one is set, else ~/.claude.json. */
  private globalConfigPath(): string {
    const explicit = this.opts.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
    return explicit ? join(explicit, ".claude.json") : join(homedir(), ".claude.json");
  }

  private async agents(): Promise<AgentsRun> {
    const c = this.agentsCache;
    if (c && Date.now() - c.at < (c.run.ok ? AGENTS_TTL_MS : AGENTS_FAILED_TTL_MS)) return c.run;
    // Concurrent callers (fleet, health, context in one refresh) share one child process.
    if (this.agentsInFlight) return this.agentsInFlight;
    this.agentsInFlight = (async (): Promise<AgentsRun> => {
      // `claude agents --json` initialises a missing global config file (and a backup of it), which
      // would be a write to agent config. Without that file no session has run, so there is nothing to list.
      const globalConfig = this.globalConfigPath();
      if (!(await exists(globalConfig))) {
        return {
          ok: false,
          skipped: true,
          reason: `not run: ${globalConfig} does not exist, so no session has used this config dir (agents --json would create the file)`,
        };
      }
      return runAgentsJson(this.claudeBin(), { timeoutMs: this.agentsTimeoutMs, env: this.agentsEnv });
    })();
    try {
      const run = await this.agentsInFlight;
      this.agentsCache = { run, at: Date.now() };
      return run;
    } finally {
      this.agentsInFlight = undefined;
    }
  }

  /** The last agents --json result whatever its age (or the first run, while it is in flight); never starts a run. */
  private async lastAgents(): Promise<AgentsRun | undefined> {
    return this.agentsCache?.run ?? this.agentsInFlight;
  }

  watchSessions(onChange: () => void): () => void {
    const w = watchDir(this.sessionsDir, onChange, { accept: isRegistryFileName, mode: this.opts.watchMode, pollMs: this.opts.watchPollMs });
    this.lastWatch = w;
    return () => w.close();
  }

  sessionWatchMode(): DirWatchMode | undefined {
    return this.lastWatch?.mode;
  }

  async listSessions(opts: SessionListOptions = {}): Promise<SessionInfo[]> {
    const [reg, run, idx] = await Promise.all([
      readRegistry(this.sessionsDir),
      opts.quick ? this.lastAgents() : this.agents(),
      indexMainTranscripts(this.projectsDir),
    ]);
    const ok = run?.ok ? run : undefined;
    const sessions = mergeSessions(ok?.entries, reg.entries, isPidAlive, { agentsAt: ok?.at });
    await Promise.all(
      sessions.map(async (s) => {
        const path = idx.get(s.sessionId);
        if (!path) return;
        const mt = await mtimeMs(path);
        if (mt !== undefined) {
          const iso = new Date(mt).toISOString();
          if (!s.lastActivity || iso > s.lastActivity) s.lastActivity = iso;
        }
        if (s.status === "ended") return;
        const last = await lastMainResponse(path);
        if (!last) return;
        if (!s.model) s.model = last.model;
        if (!s.effort && last.effort) s.effort = last.effort;
        if (!s.version && last.version) s.version = last.version;
      }),
    );
    return sessions;
  }

  async readLimits(): Promise<LimitSnapshot[]> {
    const read = await readSpoolDir(this.spoolDir, this.spoolCache);
    return limitsFromSpools(read.spools);
  }

  async readContext(): Promise<ContextSnapshot[]> {
    // Quick: liveness and models need no fresh agents --json run (fleet lists sessions alongside).
    const [sessions, spoolRead, idx] = await Promise.all([
      this.listSessions({ quick: true }),
      readSpoolDir(this.spoolDir, this.spoolCache),
      indexMainTranscripts(this.projectsDir),
    ]);
    const spoolBySession = new Map<string, TapSpool>();
    for (const sp of spoolRead.spools) {
      const prev = spoolBySession.get(sp.sessionId);
      if (!prev || sp.writtenAt > prev.writtenAt || (sp.writtenAt === prev.writtenAt && sp.seq > prev.seq)) {
        spoolBySession.set(sp.sessionId, sp);
      }
    }
    const live = new Set(sessions.filter((s) => s.status !== "ended").map((s) => s.sessionId));
    const known = new Set(sessions.map((s) => s.sessionId));
    const nowMs = this.now().getTime();
    for (const sp of spoolBySession.values()) {
      if (known.has(sp.sessionId) || sp.event === "session.end") continue;
      if (nowMs - Date.parse(sp.writtenAt) <= SPOOL_ONLY_LIVE_MS) live.add(sp.sessionId);
    }
    // The session's model may carry a suffix such as "[1m]" that the transcript's API model id lacks.
    const sessionModel = new Map(sessions.map((s) => [s.sessionId, s.model]));
    const out: ContextSnapshot[] = [];
    for (const sessionId of [...live].sort()) {
      const sp = spoolBySession.get(sessionId);
      const official = sp && sp.event !== "session.end" ? contextFromSpool(sp) : undefined;
      const path = idx.get(sessionId);
      if (official) {
        const last = official.window === undefined && path ? await lastMainResponse(path) : undefined;
        out.push(fillContextWindow(official, [sessionModel.get(sessionId), last?.model], this.modelTables));
        continue;
      }
      const last = path ? await lastMainResponse(path) : undefined;
      if (!last) continue;
      const estimate: ContextSnapshot = {
        agent: "claude-code",
        sessionId,
        tokens: last.contextTokens,
        observedAt: last.ts,
        quality: "estimated",
        source: "transcript",
      };
      out.push(fillContextWindow(estimate, [sessionModel.get(sessionId), last.model], this.modelTables));
    }
    return out;
  }

  /**
   * The "claude-app:sessions" row, when the reader is configured (on or off). Lists names only; opens nothing. No
   * Claude app is not a fault (the history is the transcripts' alone); a folder that can't be listed or records
   * that can't be read are.
   */
  private async claudeAppHealth(): Promise<AdapterHealth[]> {
    const st = this.appStatus;
    if (!st) return [];
    const name = "claude-app:sessions";
    if (!st.enabled || !this.claudeApp) {
      const detail = this.opts.claudeAppOff?.detail ?? "off (--no-claude-app): history lists sessions with a transcript only";
      return [{ name, stability: "internal", ok: true, detail }];
    }
    const { dirExists, dirError, paths } = await this.claudeApp.list();
    if (dirError) {
      return [{ name, stability: "internal", ok: false, detail: `could not list the Claude app's session list at ${this.claudeApp.dir} (${dirError}); history lists sessions with a transcript only` }];
    }
    if (!dirExists) {
      return [{ name, stability: "internal", ok: true, detail: `Claude app not found at ${this.claudeApp.dir}; history lists sessions with a transcript only` }];
    }
    const last =
      st.records !== undefined
        ? `; last history: ${st.records} records read, ${st.merged ?? 0} matched a transcript, ${st.appOnly ?? 0} without a transcript, ` +
          `${st.archived ?? 0} archived, ${st.skipped ?? 0} skipped (not a regular file or over 1 MiB), ${st.errors ?? 0} unreadable`
        : "; read on demand for the history";
    return [
      {
        name,
        stability: "internal",
        ok: (st.errors ?? 0) === 0,
        detail: `${paths.length} session record files in ${this.claudeApp.dir} (allow-listed local_*.json names, read-only)${last}`,
      },
    ];
  }

  async health(): Promise<AdapterHealth[]> {
    const [files, reg, run, spool, app] = await Promise.all([
      listTranscripts(this.projectsDir),
      readRegistry(this.sessionsDir),
      this.agents(),
      readSpoolDir(this.spoolDir, this.spoolCache),
      this.claudeAppHealth(),
    ]);
    const byKind: Record<string, number> = {};
    for (const f of files) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    const kinds = Object.entries(byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    const s = this.usageStats;
    const scan = s
      ? `; last scan: ${s.responses} responses from ${s.assistantLines} lines in ${s.files} files, ` +
        `${s.requestKeys} keyed by requestId, ${s.hashKeys} by hash, ${s.inputMismatches} input mismatches, ` +
        `${s.crossFileDuplicates} cross-file duplicates, ${s.iterationSplits} iteration splits, ` +
        `${s.readErrors} unreadable files, ${s.parseErrors} unparsable lines, ${s.invalidCounts} invalid token counts`
      : "";
    const mains = byKind.main ?? 0;
    const alive = reg.entries.filter((e) => e.pid !== undefined && isPidAlive(e.pid, e.pidDomain) === true).length;
    const l = this.ledgerStats;
    const t = this.titleStats;
    const titled = t ? (t.custom ?? 0) + (t.ai ?? 0) + (t["agent-name"] ?? 0) : 0;
    return [
      {
        name: "claude-code:transcripts",
        stability: "internal",
        // Unreadable transcripts mean missing usage; unparsable lines are usually a live file's last line.
        ok: files.length > 0 && (s?.readErrors ?? 0) === 0,
        detail: files.length > 0 ? `${files.length} transcripts in ${this.projectsDir} (${kinds})${scan}` : `no transcripts in ${this.projectsDir}`,
      },
      {
        name: "claude-code:cost-state",
        stability: "internal",
        ok: mains > 0,
        detail: l
          ? `last read: cost-state rows in ${l.sessions} of ${l.files} transcripts (${l.entries} model entries)`
          : mains > 0
            ? `read on demand from ${mains} main transcripts`
            : "no main transcripts",
      },
      {
        name: "claude-code:titles",
        stability: "internal",
        ok: mains > 0,
        detail: t
          ? `last history: ${titled} of ${titled + (t.none ?? 0)} sessions titled (custom-title ${t.custom ?? 0}, ai-title ${t.ai ?? 0}, agent-name ${t["agent-name"] ?? 0})`
          : mains > 0
            ? `read on demand from the custom-title, ai-title and agent-name lines of ${mains} main transcripts`
            : "no main transcripts",
      },
      {
        name: "claude-code:agents-json",
        stability: "preview",
        ok: run.ok || run.skipped === true,
        detail: run.ok
          ? `${run.entries.length} sessions from ${run.bin} agents --json (${run.ms} ms)`
          : `${run.reason}${run.bin ? ` [${run.bin}]` : ""}; sessions come from the registry only`,
      },
      {
        name: "claude-code:registry",
        stability: "internal",
        ok: reg.dirExists,
        detail: reg.dirExists
          ? `${reg.entries.length} registry files (${alive} live pids), ${reg.errors} unreadable`
          : `no registry dir at ${this.sessionsDir}`,
      },
      {
        name: "claude-code:spool",
        stability: "preview",
        ok: spool.dirExists && spool.spools.length > 0,
        detail: !spool.dirExists
          ? `no spool dir at ${this.spoolDir} (signalbox-tap mod not installed); context is estimated, limits unknown`
          : spool.spools.length === 0 && !spool.failed
            ? `no spool files in ${this.spoolDir} yet (signalbox-tap mod not loaded in any session); context is estimated, limits unknown`
            : `${spool.spools.length} spool files` +
              (spool.failed ? `, ${spool.failed} unparsable this round (${spool.reused} served from last good copy)` : ""),
      },
      ...app,
    ];
  }
}
