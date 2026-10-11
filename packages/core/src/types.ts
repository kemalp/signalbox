// Signalbox contract. Every adapter, the CLI and the web UI build against these types.
// Rule of thumb: missing data is `undefined` (unknown), never 0.

/** Which coding agent a record came from. Open-ended so new adapters don't need a core change. */
export type AgentId = "claude-code" | "codex" | "gemini-cli" | (string & {});

/** How much we trust a data source to survive upstream releases. Shown as a badge in the UI. */
export type Stability = "documented" | "preview" | "internal";

/** Token counts for one API response (or a sum of them). All fields are non-negative integers. */
export interface TokenCounts {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens, including reasoning/thinking tokens when the agent reports them inside output. */
  output: number;
  cacheRead: number;
  /** Cache writes with a 5-minute TTL (Anthropic: 1.25x input). Providers with a single cache TTL (OpenAI) use this field. */
  cacheWrite5m: number;
  /** Cache writes with a 1-hour TTL (Anthropic: 2x input). */
  cacheWrite1h: number;
  /** Reasoning tokens when reported separately; informational, already counted in `output` if the agent includes them there. */
  reasoning?: number;
}

export type RecordKind = "main" | "subagent" | "workflow" | "auxiliary" | "other";

/** One deduplicated model API response, normalized across agents. Content is never stored. */
export interface UsageRecord {
  agent: AgentId;
  /** Dedup key, unique within `agent`. */
  id: string;
  /** How the key was derived. `hash` rows are flagged in the UI (double-count risk). */
  keyQuality: "id" | "request" | "hash";
  sessionId: string;
  /** Absolute project directory (cwd) when known. */
  project?: string;
  kind: RecordKind;
  /** Model id exactly as the agent reported it. */
  model: string;
  /** ISO-8601 timestamp. */
  ts: string;
  tokens: TokenCounts;
  /** False when `tokens.output` is a known lower bound (e.g. a streaming placeholder that never got its final value). */
  outputFinal: boolean;
  /** Data-quality flags, e.g. "iteration-split" when the response was priced per usage.iterations[] entry. */
  flags?: Array<"iteration-split" | (string & {})>;
  webSearchRequests: number;
  /** e.g. Anthropic `inference_geo`; affects price multipliers. */
  geo?: string;
  speed?: "standard" | "fast";
  /** Source file, for debugging only. Never shown with content. */
  sourcePath?: string;
}

/** USD cost of a record or group, split by token type. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  total: number;
}

/** The five per-token rates of one price tier, USD per million tokens. */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** A price row, USD per million tokens. */
export interface ModelPrice extends TokenRates {
  /** Optional tier that applies when a single request's total input exceeds `thresholdTokens`. */
  longContext?: { thresholdTokens: number } & TokenRates;
  /** Fast-mode rates (`speed: "fast"`), caching multipliers already applied. Replaces the base and long-context tiers. */
  fast?: TokenRates;
  /** USD per web search request. */
  webSearchPerRequest?: number;
}

/** A provider price file, e.g. pricing/anthropic.json. */
export interface PriceTable {
  provider: string;
  asOf: string;
  sourceUrl: string;
  currency: "USD";
  /** Keys are exact model ids or prefixes ending in `*` (longest match wins). */
  models: Record<string, ModelPrice>;
  /** Multipliers keyed by geo value, e.g. { "us": 1.1 }. */
  geoMultipliers?: Record<string, number>;
  notes?: string[];
}

/** Documented limits of one model (or a `prefix*` family of snapshots). */
export interface ModelSpec {
  /** Max input tokens of one request, i.e. the context window. */
  contextWindow: number;
  /** Max output tokens of one synchronous request, when documented. */
  maxOutput?: number;
  /** When `sourceUrl` was read. */
  asOf: string;
  sourceUrl: string;
}

/** What one agent was seen doing with these models (not documented by the vendor). */
export interface AgentModelNotes {
  stability: Stability;
  /** e.g. "Claude Code 2.1.293". */
  observedIn: string;
  asOf: string;
  source: string;
  /** Model-id suffixes that set the window, e.g. { "[1m]": 1000000 }. */
  idTags?: Record<string, number>;
  /** Auto-compaction thresholds seen per context window. A window with no entry has no known threshold. */
  autoCompact?: Array<{ contextWindow: number; thresholdTokens: number; observedModel?: string }>;
  notes?: string[];
}

