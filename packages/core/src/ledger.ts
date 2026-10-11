// Pricing an agent's own ledger rows with Signalbox's tables. Shared by the report's reconciliation and
// the session history, so a session's ledger $ is the same number in both.
import { canonicalModel, priceTokens, processedTokens } from "./pricing.ts";
import type { LedgerEntry, PriceTable, TokenCounts } from "./types.ts";

/** True when ledger row `a` is a later snapshot than `b` (same session and model). */
export function newerLedger(a: LedgerEntry, b: LedgerEntry): boolean {
  const ta = a.observedAt ? Date.parse(a.observedAt) : Number.NaN;
  const tb = b.observedAt ? Date.parse(b.observedAt) : Number.NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta > tb;
  if (!Number.isNaN(ta) && Number.isNaN(tb)) return true;
  if (Number.isNaN(ta) && !Number.isNaN(tb)) return false;
  // Same or unknown time: the larger row is the later cumulative snapshot.
  return processedTokens(a.tokens) > processedTokens(b.tokens);
}

/** One session's ledger rows reduced to the newest row per canonical model. */
export function newestLedgerByModel(rows: Iterable<LedgerEntry>): Map<string, LedgerEntry> {
  const out = new Map<string, LedgerEntry>();
  for (const e of rows) {
    const m = canonicalModel(e.model);
    const prev = out.get(m);
    if (!prev || newerLedger(e, prev)) out.set(m, e);
  }
  return out;
}

export interface LedgerRowPrice {
  usd: number;
  priced: boolean;
  /** True when the cache writes were split by a transcript share below 100% 1h. */
  resplit: boolean;
}

/**
 * Prices one ledger row (a session sum) with our tables. The ledger has no 5m/1h split, so its cache
 * writes are re-split by the session's own transcript share for that model (`transcriptWrites`), or priced
 * as 1h (main sessions write 1h on a subscription) when the transcript has no cache writes for it.
 */
export function priceLedgerRow(
  e: LedgerEntry,
  transcriptWrites: { cacheWrite5m: number; cacheWrite1h: number } | undefined,
  tables: readonly PriceTable[],
): LedgerRowPrice {
  const seen = transcriptWrites ? transcriptWrites.cacheWrite5m + transcriptWrites.cacheWrite1h : 0;
  const share1h = transcriptWrites && seen > 0 ? transcriptWrites.cacheWrite1h / seen : 1;
  const cw = finite(e.tokens.cacheWrite5m) + finite(e.tokens.cacheWrite1h);
  const tokens: TokenCounts = { ...e.tokens, cacheWrite5m: cw * (1 - share1h), cacheWrite1h: cw * share1h };
  const pr = priceTokens(e.model, tokens, tables, { perRequest: false, webSearchRequests: e.webSearchRequests });
  return { usd: pr.cost.total, priced: pr.priced, resplit: transcriptWrites !== undefined && seen > 0 && share1h < 1 };
}

function finite(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
