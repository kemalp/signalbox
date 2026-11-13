import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  accountDirectory,
  accountMatches,
  accountShortId,
  chooseTitle,
  claudeResumePrefix,
  embeddedModelTables,
  fillContextWindow,
  inferredFrom,
  mergeAppSessions,
  projectOf,
  resolveAccount,
  resumeCommand,
  type AccountEvidence,
  type AccountInfo,
  type AccountRef,
  type AccountSighting,
  type ResolvedAccount,
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
  type RetentionInfo,
  retentionText,
  type ScanOptions,
  type SessionInfo,
  type SessionListOptions,
  type TapSpool,
  type UsageRecord,
} from "../../core/src/index.ts";
import { ClaudeAppReader, type ClaudeAppFs, type ClaudeAppRead } from "./claude-app.ts";
import { ConfigLoginReader, defaultLoginFs, type LoginFs, type LoginRead } from "./config-account.ts";
import { RetentionReader } from "./retention.ts";
import { isSwitchShim } from "./switch-shim.ts";
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
import { contextFromSpool, limitsFromSpools, readSpoolDir, spoolsWithCurrentReadings } from "./spool.ts";
import { TranscriptReader, type TranscriptMeta, type TranscriptParse } from "./transcript.ts";
import { emptyUsageStats, type UsageStats } from "./usage.ts";
import { watchDir, type DirWatchMode } from "./watch.ts";

export interface ClaudeAdapterOptions {
  /** Default: $CLAUDE_CONFIG_DIR, else ~/.claude. */
  configDir?: string;
  /**
   * More Claude Code config dirs to read alongside `configDir` (e.g. one per account): their transcripts (a projects/
   * shared by symlink is read once), registries, `agents --json` (run with CLAUDE_CONFIG_DIR=<dir>) and logins.
   */
  extraConfigDirs?: string[];
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
  /** Filesystem calls of the config-login reader (tests). */
  loginFs?: LoginFs;
  /** The home folder for Claude Code's defaults (~/.claude, ~/.claude.json). Default os.homedir(); tests set it. */
  homeDir?: string;
  /** The managed settings folder read for cleanupPeriodDays; false skips it. Default: the platform's (see retention.ts). */
  managedSettingsDir?: string | false;
  /** Filesystem calls of the settings reader (tests). */
  settingsFs?: ClaudeAppFs;
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
  /** The config dir Signalbox started with ($CLAUDE_CONFIG_DIR or ~/.claude). */
  readonly configDir: string;
  /** Every config dir read: `configDir` first, then the extra ones. */
  readonly configDirs: string[];
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
  /** Accounts seen so far: each config dir's login, the Claude app's folders, transcript account lines. */
  readAccounts(): Promise<AccountInfo[]>;
  /** Each listed session's account, for the report's byAccount; unknown sessions are left out. */
  sessionAccounts(sessionIds: Iterable<string>): Promise<Map<string, ResolvedAccount>>;
  /** How long each config dir keeps transcripts (cleanupPeriodDays only). */
  readRetention(maxAgeMs?: number): Promise<RetentionInfo[]>;
}

/** Reuse one `claude agents --json` result across calls made in the same refresh. */
const AGENTS_TTL_MS = 2000;
/** A failed or timed-out run is not retried for this long, so a hung CLI doesn't stall every poll. */
const AGENTS_FAILED_TTL_MS = 60_000;
/** A spool for a session that no other source lists still counts as live for this long. */
const SPOOL_ONLY_LIVE_MS = 24 * 60 * 60 * 1000;
/** Logins (Claude Code's global config files) are re-read at most this often. */
const LOGINS_TTL_MS = 30_000;
/** The fleet re-reads the Claude app's list at most this often (the history reads it every time). */
const APP_FLEET_TTL_MS = 60_000;
/** How soon the list is re-read when a desktop session reporting limits isn't in it yet (it was just started). */
const APP_MISS_TTL_MS = 10_000;

/** One Claude Code config dir: its transcripts, registry, `agents --json` and terminal login. */
interface Root {
  configDir: string;
  projectsDir: string;
  sessionsDir: string;
  /** The dir Signalbox started with; the others came from `extraConfigDirs`. */
  primary: boolean;
  agentsEnv: Record<string, string | undefined>;
  /** Claude Code's global config: <dir>/.claude.json when CLAUDE_CONFIG_DIR points at the dir, else ~/.claude.json. */
  globalConfig: string;
  agentsCache?: { run: AgentsRun; at: number };
  agentsInFlight?: Promise<AgentsRun>;
}