/** A provider model file, e.g. models/anthropic.json. */
export interface ModelTable {
  provider: string;
  asOf: string;
  sourceUrl: string;
  /** Keys are exact model ids or prefixes ending in `*` (longest match wins), like PriceTable. */
  models: Record<string, ModelSpec>;
  /** Keyed by AgentId. */
  agents?: Record<string, AgentModelNotes>;
  notes?: string[];
}

/** An agent's own cost figure for a session (e.g. Claude Code `cost-state` rows). */
export interface LedgerEntry {
  agent: AgentId;
  sessionId: string;
  model: string;
  /**
   * Session sums. Cache writes: ledgers such as Claude Code cost-state have no 5m/1h split; put the
   * total in either field and core re-splits it by the session's own transcript share.
   */
  tokens: TokenCounts;
  /** Web search requests counted by the agent's own ledger, when reported. */
  webSearchRequests?: number;
  costUsd: number;
  /** ISO timestamp if known; Claude Code cost-state rows have none, so the file mtime is used. */
  observedAt?: string;
  source: string;
}

export type SessionStatus = "busy" | "waiting" | "idle" | "ended" | "unknown";

/** A live or recently seen agent session. */
export interface SessionInfo {
  agent: AgentId;
  sessionId: string;
  pid?: number;
  cwd?: string;
  name?: string;
  status: SessionStatus;
  /** ISO timestamp of the last status change, if known. */
  statusSince?: string;
  /**
   * What a "waiting" session waits for, as the agent labels it. Claude Code writes "permission prompt",
   * "input needed", "dialog open", "sandbox request" and "goal proposal" (2.1.293); others pass through.
   * A short label, never message content (longer or free-form values are dropped). Set only while
   * `status` is "waiting"; undefined when the agent doesn't say.
   */
  waitingFor?: string;
  /** e.g. "claude-desktop", "cli", "sdk". */
  entrypoint?: string;
  /** e.g. "interactive", "background" (Claude Code agents --json `kind`). */
  kind?: string;
  version?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  lastActivity?: string;
  /** Which adapter source produced this row, e.g. "agents --json", "registry". */
  source: string;
}

/** A plan/rate-limit reading. Limits are account-wide; the freshest reading per (agent, kind) wins. */
export interface LimitSnapshot {
  agent: AgentId;
  /** e.g. "five_hour", "seven_day", "seven_day_fable", "codex.primary". Unknown kinds are kept verbatim. */
  kind: string;
  label?: string;
  usedPercent: number;
  /** ISO timestamp. */
  resetsAt?: string;
  windowMinutes?: number;
  /** ISO timestamp of when this reading was taken. */
  observedAt: string;
  plan?: string;
  sessionId?: string;
  source: string;
}

export interface ContextSnapshot {
  agent: AgentId;
  sessionId: string;
  tokens: number;
  window?: number;
  /**
   * Where `window` came from: "agent" (reported with the reading: the tap spool, Codex's
   * model_context_window) or "model-table" (Signalbox's models/*.json: the documented size, or a
   * Claude Code "[1m]" model-id suffix). Set whenever `window` is.
   */
  windowSource?: "agent" | "model-table" | (string & {});
  percent?: number;
  /** Where auto-compaction kicks in, as a percent of the window, if known. */
  autoCompactAtPercent?: number;
  observedAt: string;
  /** "official" (agent-reported) or "estimated" (derived from the last main-thread request). */
  quality: "official" | "estimated";
  source: string;
}

export interface CompactionEvent {
  agent: AgentId;
  sessionId: string;
  ts: string;
  trigger: "manual" | "auto" | "unknown";
  preTokens?: number;
}

export interface AdapterHealth {
  /** e.g. "claude-code:transcripts". */
  name: string;
  stability: Stability;
  ok: boolean;
  detail: string;
}

export interface ScanOptions {
  /** Inclusive. */
  since?: Date;
  /** Exclusive. */
  until?: Date;
  /**
   * Also yield the records outside [since, until) of every session that has activity in the range,
   * so reconciliation can compare whole sessions against a ledger. Adapters without a ledger may
   * ignore it. Consumers must filter to the range themselves when they set it.
   */
  wholeSessions?: boolean;
}

export interface SessionListOptions {
  /**
   * Answer from cheap local reads only: reuse the last result of any source that spawns a process
   * (Claude Code's `agents --json`) instead of running it again. For status pushes between polls.
   */
  quick?: boolean;
}

