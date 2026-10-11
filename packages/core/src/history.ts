// Session history: adapters hand over each session's titles, metadata and usage records (HistorySession),
// optionally folded together with an app's own session list (mergeAppSessions); this prices them with the same
// rules as the report and lists them newest first.
import { newestLedgerByModel, priceLedgerRow } from "./ledger.ts";
import { addTokens, canonicalModel, priceRecord, processedTokens, zeroTokens } from "./pricing.ts";
import { countsAsResponse } from "./report.ts";
import type {
  AgentId,
  AppSessionRecord,
  ClaudeAppOffReason,
  HistorySession,
  HistorySnapshot,
  HistorySources,
  HistoryTitleSource,
  PriceTable,
  SessionHistoryEntry,
  SessionStatus,
  UsageRecord,
} from "./types.ts";

export const MAX_TITLE_CHARS = 120;
/** `signalbox history` and the watch line list at most this many sessions by default. */
export const DEFAULT_HISTORY_LIMIT = 500;

/** Statuses that make a history entry `live`. */
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "waiting", "idle"]);

// Control characters (C0, DEL, C1) and the invisible bidi/direction marks that can reorder how a title reads.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPACES = /[\s\u2028\u2029]+/g;

/**
 * A title (or other one-line label) fit to show: one line, no control or bidi characters, collapsed
 * whitespace, at most `max` characters (longer ones end in "…"). Undefined for anything empty or not a string.
 */
export function sanitizeTitle(raw: unknown, max = MAX_TITLE_CHARS): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Whitespace (newlines, tabs) becomes a space before the other control characters are dropped.
  const s = raw.replace(SPACES, " ").replace(INVISIBLE, "").replace(SPACES, " ").trim();
  if (s.length === 0) return undefined;
  const chars = Array.from(s); // code points, so a cut never splits a surrogate pair
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

export interface TitleCandidates {
  /** Claude Code `custom-title` (the last line's value). */
  custom?: string;
  /** Claude Code `ai-title`. */
  ai?: string;
  /** Claude Code `agent-name`. */
  agentName?: string;
  /** Codex session_index name. */
  index?: string;
}

/** Priority custom > ai > agent-name > index; each candidate is sanitized first. */
export function chooseTitle(c: TitleCandidates): { title?: string; titleSource: HistoryTitleSource } {
  const order: Array<[HistoryTitleSource, unknown]> = [
    ["custom", c.custom],
    ["ai", c.ai],
    ["agent-name", c.agentName],
    ["index", c.index],
  ];
  for (const [source, raw] of order) {
    const title = sanitizeTitle(raw);
    if (title) return { title, titleSource: source };
  }
  return { titleSource: "none" };
}

/** A resume command only for ids that are safe to paste into a shell. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resumeCommand(prefix: string, sessionId: string, cwd?: string): { command: string; cwd?: string } | undefined {
  if (!SAFE_ID.test(sessionId)) return undefined;
  return cwd ? { command: `${prefix} ${sessionId}`, cwd } : { command: `${prefix} ${sessionId}` };
}

export function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}\u0000${sessionId}`;
}

/** The project rule of Report.byProject: the cwd of the earliest main-thread record, else of the earliest record. */
export function projectOf(records: readonly UsageRecord[]): string | undefined {
  let best: { project: string; main: boolean; t: number } | undefined;
  for (const r of records) {
    if (!r.project) continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    const main = r.kind === "main";
    if (!best || (main && !best.main) || (main === best.main && t < best.t)) best = { project: r.project, main, t };
  }
  return best?.project;
}

/**
 * Prices one session. `live`: listed in the current fleet as busy, waiting or idle. A session without a transcript
 * (`hasTranscript: false`, from an app's list alone) gets no figures: they are unknown, not 0. The duration of a
 * session with a transcript spans its own lines, not the app's (possibly much later) last activity.
 */
