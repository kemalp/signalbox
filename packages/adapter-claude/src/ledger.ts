// Claude Code's own records inside transcripts: `cost-state` rows (its cost ledger) and
// `compact_boundary` system rows. Both are undocumented (stability: internal).
import type { CompactionEvent, LedgerEntry, RecordKind, TokenCounts } from "../../core/src/index.ts";
import { count, isObj, num, str, toIso } from "./util.ts";

/**
 * One LedgerEntry per model in a cost-state row's `modelUsage`. Rows are cumulative per session
 * (verified: no per-model field ever decreases across a file's rows), so callers pass only the
 * LAST row. The ledger has no 5m/1h split: cache writes go to 1h for main transcripts and 5m
 * otherwise. A main session's row also covers its subagents and workflows (verified 2026-10-09),
 * whose writes are 5m, so core re-splits the pool by the session's transcript share when pricing.
 */
export function ledgerFromCostState(
  row: unknown,
  ctx: { sessionId: string; kind: RecordKind; observedAt?: string },
): LedgerEntry[] {
  if (!isObj(row) || row.type !== "cost-state" || !isObj(row.modelUsage)) return [];
  const sessionId = str(row.sessionId) ?? ctx.sessionId;
  const out: LedgerEntry[] = [];
  for (const [model, v] of Object.entries(row.modelUsage)) {
    if (!isObj(v)) continue;
    const costUsd = num(v.costUSD);
    if (costUsd === undefined) continue; // missing is unknown, never 0
    // Session sums, so the per-response sanity cap doesn't apply.
    const cw = count(v.cacheCreationInputTokens, Number.MAX_SAFE_INTEGER);
    const tokens: TokenCounts = {
      input: count(v.inputTokens, Number.MAX_SAFE_INTEGER),
      output: count(v.outputTokens, Number.MAX_SAFE_INTEGER),
      cacheRead: count(v.cacheReadInputTokens, Number.MAX_SAFE_INTEGER),
      cacheWrite5m: ctx.kind === "main" ? 0 : cw,
      cacheWrite1h: ctx.kind === "main" ? cw : 0,
    };
    const thinking = num(v.thinkingTokens);
    if (thinking !== undefined) tokens.reasoning = thinking;
    const entry: LedgerEntry = { agent: "claude-code", sessionId, model, tokens, costUsd, source: "cost-state" };
    const searches = num(v.webSearchRequests);
    if (searches !== undefined) entry.webSearchRequests = searches;
    if (ctx.observedAt) entry.observedAt = ctx.observedAt;
    out.push(entry);
  }
  return out;
}

/** cost-state `startTime` (epoch ms) as ISO, when present. */
export function costStateStart(row: unknown): string | undefined {
  return isObj(row) ? toIso(row.startTime) : undefined;
}

/**
 * A `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger","preTokens"}}` row
 * (verified key names, 2.1.293). Snake-case variants are accepted defensively.
 */
export function compactionFromLine(d: unknown, fallbackSessionId: string): CompactionEvent | undefined {
  if (!isObj(d) || d.type !== "system" || d.subtype !== "compact_boundary") return undefined;
  const ts = toIso(d.timestamp);
  if (!ts) return undefined;
  const meta = isObj(d.compactMetadata) ? d.compactMetadata : isObj(d.compact_metadata) ? d.compact_metadata : {};
  const trig = meta.trigger;
  const ev: CompactionEvent = {
    agent: "claude-code",
    sessionId: str(d.sessionId) ?? fallbackSessionId,
    ts,
    trigger: trig === "manual" || trig === "auto" ? trig : "unknown",
  };
  const pre = num(meta.preTokens) ?? num(meta.pre_tokens);
  if (pre !== undefined) ev.preTokens = pre;
  return ev;
}