export interface HistoryOptions {
  /** Sessions with activity at or after this time. Adapters may skip files untouched since then. */
  since?: Date;
  /** Exclusive: sessions that started before this time. */
  until?: Date;
}

/** One adapter per agent. Every method except `detect`/`health`/`scanUsage` is optional. */
export interface Adapter {
  id: AgentId;
  displayName: string;
  /** True if this agent's data exists on this machine. Must be cheap. */
  detect(): Promise<boolean>;
  health(): Promise<AdapterHealth[]>;
  /** Deduplicated usage records in the time range. */
  scanUsage(opts: ScanOptions): AsyncIterable<UsageRecord>;
  listSessions?(opts?: SessionListOptions): Promise<SessionInfo[]>;
  /**
   * Calls `onChange` soon after a session's status may have changed (e.g. Claude Code rewrote a
   * session registry file), so a consumer can list sessions again (`quick`) between polls. May fire
   * spuriously and in bursts; consumers debounce. Returns a function that stops watching.
   */
  watchSessions?(onChange: () => void): () => void;
  readLedger?(opts: ScanOptions): Promise<LedgerEntry[]>;
  readLimits?(): Promise<LimitSnapshot[]>;
  readContext?(): Promise<ContextSnapshot[]>;
  readCompactions?(opts: ScanOptions): Promise<CompactionEvent[]>;
  /**
   * Past (and live) sessions with their titles, metadata and every usage record, deduplicated like
   * `scanUsage`. Core prices them (`buildHistory`). Titles only: never prompts, message bodies or tool output.
   */
  listHistory?(opts?: HistoryOptions): Promise<HistorySession[]>;
}

// ---------- Report shapes (served at /api/report and printed by `signalbox report --json`) ----------

export interface Totals {
  tokens: TokenCounts;
  cost: CostBreakdown;
  responses: number;
  /** Responses whose output is a lower bound. */
  placeholderResponses: number;
  /** Tokens on records whose model has no price row (cost counted as 0). */
  unpricedTokens: number;
  unpricedModels: string[];
}

export interface GroupTotals extends Totals {
  key: string;
}

/** A byDay row, split by model and kind for stacked daily charts. */
export interface DayTotals extends GroupTotals {
  byModel?: GroupTotals[];
  byKind?: GroupTotals[];
}

export interface ReconciliationRow {
  agent: AgentId;
  sessionId: string;
  project?: string;
  /** Our transcript-priced cost for this session. */
  transcriptUsd: number;
  /** The agent's own ledger figure, priced with the same table, when available. */
  ledgerUsd?: number;
  /** transcriptUsd / ledgerUsd. */
  k?: number;
  placeholderShare: number;
}

export interface Report {
  generatedAt: string;
  range: { since: string; until: string };
  totals: Totals & {
    /** input + output + cacheRead + cacheWrite5m + cacheWrite1h */
    processedTokens: number;
    /** input + cacheWrite5m + cacheWrite1h + output */
    freshTokens: number;
    /** cacheRead / (cacheRead + cacheWrite5m + cacheWrite1h + input); 0 when there are no prompt tokens (check processedTokens). */
    cacheHitRatio: number;
    /** Gross: cacheRead * (P_in - P_read), at list price. */
    savedByCachingUsd: number;
  };
  byAgent: GroupTotals[];
  byModel: GroupTotals[];
  /** Keyed by each session's project: the cwd of its earliest main-thread record, else of its earliest record. */
  byProject: GroupTotals[];
  byKind: GroupTotals[];
  /** One row per local calendar day (YYYY-MM-DD), oldest first. */
  byDay: DayTotals[];
  reconciliation: ReconciliationRow[];
  estimate: {
    /** Sum of transcript-priced records: a lower bound. */
    recordedUsd: number;
    estimatedLowUsd: number;
    estimatedHighUsd: number;
    method: string;
  };
  priceTables: Array<{ provider: string; asOf: string; sourceUrl: string }>;
  notes: string[];
}

export interface FleetSession extends SessionInfo {
  costUsd?: number;
  context?: ContextSnapshot;
}

/** Served at /api/fleet. */
export interface FleetSnapshot {
  generatedAt: string;
  sessions: FleetSession[];
  /** Freshest reading per (agent, kind). */
  limits: LimitSnapshot[];
  compactions: CompactionEvent[];
  health: AdapterHealth[];
}

