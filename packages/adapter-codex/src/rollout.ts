import type { CompactionEvent, LimitSnapshot, RecordKind, TokenCounts, UsageRecord } from "@signalbox/core";
import {
  count,
  isObj,
  isoTs,
  isZeroUsage,
  kindFromSource,
  limitKind,
  normalizeUsage,
  promptTokens,
  resetToIso,
  speedFromTier,
  str,
  windowLabel,
  type Json,
  type LimitSlot,
} from "./normalize.ts";

export const AGENT = "codex";

export interface RolloutMeta {
  threadId?: string;
  sessionId?: string;
  parentThreadId?: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  source?: unknown;
  threadSource?: string;
  startedAt?: string;
  modelProvider?: string;
  /** session_meta `git.branch`, when the writer records it. */
  gitBranch?: string;
}

export interface TurnInfo {
  model?: string;
  effort?: string;
  cwd?: string;
}

export interface RolloutStats {
  lines: number;
  /** Lines recognised from their prefix as irrelevant and never JSON-parsed. */
  skipped: number;
  badLines: number;
  /** token_usage_record lines plus token_count events with usage info. */
  usageLines: number;
  usageRecords: number;
  /** Records rebuilt from token_count events (rollouts written before token_usage_record existed). */
  legacyRecords: number;
  zeroUsage: number;
  unknownTypes: Record<string, number>;
}

export interface RolloutSummary {
  path: string;
  meta: RolloutMeta;
  threadId: string;
  /** Root session id: equals threadId for a main thread, the parent's session for a subagent. */
  sessionId: string;
  kind: RecordKind;
  records: UsageRecord[];
  /** Latest reading per kind within this file. */
  limits: LimitSnapshot[];
  /** Last context reading; absent when a compaction happened after it. */
  context?: { ts: string; tokens: number; window?: number };
  compactions: CompactionEvent[];
  lastTurn?: TurnInfo;
  /** A task_started without a later task_complete / turn_aborted. */
  turnOpen: boolean;
  turnChangedAt?: string;
  firstTs?: string;
  lastTs?: string;
  stats: RolloutStats;
}

const KNOWN_TYPES = new Set(["session_meta", "turn_context", "event_msg", "response_item", "token_usage_record", "compacted", "world_state"]);
const WANTED_EVENTS = new Set(["token_count", "task_started", "task_complete", "turn_aborted", "thread_settings_applied"]);

// Current writer: {"timestamp":"…","ordinal":N,"type":"…","payload":{"type":"…"…
// Lines identified here as irrelevant (messages, reasoning, tool calls) are skipped without parsing,
// so message content is never even materialised. Anything that doesn't match is parsed in full.
const PREFIX = /^\{"timestamp":"([^"]*)",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;

function skippable(type: string, payloadType: string | undefined): boolean {
  if (type === "world_state") return true;
  if (type === "response_item") return payloadType !== undefined && payloadType !== "web_search_call";
  if (type === "event_msg") return payloadType !== undefined && !WANTED_EVENTS.has(payloadType);
  return false;
}

interface PendingRecord {
  /** Responses API id, when the line has one. */
  rid?: string;
  /** Derived key suffix for lines without an id; prefixed with the thread id at the end. */
  derived?: string;
  ts: string;
  sessionId?: string;
  model: string;
  project?: string;
  tokens: TokenCounts;
  speed?: "standard" | "fast";
  webSearchRequests: number;
}

interface PendingLimit {
  kind: string;
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  windowMinutes?: number;
  observedAt: string;
  plan?: string;
}

function later(a: string | undefined, b: string): string {
  return a === undefined || Date.parse(b) > Date.parse(a) ? b : a;
}

function earlier(a: string | undefined, b: string): string {
  return a === undefined || Date.parse(b) < Date.parse(a) ? b : a;
}

function limitReadings(rl: Json, ts: string, model: string | undefined): PendingLimit[] {
  const out: PendingLimit[] = [];
  const limitId = str(rl.limit_id);
  for (const slot of ["primary", "secondary"] as LimitSlot[]) {
    const w = rl[slot];
    if (!isObj(w)) continue;
    const used = w.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const windowMinutes = count(w.window_minutes);
    const { kind, canonical } = limitKind(limitId, slot, windowMinutes);
    const base = windowLabel(windowMinutes);
    const label = base && !canonical && model ? `${base} (${model})` : base;
    out.push({
      kind,
      label,
      usedPercent: used,
      resetsAt: resetToIso(w.resets_at),
      windowMinutes,
      observedAt: ts,
      plan: str(rl.plan_type),
    });
  }
  return out;
}

/**
 * Parses one Codex rollout. One UsageRecord per `token_usage_record` line, keyed on the Responses API
 * `response_id`. `token_count` events are only used for usage before the first token_usage_record in
 * a file (older writers), because they repeat and they omit compaction calls.
 */