export function historyEntry(s: HistorySession, tables: readonly PriceTable[], live: boolean): SessionHistoryEntry {
  const tokens = zeroTokens();
  let cost = 0;
  let responses = 0;
  let placeholders = 0;
  let unpricedTokens = 0;
  const byModel = new Map<string, { cost: number; tokens: number }>();
  // Transcript cache writes per canonical model: the ledger's 5m/1h re-split, like reconciliation.
  const writes = new Map<string, { cacheWrite5m: number; cacheWrite1h: number }>();
  for (const r of s.records) {
    const pr = priceRecord(r, tables);
    addTokens(tokens, r.tokens);
    cost += pr.cost.total;
    if (countsAsResponse(r)) {
      responses++;
      if (!r.outputFinal) placeholders++;
    }
    const processed = processedTokens(r.tokens);
    if (!pr.priced) unpricedTokens += processed;
    const m = byModel.get(r.model) ?? { cost: 0, tokens: 0 };
    m.cost += pr.cost.total;
    m.tokens += processed;
    byModel.set(r.model, m);
    const cm = canonicalModel(r.model);
    const w = writes.get(cm) ?? { cacheWrite5m: 0, cacheWrite1h: 0 };
    w.cacheWrite5m += r.tokens.cacheWrite5m;
    w.cacheWrite1h += r.tokens.cacheWrite1h;
    writes.set(cm, w);
  }
  const hasTranscript = s.hasTranscript !== false;
  const started = Date.parse((hasTranscript && s.transcriptStartedAt) || s.startedAt);
  const last = Date.parse((hasTranscript && s.transcriptLastAt) || s.lastActivityAt);
  const models = [...byModel]
    .sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
    .map(([m]) => m);
  if (models.length === 0 && s.model) models.push(s.model);
  const entry: SessionHistoryEntry = {
    agent: s.agent,
    sessionId: s.sessionId,
    titleSource: s.title ? s.titleSource : "none",
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    durationMs: Number.isFinite(started) && Number.isFinite(last) ? Math.max(0, last - started) : 0,
    live,
    hasTranscript,
    models,
  };
  if (hasTranscript) {
    entry.responses = responses;
    entry.tokens = tokens;
    entry.costUsd = cost;
    entry.unpricedTokens = unpricedTokens;
    entry.placeholderShare = responses > 0 ? placeholders / responses : 0;
    if (s.compactions !== undefined) entry.compactions = s.compactions;
    if (s.subagentFiles !== undefined) entry.subagentFiles = s.subagentFiles;
    if (s.workflowRuns !== undefined) entry.workflowRuns = s.workflowRuns;
  }
  if (s.title) entry.title = s.title;
  if (s.title && s.titleSource === "app" && s.appTitleSource) entry.appTitleSource = s.appTitleSource;
  const project = s.project ?? projectOf(s.records);
  if (project) entry.project = project;
  if (s.gitBranch) entry.gitBranch = s.gitBranch;
  if (s.entrypoint) entry.entrypoint = s.entrypoint;
  if (s.version) entry.version = s.version;
  if (s.effort) entry.effort = s.effort;
  if (s.appSessionId) entry.appSessionId = s.appSessionId;
  if (s.archived !== undefined) entry.archived = s.archived;
  if (hasTranscript && s.ledger && s.ledger.length > 0) {
    let usd = 0;
    for (const [m, e] of newestLedgerByModel(s.ledger)) usd += priceLedgerRow(e, writes.get(m), tables).usd;
    entry.ledgerUsd = usd;
  }
  if (hasTranscript && s.resume) entry.resume = { ...s.resume };
  if (hasTranscript && s.transcriptPath) entry.transcriptPath = s.transcriptPath;
  return entry;
}

function minIso(a: string, b: string | undefined): string {
  return b !== undefined && Date.parse(b) < Date.parse(a) ? b : a;
}

function maxIso(a: string, b: string | undefined): string {
  return b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;
}

/** The newer of two app records for the same session (by last activity, then creation). */
function newerApp(a: AppSessionRecord, b: AppSessionRecord): AppSessionRecord {
  const t = (r: AppSessionRecord) => Date.parse(r.lastActivityAt ?? r.createdAt ?? "") || -Infinity;
  return t(b) > t(a) ? b : a;
}

/**
 * Folds an app's session list into the sessions read from transcripts. An app record whose `agentSessionId` names
 * a transcript session joins it: the app's title wins (titleSource "app"), the earliest start and the latest
 * activity win (the transcript's own span is kept as transcriptStartedAt/transcriptLastAt, for the duration), and
 * archived, effort and the app's id come from the app; the transcript keeps its figures. This holds even when the
 * record says `transcriptUnavailable`: the transcript on this Mac is the better evidence, and an app-only copy
 * would lose to it in buildHistory anyway. Any other record (no agent id, or no such transcript) becomes a session
 * of its own with `hasTranscript: false`, no records and no resume command; a record with no usable time is left
 * out. When the app lists one agent session twice, the record with the latest activity counts.
 */
export function mergeAppSessions(sessions: readonly HistorySession[], app: readonly AppSessionRecord[]): HistorySession[] {
  const out = sessions.map((s) => ({ ...s }));
  const byKey = new Map<string, HistorySession>();
  for (const s of out) byKey.set(sessionKey(s.agent, s.sessionId), s);
  const latest = new Map<string, AppSessionRecord>();
  for (const r of app) {
    if (!r.agentSessionId) continue;
    const key = sessionKey(r.agent, r.agentSessionId);
    const prev = latest.get(key);
    latest.set(key, prev ? newerApp(prev, r) : r);
  }
  for (const r of app) {
    const key = r.agentSessionId ? sessionKey(r.agent, r.agentSessionId) : undefined;
    if (key && latest.get(key) !== r) continue; // an older record of the same session
    const s = key ? byKey.get(key) : undefined;
    if (s) joinApp(s, r);
    else {
      const alone = appOnlySession(r);
      if (alone) out.push(alone);
    }
  }
  return out;
}