// ---------- Session history (`signalbox history --json`, the watch stream's "history" line) ----------
// The only text is a session's title: Claude Code's `custom-title` / `ai-title` / `agent-name` transcript lines,
// Codex `session_index.jsonl` names and the Claude app's own session titles, sanitized (one line, no control
// characters, at most 120 characters). Prompts (including `last-prompt` lines), message bodies, summaries and tool
// output are never read into it.
// Sessions come from transcripts (or rollouts) and, for Claude Code, from the Claude app's own session list
// (AppSessionRecord), which also keeps sessions whose transcripts are gone. Such an app-only entry has
// `hasTranscript: false` and no figures: its responses, tokens and cost are unknown (undefined), never 0.

/**
 * Where a title came from: "custom" (Claude Code `custom-title`: set with /rename or written by the Claude app; the
 * last one wins), "ai" (`ai-title`, generated), "agent-name" (`agent-name`), "index" (Codex session_index name),
 * "app" (the Claude app's own session list; `appTitleSource` has the app's raw label), "none".
 */
export type HistoryTitleSource = "custom" | "ai" | "agent-name" | "index" | "app" | "none";

/** How to pick a session up again: the agent's own command, to run in `cwd`. */
export interface HistoryResume {
  /** e.g. "claude --resume <id>", "codex resume <id>". The id is checked to be shell-safe. */
  command: string;
  cwd?: string;
}

/**
 * One session as a vendor's desktop app lists it (the Claude app's per-session records), allow-listed fields only
 * and already validated. Read-only: Signalbox never writes the app's files. Everything not named here is dropped
 * as soon as a record is parsed.
 */
export interface AppSessionRecord {
  agent: AgentId;
  /** The app's own id for the session, e.g. "local_<uuid>". Shell-safe. */
  appSessionId: string;
  /** The agent's session id (Claude Code: the transcript's sessionId), when the app knows it. Shell-safe. */
  agentSessionId?: string;
  /** Already sanitized (see sanitizeTitle). */
  title?: string;
  /** The app's raw label for how the title was set (Claude app: "auto" when it generated it), a short identifier. */
  titleSource?: string;
  cwd?: string;
  /** The folder the session was started from, when it runs in another one (e.g. a worktree). */
  originCwd?: string;
  /** ISO. */
  createdAt?: string;
  /** ISO. */
  lastActivityAt?: string;
  archived?: boolean;
  model?: string;
  effort?: string;
  /**
   * The app says it has no transcript for the session. Informational: mergeAppSessions still joins the record to a
   * transcript that is on this Mac (the file is the better evidence); without one the record is app-only anyway.
   */
  transcriptUnavailable?: boolean;
}

/** One session as an adapter reads it, before pricing. Core turns it into a SessionHistoryEntry. */
export interface HistorySession {
  agent: AgentId;
  sessionId: string;
  /** Already sanitized (see sanitizeTitle). */
  title?: string;
  titleSource: HistoryTitleSource;
  /** The app's raw title label when `titleSource` is "app". */
  appTitleSource?: string;
  /** The session's project: the cwd of its earliest main-thread record (like Report.byProject), when known. */
  project?: string;
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  /**
   * ISO: the first and last line timestamps over the session's files (main transcript, subagents, workflows). A
   * merge with an app record widens them to the app's created and last-activity times (mergeAppSessions).
   */
  startedAt: string;
  lastActivityAt: string;
  /**
   * ISO: the transcript's own first and last line, kept by mergeAppSessions before it widens startedAt and
   * lastActivityAt; the duration is measured between them. Unset means startedAt/lastActivityAt are the transcript's.
   */
  transcriptStartedAt?: string;
  transcriptLastAt?: string;
  /** Every usage record of the session, all files, deduplicated like scanUsage. */
  records: UsageRecord[];
  /** The agent's own ledger rows for the session (Claude Code cost-state), if any. */
  ledger?: LedgerEntry[];
  /** False for a session known only from an app's list (no transcript): no records, figures unknown. Default true. */
  hasTranscript?: boolean;
  /** Set for sessions with a transcript. */
  compactions?: number;
  subagentFiles?: number;
  workflowRuns?: number;
  resume?: HistoryResume;
  transcriptPath?: string;
  /** The app's own id, when an app lists the session (AppSessionRecord.appSessionId). */
  appSessionId?: string;
  /** From the app's list: archived there. Undefined when no app lists the session. */
  archived?: boolean;
  /** The model the app last set, for a session with no records to take models from. */
  model?: string;
  /** The effort level the app last set. */
  effort?: string;
}

