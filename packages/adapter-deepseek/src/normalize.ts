import type { TokenCounts } from "@signalbox/core";

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

/** Epoch milliseconds, as the harness writes `time` and `createdAt`; anything a Date can't hold is unknown. */
export function msTime(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 8.64e15 ? v : undefined;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An id or enum-like value (model, provider, session id): one line, no control characters, at most `max` characters. */
export function label(v: unknown, max = 120): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
  return s;
}

/** A working directory as the harness records it: an absolute path on one line, else undefined. */
export function pathField(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\") ? v : undefined;
}

/**
 * A harness usage object → TokenCounts.
 *
 * The harness keeps the prompt buckets apart: `inputTokens` is the uncached input, and
 * `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` (its own token meter calls the
 * first one `uncachedInputTokens`). `reasoningTokens`, when a provider reports it, is part of `outputTokens`. It
 * records one cache-write figure with no TTL, so that goes to the short-TTL slot.
 */
export function normalizeUsage(u: unknown): TokenCounts | undefined {
  if (!isObj(u)) return undefined;
  const input = count(u.inputTokens);
  const output = count(u.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  const tokens: TokenCounts = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: count(u.cacheReadTokens) ?? 0,
    cacheWrite5m: count(u.cacheWriteTokens) ?? 0,
    cacheWrite1h: 0,
  };
  const reasoning = count(u.reasoningTokens);
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  return tokens;
}

export function isZeroUsage(t: TokenCounts): boolean {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h === 0;
}

/**
 * The usage of one model call as its stream recorded it: the last raw `usage` chunk. A settled message repeats
 * it as `data.usage`; an attempt that was retried has only the chunk.
 */
export function lastUsageChunk(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const record: unknown = stream[i];
    if (isObj(record) && record.type === "chunk" && isObj(record.chunk) && record.chunk.type === "usage") return record.chunk.usage;
  }
  return undefined;
}