function joinApp(s: HistorySession, r: AppSessionRecord): void {
  const title = sanitizeTitle(r.title);
  if (title) {
    s.title = title;
    s.titleSource = "app";
    if (r.titleSource) s.appTitleSource = r.titleSource;
    else delete s.appTitleSource;
  }
  s.transcriptStartedAt ??= s.startedAt;
  s.transcriptLastAt ??= s.lastActivityAt;
  s.startedAt = minIso(s.startedAt, r.createdAt);
  s.lastActivityAt = maxIso(s.lastActivityAt, r.lastActivityAt);
  s.appSessionId = r.appSessionId;
  if (r.archived !== undefined) s.archived = r.archived;
  if (r.effort) s.effort = r.effort;
  if (r.model && !s.model) s.model = r.model;
  if (!s.project && (r.cwd || r.originCwd)) s.project = r.cwd ?? r.originCwd;
}

function appOnlySession(r: AppSessionRecord): HistorySession | undefined {
  const first = r.createdAt ?? r.lastActivityAt;
  const last = r.lastActivityAt ?? r.createdAt;
  if (first === undefined || last === undefined) return undefined;
  const title = sanitizeTitle(r.title);
  const s: HistorySession = {
    agent: r.agent,
    sessionId: r.agentSessionId ?? r.appSessionId,
    titleSource: title ? "app" : "none",
    startedAt: first,
    lastActivityAt: maxIso(last, first),
    records: [],
    hasTranscript: false,
    appSessionId: r.appSessionId,
  };
  if (title) s.title = title;
  if (title && r.titleSource) s.appTitleSource = r.titleSource;
  const project = r.cwd ?? r.originCwd;
  if (project) s.project = project;
  if (r.archived !== undefined) s.archived = r.archived;
  if (r.model) s.model = r.model;
  if (r.effort) s.effort = r.effort;
  return s;
}

export interface BuildHistoryInput {
  sessions: Iterable<HistorySession>;
  tables: readonly PriceTable[];
  /** The current fleet's sessions; those busy, waiting or idle make an entry `live`. */
  live?: Iterable<{ agent: AgentId; sessionId: string; status: SessionStatus }>;
  /** Only sessions with activity at or after `since` … */
  since?: Date;
  /** … that started before `until` (exclusive). */
  until?: Date;
  /** Default DEFAULT_HISTORY_LIMIT. */
  limit?: number;
  now?: Date;
  /**
   * The Claude app's session list, when Claude Code is part of the history: whether it was read (and why not), and
   * how many records it had. The sessions already carry its records (mergeAppSessions); this only fills
   * `sources.claudeApp`.
   */
  claudeApp?: ClaudeAppInput;
}

export interface ClaudeAppInput {
  enabled: boolean;
  records: number;
  off?: ClaudeAppOffReason;
}

export function buildHistory(input: BuildHistoryInput): HistorySnapshot {
  const live = new Set<string>();
  for (const s of input.live ?? []) if (LIVE_STATUSES.has(s.status)) live.add(sessionKey(s.agent, s.sessionId));
  const since = input.since?.getTime() ?? -Infinity;
  const until = input.until?.getTime() ?? Infinity;
  const limit = Math.max(0, Math.floor(input.limit ?? DEFAULT_HISTORY_LIMIT));
  // Several adapters (or files) could name the same session; one with a transcript beats one without, then the
  // one with the latest activity wins.
  const byKey = new Map<string, HistorySession>();
  for (const s of input.sessions) {
    const last = Date.parse(s.lastActivityAt);
    const first = Date.parse(s.startedAt);
    if (Number.isNaN(last) || Number.isNaN(first) || last < since || first >= until) continue;
    const key = sessionKey(s.agent, s.sessionId);
    const prev = byKey.get(key);
    const rank = (x: HistorySession) => (x.hasTranscript === false ? 0 : 1);
    if (!prev || rank(s) > rank(prev) || (rank(s) === rank(prev) && Date.parse(prev.lastActivityAt) < last)) byKey.set(key, s);
  }
  const sorted = [...byKey.values()].sort(
    (a, b) =>
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
      a.sessionId.localeCompare(b.sessionId) ||
      String(a.agent).localeCompare(String(b.agent)),
  );
  const entries = sorted.slice(0, limit).map((s) => historyEntry(s, input.tables, live.has(sessionKey(s.agent, s.sessionId))));
  return {
    v: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    entries,
    total: sorted.length,
    truncated: sorted.length > entries.length,
    sources: historySources(sorted, input.claudeApp),
  };
}

/** Counts over the sessions that matched (before the limit). */
export function historySources(sessions: readonly HistorySession[], claudeApp?: ClaudeAppInput): HistorySources {
  let transcripts = 0;
  let merged = 0;
  let appOnly = 0;
  let archived = 0;
  for (const s of sessions) {
    const hasTranscript = s.hasTranscript !== false;
    if (hasTranscript) transcripts++;
    if (s.appSessionId === undefined) continue;
    if (hasTranscript) merged++;
    else appOnly++;
    if (s.archived === true) archived++;
  }
  const out: HistorySources = { transcripts };
  if (claudeApp) {
    out.claudeApp = { enabled: claudeApp.enabled, records: claudeApp.records, merged, appOnly, archived };
    if (!claudeApp.enabled && claudeApp.off) out.claudeApp.off = claudeApp.off;
  }
  return out;
}