export interface SessionHistoryEntry {
  agent: AgentId;
  /** The agent's session id; for an app-only session the app doesn't link to one, the app's id. */
  sessionId: string;
  title?: string;
  titleSource: HistoryTitleSource;
  /** The app's raw title label ("auto": the Claude app generated the title) when `titleSource` is "app". */
  appTitleSource?: string;
  project?: string;
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  /**
   * ISO. First and last line timestamps of the main transcript and its subagent/workflow files; for a session the
   * Claude app lists, also its created and last-activity times (the earliest start and the latest activity win).
   */
  startedAt: string;
  lastActivityAt: string;
  /**
   * With a transcript: from its first to its last line (main, subagents, workflows), whatever the Claude app's own
   * times say. App-only: from the app's created time to its last activity.
   */
  durationMs: number;
  /** Listed in the current fleet as busy, waiting or idle. */
  live: boolean;
  /** False for a session known only from the Claude app's list: no transcript, so no figures and no resume command. */
  hasTranscript: boolean;
  /** The Claude app's id for the session ("local_<uuid>"), when the app lists it. */
  appSessionId?: string;
  /** Archived in the Claude app. Undefined when the app doesn't list the session. */
  archived?: boolean;
  /** Model ids as reported, by transcript cost (highest first); an app-only session has the app's model. */
  models: string[];
  /** The effort level the Claude app last set for the session. */
  effort?: string;
  // Figures: set whenever `hasTranscript` is true, undefined (unknown) for an app-only session.
  responses?: number;
  tokens?: TokenCounts;
  /** Transcript-priced list-price equivalent (a lower bound, like Report's recorded $). */
  costUsd?: number;
  /** Tokens on records whose model has no price row (counted at $0). */
  unpricedTokens?: number;
  /** Responses with a placeholder output count / responses; 0 when there are none. */
  placeholderShare?: number;
  /** The agent's own ledger figure (Claude Code cost-state) priced with the same table, like ReconciliationRow.ledgerUsd. */
  ledgerUsd?: number;
  /** Compactions of the main thread. */
  compactions?: number;
  subagentFiles?: number;
  workflowRuns?: number;
  resume?: HistoryResume;
  transcriptPath?: string;
}

/** Why the Claude app's session list was not read (HistorySources.claudeApp.off). */
export type ClaudeAppOffReason = "flag" | "claude-config-dir";

/** Where a history's sessions came from. Counts cover the sessions that matched, before the limit. */
export interface HistorySources {
  /** Sessions with a transcript (or rollout). */
  transcripts: number;
  /** The Claude app's session list; absent when Claude Code isn't part of the history (e.g. --agent codex). */
  claudeApp?: {
    /** False when nothing was read: --no-claude-app (the app's Settings ▸ Advanced switch), or see `off`. */
    enabled: boolean;
    /**
     * Why it is off, when `enabled` is false: "flag" (--no-claude-app) or "claude-config-dir" (CLAUDE_CONFIG_DIR
     * points away from ~/.claude, whose sessions the app's list describes, and SIGNALBOX_CLAUDE_APP_DIR is unset).
     */
    off?: ClaudeAppOffReason;
    /** Session records read from the app's list (all of them, whatever the window). */
    records: number;
    /** Sessions with both an app record and a transcript. */
    merged: number;
    /** Sessions from an app record alone (hasTranscript false). */
    appOnly: number;
    /** Sessions the app marks archived. */
    archived: number;
  };
}

/** `signalbox history --json`, and the data of the watch stream's "history" line. */
export interface HistorySnapshot {
  v: 1;
  generatedAt: string;
  /** Newest lastActivityAt first, at most the requested limit. */
  entries: SessionHistoryEntry[];
  /** Sessions that matched before the limit was applied. */
  total: number;
  /** True when `total` > `entries.length`. */
  truncated: boolean;
  sources?: HistorySources;
}

// ---------- Spool format written by the signalbox-tap mod (one file per session) ----------
// Path: ~/Library/Application Support/signalbox/spool/<sessionId>.json. The mod cannot set modes ($.fs.write creates
// missing dirs with the default umask), so the CLI creates the dir 0700 before first use and `doctor` reports its mode.
// The mod's fs API has no rename, so writes are not atomic: readers must tolerate a parse failure and retry.
// Readers take only files whose parsed `v === 1` (the Day-0 probe also writes spike-results-<sid>.json here).
// Order by `writtenAt`, then `seq`: seq continues across hot reloads but restarts at 1 if the old file was torn.
// After /clear the old id gets `session.end` and the new id starts at `session.measure` (no `session.start`).

