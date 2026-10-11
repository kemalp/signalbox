import type { RecordKind, TokenCounts } from "@signalbox/core";

export type Json = Record<string, unknown>;

export function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-negative finite number, rounded; anything else is unknown. */
export function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A parseable ISO timestamp, else undefined. */
export function isoTs(v: unknown): string | undefined {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
}

/**
 * Codex `TokenUsage` → TokenCounts. Also accepts a raw Responses API `usage` object.
 *
 * OpenAI semantics (developers.openai.com/api/docs/guides/prompt-caching and /reasoning):
 * cached and cache-write tokens are both subsets of `input_tokens`
 * ("ordinary_input_tokens = input_tokens - cached_tokens - cache_write_tokens"), and reasoning
 * tokens are a subset of `output_tokens` (`total_tokens = input_tokens + output_tokens`).
 * OpenAI has a single cache TTL per model, so cache writes go to `cacheWrite5m` and the price table
 * carries the same rate in both write columns.
 */
export function normalizeUsage(u: unknown): TokenCounts | undefined {
  if (!isObj(u)) return undefined;
  const inDetails = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const outDetails = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const inputTotal = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (inputTotal === undefined && output === undefined) return undefined;
  const cached = count(u.cached_input_tokens) ?? count(inDetails.cached_tokens) ?? 0;
  const cacheWrite = count(u.cache_write_input_tokens) ?? count(inDetails.cache_write_tokens) ?? 0;
  const reasoning = count(u.reasoning_output_tokens) ?? count(outDetails.reasoning_tokens);
  const tokens: TokenCounts = {
    input: Math.max(0, (inputTotal ?? 0) - cached - cacheWrite),
    output: output ?? 0,
    cacheRead: cached,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
  };
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  return tokens;
}

export function isZeroUsage(t: TokenCounts): boolean {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h === 0;
}

/** Total prompt size (`input_tokens`) of a Codex usage object, if reported. */
export function promptTokens(u: unknown): number | undefined {
  return isObj(u) ? count(u.input_tokens) : undefined;
}

/**
 * Record kind from `session_meta.source` (Codex `SessionSource`): a plain string (cli, vscode, exec,
 * mcp…) is a user-started thread; `{subagent: …}` is a child thread. Guardian approval reviews and
 * compaction helpers are automatic side calls, so they count as auxiliary.
 */
export function kindFromSource(source: unknown, threadSource?: string, parentThreadId?: string): RecordKind {
  if (isObj(source)) {
    const sub = source.subagent ?? source.sub_agent;
    if (sub === undefined) return "other";
    if (sub === "compact") return "auxiliary";
    if (sub === "review") return "subagent";
    if (isObj(sub)) {
      if ("thread_spawn" in sub) return "subagent";
      if ("other" in sub) return /guardian/i.test(String(sub.other)) ? "auxiliary" : "other";
    }
    return "subagent";
  }
  if (threadSource && /guardian/i.test(threadSource)) return "auxiliary";
  if (parentThreadId) return "subagent";
  return "main";
}

/** Codex `service_tier` → contract speed. Unknown tiers (e.g. flex) stay unknown. */
export function speedFromTier(tier: string | undefined): "standard" | "fast" | undefined {
  if (!tier) return undefined;
  const t = tier.toLowerCase();
  if (t === "fast" || t === "priority") return "fast";
  if (t === "default" || t === "standard" || t === "auto") return "standard";
  return undefined;
}

// ---------- rate limits ----------

export type LimitSlot = "primary" | "secondary";

/** The window each slot normally carries. Seen locally: primary 300 (5-hour), secondary 10080 (weekly). */
const CANONICAL_WINDOW: Record<LimitSlot, number> = { primary: 300, secondary: 10080 };

export function windowLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (minutes % 10080 === 0) return `${minutes / 10080}-week`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * LimitSnapshot kind for one rate-limit slot. The slot position alone is not a stable identity: while
 * the account ran on the `gpt-reserve` fallback, Codex reported a separate weekly bucket in the
 * *primary* slot (different reset time and percentage, same `limit_id`). So a slot carrying its usual
 * window keeps the plain name (`codex.primary`, `codex.secondary`), and any other window gets its own
 * kind (`codex.primary.10080m`) so "freshest per kind" never mixes two different buckets.
 */
export function limitKind(limitId: string | undefined, slot: LimitSlot, windowMinutes: number | undefined): { kind: string; canonical: boolean } {
  const base = !limitId || limitId === "codex" ? "codex" : `codex.${limitId}`;
  const canonical = windowMinutes === undefined || windowMinutes === CANONICAL_WINDOW[slot];
  return { kind: canonical ? `${base}.${slot}` : `${base}.${slot}.${windowMinutes}m`, canonical };
}

/** `resets_at` is epoch seconds in Codex; tolerate ms and ISO strings. */
export function resetToIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  return isoTs(v);
}

// ---------- file names ----------

const ROLLOUT_NAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+?)\.jsonl(?:\.zst)?$/;

export function isRolloutName(name: string): boolean {
  return /^rollout-.+\.jsonl(?:\.zst)?$/.test(name);
}

/** `rollout-2026-09-16T21-14-22-<thread id>.jsonl`. The timestamp is the machine's local time. */
export function parseRolloutName(name: string): { startMs?: number; threadId?: string } {
  const m = ROLLOUT_NAME.exec(name);
  if (!m) return {};
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const startMs = new Date(y, mo - 1, d, h, mi, s).getTime();
  return { startMs: Number.isFinite(startMs) ? startMs : undefined, threadId: m[7] };
}