/** A transcript tree and the config dirs that share it (more than one when projects/ is a symlink into another). */
interface Tree {
  projectsDir: string;
  roots: Root[];
}

/** A main transcript, and the config dir it belongs to when only one config dir shares its tree. */
interface MainRef {
  path: string;
  configDir?: string;
}

/** What account resolution reads once per call. */
interface EvidenceCtx {
  idx: Map<string, MainRef>;
  logins: Map<string, LoginRead>;
  /** The newest Claude app record's folder per agent session id. */
  app: Map<string, AccountEvidence>;
  spools: TapSpool[];
  /** The newest spool per session. */
  spoolBySession: Map<string, TapSpool>;
  /** Full account ids seen anywhere (logins, the app's folders, transcripts), to complete account-only ones. */
  known: AccountEvidence[];
}

/**
 * Whether a config dir's terminal login says anything about a session: not for desktop sessions (the Claude app has
 * its own login), nor for SDK runs (they often authenticate with an API key instead). Unknown entrypoint: no.
 */
function inferable(entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && entrypoint !== "claude-desktop" && !entrypoint.startsWith("sdk");
}

/** Each session's account as the app's list records it (the newest record's folders when a session has several). */
function appEvidenceBySession(app: ClaudeAppRead | undefined): Map<string, AccountEvidence> {
  const out = new Map<string, AccountEvidence>();
  for (const r of app?.records ?? []) {
    if (!r.agentSessionId || !r.accountEvidence) continue;
    const prev = out.get(r.agentSessionId);
    if (!prev || (r.accountEvidence.atMs ?? -Infinity) > (prev.atMs ?? -Infinity)) out.set(r.agentSessionId, r.accountEvidence);
  }
  return out;
}

function newestSpools(spools: TapSpool[]): Map<string, TapSpool> {
  const out = new Map<string, TapSpool>();
  for (const sp of spools) {
    const prev = out.get(sp.sessionId);
    if (!prev || sp.writtenAt > prev.writtenAt || (sp.writtenAt === prev.writtenAt && sp.seq > prev.seq)) out.set(sp.sessionId, sp);
  }
  return out;
}