export interface TapSpool {
  v: 1;
  seq: number;
  agent: "claude-code";
  sessionId: string;
  /** ISO timestamp of when the mod wrote this. */
  writtenAt: string;
  event: "session.start" | "session.measure" | "session.end";
  usage?: {
    /** `tokens`/`percent` are absent until a response of the live window reports a fill. */
    context?: { tokens?: number; window?: number; percent?: number };
    rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
    cost?: { usd: number };
  };
}

// ---------- Command guide (catalog/commands/<agent>.json, `signalbox commands --json`) ----------
// The built-in slash commands and useful shell commands of each agent, researched on one installed
// version and embedded in the binary like the price tables, plus the custom commands found on disk.

export type CommandCategory =
  | "session"
  | "context"
  | "model"
  | "info"
  | "config"
  | "account"
  | "tools"
  | "navigation"
  | "integrations"
  | "debug"
  | "other";

/** Where a command can be used. "partial": only some forms or hosts; "unknown": not verified. */
export interface CommandSurfaces {
  terminal: boolean | "unknown";
  /** The vendor's desktop app (Claude Code's Code tab, the ChatGPT desktop app). */
  desktop: boolean | "partial" | "unknown";
  /** Non-interactive runs (`claude -p`, the Agent SDK, `codex exec`, `gemini -p`). */
  headless: boolean | "partial" | "unknown";
  remoteControl: boolean | "unknown";
}

/**
 * What Signalbox does about a command: "view" it already shows the same information (in `view` when
 * that is one of the app's screens), "planned" it could run it through the opt-in session mod, "no" it is
 * interactive-only or not useful from outside (copy it and run it in the session), "never" deliberately
 * not offered (destructive or sensitive).
 */
export type CommandSignalboxStatus = "view" | "planned" | "no" | "never";
export type CommandSignalboxView = "sessions" | "usage" | "limits" | "health";

export interface CommandEntry {
  /** "/compact" for slash commands, "claude agents --json" for shell commands. */
  name: string;
  aliases?: string[];
  /** Argument hint, e.g. "[instructions]". */
  args?: string;
  /** One plain sentence, at most 90 characters. */
  summary: string;
  /** A few plain sentences: what happens, when to use it. */
  details?: string;
  category: CommandCategory;
  surfaces: CommandSurfaces;
  /** e.g. "In the terminal this saves your global default model". */
  sideEffects?: string;
  signalbox: { status: CommandSignalboxStatus; view?: CommandSignalboxView; note: string };
  verified: { method: "binary" | "help" | "docs" | "observed"; version: string };
  sourceUrl?: string;
}

/** One agent's catalog file. */
export interface CommandCatalog {
  agent: AgentId;
  displayName: string;
  /** The agent version the catalog was checked against. */
  verifiedVersion: string;
  /** YYYY-MM-DD. */
  asOf: string;
  sources: string[];
  commands: CommandEntry[];
  cliCommands: CommandEntry[];
}

export type CustomCommandKind = "command" | "skill" | "prompt" | "plugin-command" | "plugin-skill";

/** A user-, project- or plugin-defined command found on disk. Names and descriptions only, never file bodies. */
export interface CustomCommand {
  agent: AgentId;
  /** As typed: "/my-cmd", "/git:fix", "/plugin:cmd", Codex skills "$my-skill". */
  name: string;
  /** The frontmatter (or TOML) description: one line, at most 200 characters. */
  description?: string;
  kind: CustomCommandKind;
  scope: "user" | "project" | "plugin";
  /** The file ("~/.claude/commands/my-cmd.md") or, for plugins, the plugin name. */
  source: string;
  /**
   * The directory whose agent folder (.claude/, .agents/, .gemini/) holds the command, for project scope
   * (and plugins installed for one project). It applies to sessions whose cwd is that directory or below it.
   */
  project?: string;
}

/** `signalbox commands --json`, and the data of the watch stream's "commands" line. */
export interface CommandsSnapshot {
  v: 1;
  generatedAt: string;
  /** Installed agent versions from `<agent> --version`; an agent that isn't found is absent. */
  installed: Partial<Record<AgentId, string>>;
  catalogs: CommandCatalog[];
  custom: CustomCommand[];
}