export function parseRollout(text: string, path: string, fallbackThreadId?: string): RolloutSummary {
  const stats: RolloutStats = { lines: 0, skipped: 0, badLines: 0, usageLines: 0, usageRecords: 0, legacyRecords: 0, zeroUsage: 0, unknownTypes: {} };
  const meta: RolloutMeta = {};
  let metaSeen = false;
  const turns = new Map<string, TurnInfo>();
  let lastTurn: TurnInfo | undefined;
  let settingsModel: string | undefined;
  let serviceTier: string | undefined;
  let seenUsageRecord = false;
  let legacyPrevTotal: number | undefined;
  let pendingWebSearches = 0;
  const pending: PendingRecord[] = [];
  const seenRids = new Set<string>();
  const promptByRid = new Map<string, number>();
  const limits = new Map<string, PendingLimit>();
  let context: RolloutSummary["context"];
  let compactedAfterContext = false;
  const compactions: Array<{ ts: string; preTokens?: number }> = [];
  let turnOpen = false;
  let turnChangedAt: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of text.split("\n")) {
    if (line.length === 0 || line.trim().length === 0) continue;
    stats.lines++;
    const pre = PREFIX.exec(line.length > 512 ? line.slice(0, 512) : line);
    if (pre) {
      const preTs = isoTs(pre[1]);
      if (preTs) {
        lastTs = later(lastTs, preTs);
        firstTs = earlier(firstTs, preTs);
      }
      if (skippable(pre[2]!, pre[3])) {
        stats.skipped++;
        continue;
      }
    }
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      stats.badLines++;
      continue;
    }
    if (!isObj(j)) {
      stats.badLines++;
      continue;
    }
    const ts = isoTs(j.timestamp);
    if (ts) {
      lastTs = later(lastTs, ts);
      firstTs = earlier(firstTs, ts);
    }
    const type = str(j.type) ?? "";
    const p = isObj(j.payload) ? j.payload : undefined;
    if (!KNOWN_TYPES.has(type)) stats.unknownTypes[type || "(none)"] = (stats.unknownTypes[type || "(none)"] ?? 0) + 1;
    if (!p) continue;

    switch (type) {
      case "session_meta": {
        if (metaSeen) break;
        metaSeen = true;
        meta.threadId = str(p.id);
        meta.sessionId = str(p.session_id);
        meta.parentThreadId = str(p.parent_thread_id);
        meta.cwd = str(p.cwd);
        meta.cliVersion = str(p.cli_version);
        meta.originator = str(p.originator);
        meta.source = p.source;
        meta.threadSource = str(p.thread_source);
        meta.startedAt = isoTs(p.timestamp) ?? ts;
        meta.modelProvider = str(p.model_provider);
        if (isObj(p.git)) meta.gitBranch = str(p.git.branch);
        break;
      }
      case "turn_context": {
        const t: TurnInfo = { model: str(p.model), effort: str(p.effort), cwd: str(p.cwd) };
        const id = str(p.turn_id);
        if (id) turns.set(id, t);
        lastTurn = t;
        break;
      }
      case "event_msg": {
        const et = str(p.type);
        if (et === "task_started") {
          turnOpen = true;
          if (ts) turnChangedAt = ts;
        } else if (et === "task_complete" || et === "turn_aborted") {
          turnOpen = false;
          if (ts) turnChangedAt = ts;
        } else if (et === "thread_settings_applied") {
          const s = isObj(p.thread_settings) ? p.thread_settings : {};
          serviceTier = str(s.service_tier) ?? serviceTier;
          settingsModel = str(s.model) ?? settingsModel;
        } else if (et === "token_count") {
          if (!ts) break;
          const model = lastTurn?.model ?? settingsModel;
          if (isObj(p.rate_limits)) {
            for (const r of limitReadings(p.rate_limits, ts, model)) {
              const prev = limits.get(r.kind);
              if (!prev || Date.parse(r.observedAt) >= Date.parse(prev.observedAt)) limits.set(r.kind, r);
            }
          }
          const info = isObj(p.info) ? p.info : undefined;
          if (!info) break;
          stats.usageLines++;
          const last = info.last_token_usage;
          const prompt = promptTokens(last);
          if (prompt !== undefined) {
            context = { ts, tokens: prompt, window: count(info.model_context_window) };
            compactedAfterContext = false;
          }
          if (seenUsageRecord) break;
          // Legacy path: token_count repeats (same cumulative total) are skipped.
          const total = isObj(info.total_token_usage) ? count(info.total_token_usage.total_tokens) : undefined;
          if (total === undefined || total === legacyPrevTotal) break;
          legacyPrevTotal = total;
          const tokens = normalizeUsage(last);
          if (!tokens) break;
          if (isZeroUsage(tokens)) {
            stats.zeroUsage++;
            break;
          }
          pending.push({
            derived: `tc:${total}`,
            ts,
            model: model ?? "unknown",
            project: lastTurn?.cwd ?? meta.cwd,
            tokens,
            speed: speedFromTier(serviceTier),
            webSearchRequests: pendingWebSearches,
          });
          pendingWebSearches = 0;
          stats.legacyRecords++;
        }
        break;
      }
      case "response_item": {
        if (str(p.type) === "web_search_call") pendingWebSearches++;
        break;
      }
      case "token_usage_record": {
        stats.usageLines++;
        seenUsageRecord = true;
        if (!ts) break;
        const u = p.usage ?? p.last_token_usage;
        const tokens = normalizeUsage(u);
        if (!tokens) break;
        const rid = str(p.response_id);
        const prompt = promptTokens(u);
        if (rid && prompt !== undefined) promptByRid.set(rid, prompt);
        if (rid && seenRids.has(rid)) break;
        if (rid) seenRids.add(rid);
        if (isZeroUsage(tokens)) {
          stats.zeroUsage++;
          break;
        }
        const turnId = str(p.turn_id);
        const turn = (turnId && turns.get(turnId)) || lastTurn;
        const threadTotal = isObj(p.thread_token_usage) ? count(p.thread_token_usage.total_tokens) : undefined;
        pending.push({
          rid,
          derived: rid ? undefined : `h:${ts}:${threadTotal ?? ""}:${tokens.input}/${tokens.cacheRead}/${tokens.cacheWrite5m}/${tokens.output}`,
          ts,
          sessionId: str(p.session_id),
          model: turn?.model ?? settingsModel ?? "unknown",
          project: turn?.cwd ?? meta.cwd,
          tokens,
          speed: speedFromTier(serviceTier),
          webSearchRequests: pendingWebSearches,
        });
        pendingWebSearches = 0;
        stats.usageRecords++;
        break;
      }
      case "compacted": {
        if (!ts) break;
        compactedAfterContext = true;
        const latest = isObj(p.latest_token_usage_record) ? p.latest_token_usage_record : undefined;
        const rid = str(p.compaction_response_id);
        const preTokens = promptTokens(latest?.usage) ?? (rid ? promptByRid.get(rid) : undefined);
        compactions.push({ ts, preTokens });
        break;
      }
    }
  }

  const threadId = meta.threadId ?? fallbackThreadId ?? path;
  const sessionId = meta.sessionId ?? threadId;
  const kind = kindFromSource(meta.source, meta.threadSource, meta.parentThreadId);

  const records: UsageRecord[] = pending.map((r) => {
    const rec: UsageRecord = {
      agent: AGENT,
      id: r.rid ?? `${threadId}:${r.derived}`,
      keyQuality: r.rid ? "id" : "hash",
      sessionId: r.sessionId ?? sessionId,
      kind,
      model: r.model,
      ts: r.ts,
      tokens: r.tokens,
      outputFinal: true,
      webSearchRequests: r.webSearchRequests,
      sourcePath: path,
    };
    if (r.project) rec.project = r.project;
    if (r.speed) rec.speed = r.speed;
    return rec;
  });

  const limitSnapshots: LimitSnapshot[] = [...limits.values()].map((l) => {
    const s: LimitSnapshot = { agent: AGENT, kind: l.kind, usedPercent: l.usedPercent, observedAt: l.observedAt, sessionId, source: "rollout:token_count" };
    if (l.label) s.label = l.label;
    if (l.resetsAt) s.resetsAt = l.resetsAt;
    if (l.windowMinutes !== undefined) s.windowMinutes = l.windowMinutes;
    if (l.plan) s.plan = l.plan;
    return s;
  });

  const compactionEvents: CompactionEvent[] = compactions.map((c) => {
    const e: CompactionEvent = { agent: AGENT, sessionId, ts: c.ts, trigger: "unknown" };
    if (c.preTokens !== undefined) e.preTokens = c.preTokens;
    return e;
  });

  return {
    path,
    meta,
    threadId,
    sessionId,
    kind,
    records,
    limits: limitSnapshots,
    context: compactedAfterContext ? undefined : context,
    compactions: compactionEvents,
    lastTurn,
    turnOpen,
    turnChangedAt,
    firstTs,
    lastTs,
    stats,
  };
}

/**
 * The turn state after the last task_started / task_complete / turn_aborted event in a piece of a
 * rollout (true = a turn is open), or undefined when the piece has none. Partial lines are skipped.
 * Same rule as parseRollout's `turnOpen`, for a tail read.
 */
export function lastTurnState(text: string): boolean | undefined {
  let open: boolean | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"task_started"') && !line.includes('"task_complete"') && !line.includes('"turn_aborted"')) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(j) || j.type !== "event_msg" || !isObj(j.payload)) continue;
    const et = str(j.payload.type);
    if (et === "task_started") open = true;
    else if (et === "task_complete" || et === "turn_aborted") open = false;
  }
  return open;
}