function loginText(l: LoginRead | undefined): string {
  if (!l) return "not read yet";
  switch (l.state) {
    case "ok":
      return l.evidence ? `signed in as account ${accountShortId(l.evidence.ref.id)}${l.evidence.ref.orgKnown ? "" : " (organization unknown)"}` : `no account in ${l.path} (signed out?)`;
    case "missing":
      return `no ${l.path} yet`;
    case "not-a-file":
      return `${l.path} is not a regular file; not read`;
    case "too-large":
      return `${l.path} is over 32 MiB; not read`;
    case "unparsable":
      return `${l.path} could not be parsed`;
    case "changed":
      return `${l.path} changed while it was read`;
    case "unreadable":
      return `${l.path} could not be read (${l.code})`;
  }
}

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
  /** The chosen main transcript's mtime: with the same session in two unshared trees (a copy), the newest copy wins. */
  mainMtimeMs?: number;
  /** The config dir of the main transcript's tree, when only one config dir shares it. */
  configDir?: string;
  /** The config dir a resume runs with (see TranscriptFile.resumeDir). */
  resumeDir?: string;
  records: UsageRecord[];
  ledger: LedgerEntry[];
  firstTsMs?: number;
  lastTsMs?: number;
  mtimeMs: number;
  /** Subagent transcript names, so a session copied into a second tree doesn't count its subagents twice. */
  subagents: Set<string>;
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
  readonly configDirs: string[];
  readonly spoolDir: string;
  private readonly roots: Root[];
  private readonly now: () => Date;
  private readonly agentsTimeoutMs: number;
  private readonly modelTables: ModelTable[];
  private readonly spoolCache = new Map<string, TapSpool>();
  private lastWatch?: { readonly mode: DirWatchMode };
  private readonly logins: ConfigLoginReader;
  /** Claude Code's own default config dir, ~/.claude. */
  private readonly claudeDefaultDir: string;
  private loginCache?: { at: number; reads: Map<string, LoginRead> };
  private readonly retention: RetentionReader;
  private retentionCache?: { at: number; infos: RetentionInfo[] };
  private lastApp?: { at: number; read: ClaudeAppRead };
  private appInFlight?: Promise<ClaudeAppRead>;
  /** Recorded account evidence seen in transcripts and the Claude app's records (by id), for readAccounts. */
  private readonly seenEvidence = new Map<string, AccountEvidence>();
  /** The Claude app's account folders (names only), re-listed at most every APP_FLEET_TTL_MS. */
  private appFolders?: { at: number; evidence: AccountEvidence[] };
  /** How the last listHistory's sessions got their account. */
  private accountStats?: { sessions: number; app: number; transcript: number; inferred: number; conflicts: number };
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
    this.now = opts.now ?? (() => new Date());
    this.agentsTimeoutMs = opts.agentsTimeoutMs ?? 5000;
    this.modelTables = opts.modelTables ?? embeddedModelTables();
    this.logins = new ConfigLoginReader(opts.loginFs ?? defaultLoginFs());
    this.retention = new RetentionReader({ managedDir: opts.managedSettingsDir, fs: opts.settingsFs });
    // Only point the child at a config dir we were explicitly given; setting CLAUDE_CONFIG_DIR
    // to the default path is not a no-op for Claude Code (its global config moves into the dir).
    const explicit = opts.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
    const homeDir = opts.homeDir ?? homedir();
    this.claudeDefaultDir = join(homeDir, ".claude");
    this.roots = [
      {
        configDir: this.configDir,
        projectsDir: join(this.configDir, "projects"),
        sessionsDir: join(this.configDir, "sessions"),
        primary: true,
        agentsEnv: opts.configDir ? { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir } : process.env,
        globalConfig: explicit ? join(explicit, ".claude.json") : join(homeDir, ".claude.json"),
      },
    ];
    const seen = new Set([resolve(this.configDir)]);
    const home = resolve(this.claudeDefaultDir);
    for (const dir of opts.extraConfigDirs ?? []) {
      const r = resolve(dir);
      if (seen.has(r)) continue;
      seen.add(r);
      // ~/.claude as an extra dir is Claude Code's default: run it, and find its global config, without the variable.
      const isDefault = r === home;
      const env = { ...process.env };
      if (isDefault) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = dir;
      this.roots.push({
        configDir: dir,
        projectsDir: join(dir, "projects"),
        sessionsDir: join(dir, "sessions"),
        primary: false,
        agentsEnv: env,
        globalConfig: isDefault ? join(homeDir, ".claude.json") : join(dir, ".claude.json"),
      });
    }
    this.configDirs = this.roots.map((r) => r.configDir);
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
    for (const r of this.roots) if ((await exists(r.projectsDir)) || (await exists(r.sessionsDir))) return true;
    return false;
  }

  /** The transcript trees, one per real projects/ directory, in config-dir order. */
  private async trees(): Promise<Tree[]> {
    const byReal = new Map<string, Tree>();
    for (const root of this.roots) {
      let real: string;
      try {
        real = await realpath(root.projectsDir);
      } catch {
        real = resolve(root.projectsDir);
      }
      const t = byReal.get(real);
      if (t) t.roots.push(root);
      else byReal.set(real, { projectsDir: root.projectsDir, roots: [root] });
    }
    return [...byReal.values()];
  }

  /** Every transcript of every tree, each tree once; a file names its config dir when only one shares the tree. */
  private async listAllTranscripts(): Promise<TranscriptFile[]> {
    const out: TranscriptFile[] = [];
    for (const t of await this.trees()) {
      const owner = t.roots.length === 1 ? t.roots[0]!.configDir : undefined;
      // Any config dir sharing the tree finds the session; the primary (a plain `claude`) when it is one of them.
      const resumeDir = t.roots.some((r) => r.primary) ? this.configDir : t.roots[0]!.configDir;
      for (const f of await listTranscripts(t.projectsDir)) out.push(owner ? { ...f, configDir: owner, resumeDir } : { ...f, resumeDir });
    }
    return out;
  }

  /** sessionId → main transcript across trees (the first tree wins). */
  private async indexAllMains(): Promise<Map<string, MainRef>> {
    const idx = new Map<string, MainRef>();
    for (const t of await this.trees()) {
      const owner = t.roots.length === 1 ? t.roots[0]!.configDir : undefined;
      for (const [sid, path] of await indexMainTranscripts(t.projectsDir)) {
        if (!idx.has(sid)) idx.set(sid, owner ? { path, configDir: owner } : { path });
      }
    }
    return idx;
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
    const files = await this.listAllTranscripts();
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
    for (const file of await this.listAllTranscripts()) {
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
    for (const file of await this.listAllTranscripts()) {
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
    const app: ClaudeAppRead | undefined = await this.readApp(0);
    const [files, logins, spoolRead] = await Promise.all([this.listAllTranscripts(), this.readLogins(), readSpoolDir(this.spoolDir, this.spoolCache)]);
    const spoolBySession = newestSpools(spoolRead.spools);
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
      if (mains.has(sid)) buckets.set(sid, { records: [], ledger: [], mtimeMs: 0, subagents: new Set(), workflows: new Set() });
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
        if (!b.main || stamp.mtimeMs > (b.mainMtimeMs ?? -Infinity)) {
          b.main = parsed;
          b.mainPath = file.path;
          b.mainMtimeMs = stamp.mtimeMs;
          b.configDir = file.configDir;
          b.resumeDir = file.resumeDir;
        }
      } else if (file.kind === "subagent") {
        b.subagents.add(basename(file.path));
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
        subagentFiles: b.subagents.size,
        workflowRuns: b.workflows.size,
      };
      if (project) s.project = project;
      if (meta.gitBranch) s.gitBranch = meta.gitBranch;
      if (meta.entrypoint) s.entrypoint = meta.entrypoint;
      if (meta.version) s.version = meta.version;
      if (b.ledger.length > 0) s.ledger = b.ledger;
      // The primary dir is the one a plain `claude` uses (Signalbox runs with the same CLAUDE_CONFIG_DIR as your shell).
      const resume = resumeCommand(claudeResumePrefix(b.resumeDir, this.configDir, this.claudeDefaultDir), sessionId, project);
      if (resume) s.resume = resume;
      if (b.mainPath) s.transcriptPath = b.mainPath;
      if (b.configDir) s.configDir = b.configDir;
      const evidence = this.transcriptEvidence(meta, { entrypoint: meta.entrypoint, configDir: b.configDir }, logins, spoolBySession.get(sessionId));
      if (evidence.length > 0) s.accountEvidence = evidence;
      out.push(s);
    }
    // An account-only id completed by the one full id with the same account seen anywhere (after the loop above,
    // which noted every transcript's account lines).
    const known = await this.knownAccounts(logins);
    for (const s of out) if (s.accountEvidence) s.accountEvidence.push(...accountMatches(s.accountEvidence, known, { recordedOnly: !inferable(s.entrypoint) }));
    const titles: Record<string, number> = { custom: 0, ai: 0, "agent-name": 0, none: 0 };
    for (const s of out) titles[s.titleSource] = (titles[s.titleSource] ?? 0) + 1;
    this.titleStats = titles;
    if (!app) {
      this.noteAccountStats(out);
      return out;
    }
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
    this.noteAccountStats(merged);
    return merged;
  }

  /** How the history's sessions got their account, for the health row. */
  private noteAccountStats(sessions: readonly HistorySession[]): void {
    const st = { sessions: sessions.length, app: 0, transcript: 0, inferred: 0, conflicts: 0 };
    for (const s of sessions) {
      const { account, conflict } = resolveAccount(s.accountEvidence);
      if (conflict) st.conflicts++;
      if (!account) continue;
      if (account.quality === "inferred") st.inferred++;
      else if (account.source === "claude-app-folder") st.app++;
      else st.transcript++;
    }
    this.accountStats = st;
  }

  private noteEvidence(ev: AccountEvidence): void {
    if (ev.ref.quality === "recorded" && !this.seenEvidence.has(ev.ref.id)) this.seenEvidence.set(ev.ref.id, ev);
  }

  /**
   * A session's own evidence: its transcript's account lines (recorded), then, for a session that doesn't run in the
   * desktop app, the current login of the config dir it runs from and of the dir its tap spool names (inferred).
   */
  private transcriptEvidence(
    meta: TranscriptMeta | undefined,
    hint: { entrypoint?: string; configDir?: string },
    logins: Map<string, LoginRead>,
    spool: TapSpool | undefined,
  ): AccountEvidence[] {
    const out: AccountEvidence[] = [];
    if (meta?.accountFull) out.push(meta.accountFull);
    if (meta?.accountPartial) out.push(meta.accountPartial);
    for (const e of out) this.noteEvidence(e);
    if (inferable(hint.entrypoint ?? meta?.entrypoint)) {
      const fromDir = this.loginInference(hint.configDir, logins, "config-login");
      if (fromDir) out.push(fromDir);
      const fromTap = this.loginInference(spool ? this.spoolRootDir(spool) : undefined, logins, "tap-config-dir");
      if (fromTap) out.push(fromTap);
    }
    return out;
  }

  private loginInference(configDir: string | undefined, logins: Map<string, LoginRead>, source: string): AccountEvidence | undefined {
    if (!configDir) return undefined;
    const l = logins.get(configDir);
    return l?.state === "ok" && l.evidence ? inferredFrom(l.evidence, source) : undefined;
  }

  /** The config dir a tap spool names ($CLAUDE_CONFIG_DIR, or ~/.claude when unset), if it is one of ours. */
  private spoolRootDir(sp: TapSpool): string | undefined {
    if (sp.configDir === undefined) return undefined;
    const want = resolve(sp.configDir ?? this.claudeDefaultDir);
    return this.roots.find((r) => resolve(r.configDir) === want)?.configDir;
  }

  /** Each config dir's login, re-read at most every LOGINS_TTL_MS (a file whose stamp didn't change isn't parsed again). */
  private async readLogins(maxAgeMs = LOGINS_TTL_MS): Promise<Map<string, LoginRead>> {
    const c = this.loginCache;
    if (c && Date.now() - c.at < maxAgeMs) return c.reads;
    const reads = new Map<string, LoginRead>();
    for (const r of this.roots) reads.set(r.configDir, await this.logins.read(r.globalConfig));
    this.loginCache = { at: Date.now(), reads };
    return reads;
  }

  /** The Claude app's list, re-read when the last read is older than `maxAgeMs`; undefined when the reader is off. */
  private async readApp(maxAgeMs: number): Promise<ClaudeAppRead | undefined> {
    if (!this.claudeApp) return undefined;
    const c = this.lastApp;
    if (c && Date.now() - c.at < maxAgeMs) return c.read;
    this.appInFlight ??= this.claudeApp.read().finally(() => {
      this.appInFlight = undefined;
    });
    const read = await this.appInFlight;
    this.lastApp = { at: Date.now(), read };
    for (const r of read.records) if (r.accountEvidence) this.noteEvidence(r.accountEvidence);
    return read;
  }

  /** The Claude app's account folders, hashed (names only; nothing is opened), at most every APP_FLEET_TTL_MS. */
  private async readAppFolders(): Promise<AccountEvidence[]> {
    if (!this.claudeApp) return [];
    const c = this.appFolders;
    if (c && Date.now() - c.at < APP_FLEET_TTL_MS) return c.evidence;
    const evidence = await this.claudeApp.folderAccounts();
    this.appFolders = { at: Date.now(), evidence };
    return evidence;
  }

  /** Every full account id seen: each config dir's login, the app's folders, transcript account lines. */
  private async knownAccounts(logins: Map<string, LoginRead>): Promise<AccountEvidence[]> {
    const out: AccountEvidence[] = [];
    for (const l of logins.values()) if (l.state === "ok" && l.evidence?.ref.orgKnown) out.push(l.evidence);
    out.push(...(await this.readAppFolders()));
    for (const ev of this.seenEvidence.values()) if (ev.ref.orgKnown) out.push(ev);
    return out;
  }

  private async evidenceCtx(quick: boolean): Promise<EvidenceCtx> {
    const [idx, logins, app, spoolRead] = await Promise.all([
      this.indexAllMains(),
      this.readLogins(quick && this.loginCache ? Infinity : LOGINS_TTL_MS),
      quick ? Promise.resolve(this.lastApp?.read) : this.readApp(APP_FLEET_TTL_MS),
      readSpoolDir(this.spoolDir, this.spoolCache),
    ]);
    const known = await this.knownAccounts(logins);
    return { idx, logins, app: appEvidenceBySession(app), spools: spoolRead.spools, spoolBySession: newestSpools(spoolRead.spools), known };
  }

  /**
   * A live session's account. Its main transcript's account lines come from the cached parse when there is one (even
   * a slightly stale one: account lines are rare and don't move); `allowParse` reads a transcript never parsed yet.
   */
  private async accountFor(sessionId: string, ctx: EvidenceCtx, hint: { entrypoint?: string; configDir?: string }, allowParse: boolean): Promise<AccountRef | undefined> {
    return (await this.resolvedFor(sessionId, ctx, hint, allowParse)).account;
  }

  /** accountFor, with whether the session's recorded evidence conflicts. */
  private async resolvedFor(sessionId: string, ctx: EvidenceCtx, hint: { entrypoint?: string; configDir?: string }, allowParse: boolean): Promise<ResolvedAccount> {
    const main = ctx.idx.get(sessionId);
    let meta: TranscriptMeta | undefined;
    if (main) {
      meta = this.transcripts.peek(main.path)?.meta;
      if (!meta && allowParse) {
        const stamp = await fileStamp(main.path);
        if (stamp) meta = (await this.parse({ path: main.path, kind: "main", sessionId }, stamp))?.meta;
      }
    }
    const evidence = this.transcriptEvidence(meta, { entrypoint: hint.entrypoint, configDir: hint.configDir ?? main?.configDir }, ctx.logins, ctx.spoolBySession.get(sessionId));
    const app = ctx.app.get(sessionId);
    if (app) evidence.push(app);
    evidence.push(...accountMatches(evidence, ctx.known, { recordedOnly: !inferable(hint.entrypoint ?? meta?.entrypoint) }));
    return resolveAccount(evidence);
  }

  /**
   * Each listed session's account, for the report's byAccount: the same evidence as a live session's (its transcript's
   * account lines, the Claude app's folder for it, a terminal session's config dir login). Transcripts come from the
   * parse cache the usage scan just filled; one never parsed is read once.
   */
  async sessionAccounts(sessionIds: Iterable<string>): Promise<Map<string, ResolvedAccount>> {
    const ctx = await this.evidenceCtx(false);
    const out = new Map<string, ResolvedAccount>();
    for (const sid of new Set(sessionIds)) {
      const r = await this.resolvedFor(sid, ctx, {}, true);
      if (r.account) out.set(sid, r);
    }
    return out;
  }

  /** Each config dir's cleanupPeriodDays (and the managed settings'), re-read at most every LOGINS_TTL_MS. */
  async readRetention(maxAgeMs = LOGINS_TTL_MS): Promise<RetentionInfo[]> {
    const c = this.retentionCache;
    if (c && Date.now() - c.at < maxAgeMs) return c.infos;
    const shares = new Map<string, string[]>();
    for (const t of await this.trees()) {
      for (const r of t.roots) shares.set(r.configDir, t.roots.filter((o) => o !== r).map((o) => o.configDir));
    }
    const infos = await this.retention.read(this.roots.map((r) => r.configDir), shares);
    this.retentionCache = { at: Date.now(), infos };
    return infos;
  }

  async readAccounts(): Promise<AccountInfo[]> {
    const [logins, folders] = await Promise.all([this.readLogins(), this.readAppFolders()]);
    const found: Array<{ ev: AccountEvidence; sighting: AccountSighting }> = [];
    for (const [dir, l] of logins) if (l.state === "ok" && l.evidence) found.push({ ev: l.evidence, sighting: { ref: l.evidence.ref, loginConfigDir: dir } });
    for (const f of folders) found.push({ ev: f, sighting: { ref: f.ref, claudeAppFolder: true } });
    for (const ev of this.seenEvidence.values()) found.push({ ev, sighting: { ref: ev.ref } });
    // An account named without its organization (a transcript's artifact line) is completed by the one full id with
    // that account half (accountMatches), so it isn't listed apart; with no such id, several, or one known only as a
    // login (which never completes a desktop session's id), it is.
    const fullIds = new Map<string, Map<string, boolean>>();
    for (const x of found) {
      if (!x.ev.ref.orgKnown) continue;
      const ids = fullIds.get(x.ev.accountKey) ?? new Map<string, boolean>();
      ids.set(x.ev.ref.id, (ids.get(x.ev.ref.id) ?? false) || x.ev.ref.quality === "recorded");
      fullIds.set(x.ev.accountKey, ids);
    }
    const completes = (key: string) => {
      const ids = fullIds.get(key);
      return ids?.size === 1 && [...ids.values()][0] === true;
    };
    return accountDirectory(found.filter((x) => x.ev.ref.orgKnown || !completes(x.ev.accountKey)).map((x) => x.sighting));
  }

  private claudeBin(): string | undefined {
    if (this.opts.claudeBin) return this.opts.claudeBin;
    if (process.env.SIGNALBOX_CLAUDE_BIN) return process.env.SIGNALBOX_CLAUDE_BIN;
    const onPath = Bun.which("claude");
    return onPath && !isSwitchShim(onPath) ? onPath : undefined;
  }

  private async agents(root: Root): Promise<AgentsRun> {
    const c = root.agentsCache;
    if (c && Date.now() - c.at < (c.run.ok ? AGENTS_TTL_MS : AGENTS_FAILED_TTL_MS)) return c.run;
    // Concurrent callers (fleet, health, context in one refresh) share one child process.
    if (root.agentsInFlight) return root.agentsInFlight;
    root.agentsInFlight = (async (): Promise<AgentsRun> => {
      // `claude agents --json` initialises a missing global config file (and a backup of it), which
      // would be a write to agent config. Without that file no session has run, so there is nothing to list.
      const globalConfig = root.globalConfig;
      if (!(await exists(globalConfig))) {
        return {
          ok: false,
          skipped: true,
          reason: `not run: ${globalConfig} does not exist, so no session has used this config dir (agents --json would create the file)`,
        };
      }
      return runAgentsJson(this.claudeBin(), { timeoutMs: this.agentsTimeoutMs, env: root.agentsEnv });
    })();
    try {
      const run = await root.agentsInFlight;
      root.agentsCache = { run, at: Date.now() };
      return run;
    } finally {
      root.agentsInFlight = undefined;
    }
  }

  /** The last agents --json result whatever its age (or the first run, while it is in flight); never starts a run. */
  private async lastAgents(root: Root): Promise<AgentsRun | undefined> {
    return root.agentsCache?.run ?? root.agentsInFlight;
  }

  watchSessions(onChange: () => void): () => void {
    const watches = this.roots.map((r) =>
      watchDir(r.sessionsDir, onChange, { accept: isRegistryFileName, mode: this.opts.watchMode, pollMs: this.opts.watchPollMs }),
    );
    this.lastWatch = watches[0];
    return () => {
      for (const w of watches) w.close();
    };
  }

  sessionWatchMode(): DirWatchMode | undefined {
    return this.lastWatch?.mode;
  }

  async listSessions(opts: SessionListOptions = {}): Promise<SessionInfo[]> {
    const quick = opts.quick === true;
    const [perRoot, ctx] = await Promise.all([
      Promise.all(
        this.roots.map(async (root) => {
          const [reg, run] = await Promise.all([readRegistry(root.sessionsDir), quick ? this.lastAgents(root) : this.agents(root)]);
          const ok = run?.ok ? run : undefined;
          return mergeSessions(ok?.entries, reg.entries, isPidAlive, { agentsAt: ok?.at }).map((s): SessionInfo => ({ ...s, configDir: root.configDir }));
        }),
      ),
      this.evidenceCtx(quick),
    ]);
    // Registries are never shared between config dirs; should one session show up twice, the first dir wins.
    const sessions: SessionInfo[] = [];
    const listed = new Set<string>();
    for (const list of perRoot) {
      for (const s of list) {
        if (listed.has(s.sessionId)) continue;
        listed.add(s.sessionId);
        sessions.push(s);
      }
    }
    const idx = ctx.idx;
    await Promise.all(
      sessions.map(async (s) => {
        const path = idx.get(s.sessionId)?.path;
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
    await Promise.all(
      sessions.map(async (s) => {
        const account = await this.accountFor(s.sessionId, ctx, { entrypoint: s.entrypoint, configDir: s.configDir }, !quick);
        if (account) s.account = account;
      }),
    );
    return sessions;
  }

  async readLimits(): Promise<LimitSnapshot[]> {
    const nowMs = this.now().getTime();
    const [firstCtx, regs] = await Promise.all([this.evidenceCtx(false), Promise.all(this.roots.map((r) => readRegistry(r.sessionsDir)))]);
    let ctx = firstCtx;
    // Each live session's registry row says where it runs (entrypoint, config dir), read here rather than taken from
    // another call, so a reading's account doesn't depend on which call ran first.
    const hints = new Map<string, { entrypoint?: string; configDir?: string }>();
    regs.forEach((reg, i) => {
      for (const e of reg.entries) if (e.sessionId && !hints.has(e.sessionId)) hints.set(e.sessionId, { entrypoint: e.entrypoint, configDir: this.roots[i]!.configDir });
    });
    // Only sessions with a reading still worth showing: old spools (never deleted) would otherwise cost a transcript read each.
    const reporting = new Set(spoolsWithCurrentReadings(ctx.spools, nowMs).map((sp) => sp.sessionId));
    // A desktop session just started isn't in the app's list as last read (up to a minute ago): re-read it sooner, so
    // its readings don't sit on the "Account unknown" card and then move.
    const entrypointOf = (sid: string) => {
      const main = ctx.idx.get(sid)?.path;
      return hints.get(sid)?.entrypoint ?? (main ? this.transcripts.peek(main)?.meta.entrypoint : undefined);
    };
    if (this.claudeApp && [...reporting].some((sid) => !ctx.app.has(sid) && entrypointOf(sid) === "claude-desktop")) {
      ctx = { ...ctx, app: appEvidenceBySession(await this.readApp(APP_MISS_TTL_MS)) };
    }
    const accounts = new Map<string, AccountRef>();
    await Promise.all(
      [...reporting].map(async (sid) => {
        const account = await this.accountFor(sid, ctx, hints.get(sid) ?? {}, true);
        if (account) accounts.set(sid, account);
      }),
    );
    return limitsFromSpools(ctx.spools, (sid) => accounts.get(sid), nowMs);
  }

  async readContext(): Promise<ContextSnapshot[]> {
    // Quick: liveness and models need no fresh agents --json run (fleet lists sessions alongside).
    const [sessions, spoolRead, idx] = await Promise.all([
      this.listSessions({ quick: true }),
      readSpoolDir(this.spoolDir, this.spoolCache),
      this.indexAllMains(),
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
      const path = idx.get(sessionId)?.path;
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
    const [trees, files, regs, runs, spool, app, logins, retention] = await Promise.all([
      this.trees(),
      this.listAllTranscripts(),
      Promise.all(this.roots.map((r) => readRegistry(r.sessionsDir))),
      Promise.all(this.roots.map((r) => this.agents(r))),
      readSpoolDir(this.spoolDir, this.spoolCache),
      this.claudeAppHealth(),
      this.readLogins(0),
      this.readRetention(0),
    ]);
    const many = this.roots.length > 1;
    const where = trees
      .map((t) => (t.roots.length > 1 ? `${t.projectsDir} (shared by ${t.roots.map((r) => r.configDir).join(", ")})` : t.projectsDir))
      .join(", ");
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
    const registryText = (reg: (typeof regs)[number], root: Root) => {
      const alive = reg.entries.filter((e) => e.pid !== undefined && isPidAlive(e.pid, e.pidDomain) === true).length;
      return reg.dirExists ? `${reg.entries.length} registry files (${alive} live pids), ${reg.errors} unreadable` : `no registry dir at ${root.sessionsDir}`;
    };
    const agentsText = (run: AgentsRun) =>
      run.ok ? `${run.entries.length} sessions from ${run.bin} agents --json (${run.ms} ms)` : `${run.reason}${run.bin ? ` [${run.bin}]` : ""}; sessions come from the registry only`;
    const perRoot = (text: (i: number) => string) => (many ? this.roots.map((r, i) => `${r.configDir}: ${text(i)}`).join("; ") : text(0));
    const st = this.accountStats;
    const withAccount = st ? st.app + st.transcript + st.inferred : 0;
    const l = this.ledgerStats;
    const t = this.titleStats;
    const titled = t ? (t.custom ?? 0) + (t.ai ?? 0) + (t["agent-name"] ?? 0) : 0;
    return [
      {
        name: "claude-code:transcripts",
        stability: "internal",
        // Unreadable transcripts mean missing usage; unparsable lines are usually a live file's last line.
        ok: files.length > 0 && (s?.readErrors ?? 0) === 0,
        detail: files.length > 0 ? `${files.length} transcripts in ${where} (${kinds})${scan}` : `no transcripts in ${where}`,
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
        ok: runs.every((run) => run.ok || run.skipped === true),
        detail: perRoot((i) => agentsText(runs[i]!)),
      },
      {
        name: "claude-code:registry",
        stability: "internal",
        ok: regs.every((reg) => reg.dirExists),
        detail: perRoot((i) => registryText(regs[i]!, this.roots[i]!)),
      },
      {
        name: "claude-code:logins",
        stability: "internal",
        ok: [...logins.values()].every((l) => l.state === "ok" || l.state === "missing"),
        detail: `${perRoot((i) => loginText(logins.get(this.roots[i]!.configDir)))} (Claude Code's global config: the two oauthAccount ids only, hashed; read-only)`,
      },
      {
        name: "claude-code:accounts",
        stability: "internal",
        ok: true,
        detail: st
          ? `last history: ${withAccount} of ${st.sessions} sessions have an account (${st.app} from the Claude app's folder names, ` +
            `${st.transcript} from transcript account lines, ${st.inferred} inferred from a config dir's current login)` +
            (st.conflicts ? `, ${st.conflicts} with recorded sources that disagree` : "") +
            `; ${this.seenEvidence.size} account ids recorded so far`
          : "read with the history: the Claude app's folder names, transcript account lines, and each config dir's login for terminal sessions",
      },
      {
        name: "claude-code:retention",
        stability: "documented",
        // Whether the setting could be read, and is valid; how short is too short is the app's (and doctor's) call.
        ok: retention.every((r) => r.problem === undefined && r.invalid === undefined),
        detail:
          `${perRoot((i) => retentionText(retention[i]!))} ` +
          "(cleanupPeriodDays only, from settings.json and the managed settings; project settings files aren't read)",
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
