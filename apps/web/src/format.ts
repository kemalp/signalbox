// Pure formatting helpers shared by the page. Missing data renders as an em dash, never 0.
import type { AgentId, ContextSnapshot, LimitSnapshot } from "@signalbox/core";

export const DASH = "—";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return DASH;
  if (n > 0 && n < 0.005) return "<$0.01";
  return usd.format(n);
}

/** Axis ticks: clean whole dollars where possible. */
export function fmtUsdTick(n: number): string {
  if (Math.abs(n) >= 1000) return `$${fmtTokens(n)}`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

const UNITS: Array<[number, string]> = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

function compact(value: number): string {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  // Number() drops trailing zeros: 1.00 → "1", 1.50 → "1.5".
  return String(Number(value.toFixed(digits)));
}

/** 999 → "999", 12_345 → "12.3K", 1_880_000_000 → "1.88B". */
export function fmtTokens(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return sign + String(Math.round(abs));
  for (let i = 0; i < UNITS.length; i++) {
    const [size, unit] = UNITS[i]!;
    if (abs >= size) {
      const text = compact(abs / size);
      // Rounding can carry into the next unit (999.96K → 1000K): promote it.
      if (Number(text) >= 1000 && i > 0) return sign + compact(abs / UNITS[i - 1]![0]) + UNITS[i - 1]![1];
      return sign + text + unit;
    }
  }
  return sign + String(abs);
}

export function fmtCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-US");
}

/** A ratio (0..1) as a percent string. */
export function fmtRatio(r: number | undefined, digits = 1): string {
  if (r === undefined || !Number.isFinite(r)) return DASH;
  return `${(r * 100).toFixed(digits)}%`;
}

/** A value already in percent (0..100). */
export function fmtPercent(p: number | undefined, digits = 0): string {
  if (p === undefined || !Number.isFinite(p)) return DASH;
  return `${p.toFixed(digits)}%`;
}

/** Compact duration: "45s", "12m", "2h 5m", "3d 4h". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function ageMs(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : now - t;
}

export function fmtAgo(iso: string | undefined, now: number): string {
  const ms = ageMs(iso, now);
  if (ms === undefined) return DASH;
  if (ms < 5000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

export function fmtCountdown(iso: string | undefined, now: number): string {
  const ms = ageMs(iso, now);
  if (ms === undefined) return "reset time unknown";
  if (ms >= 0) return "reset passed";
  return `resets in ${fmtDuration(-ms)}`;
}

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini",
};

export function agentLabel(id: AgentId): string {
  return AGENT_LABELS[id] ?? id;
}

/** Stable display order: known agents first, then the rest alphabetically. */
export function agentOrder(a: AgentId, b: AgentId): number {
  const known = Object.keys(AGENT_LABELS);
  const ia = known.indexOf(a);
  const ib = known.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

export function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Ids from agent files can be any length; clip them for prose (keep the full id in a title). */
export function clipId(id: string, max = 64): string {
  return id.length <= max ? id : `${id.slice(0, max - 1)}…`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_fable: "Weekly · Fable",
  spend_limit: "Spend limit",
  "codex.primary": "Primary window",
  "codex.secondary": "Secondary window",
};

export function limitLabel(l: Pick<LimitSnapshot, "kind" | "label">): string {
  return l.label ?? LIMIT_LABELS[l.kind] ?? l.kind;
}

export function windowLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined || minutes <= 0) return undefined;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function contextPercent(c: ContextSnapshot | undefined): number | undefined {
  if (!c) return undefined;
  if (c.percent !== undefined) return c.percent;
  if (c.window) return (c.tokens / c.window) * 100;
  return undefined;
}

export type Severity = "ok" | "warn" | "crit";

export function severity(percent: number | undefined, warnAt = 75, critAt = 90): Severity {
  if (percent === undefined) return "ok";
  if (percent >= critAt) return "crit";
  if (percent >= warnAt) return "warn";
  return "ok";
}

/** Reads `#token=...` from a location hash. */
export function parseHashToken(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get("token");
  return token && /^[A-Za-z0-9._~+/=-]{16,512}$/.test(token) ? token : undefined;
}

/** Smallest "nice" number (1, 2, 2.5, 5 × 10^n) at or above `n`. */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * mag >= n) return step * mag;
  }
  return 10 * mag;
}

/** "2026-10-03" → local-midnight Date. */
export function dayToDate(key: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayLongFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function fmtDayShort(d: Date): string {
  return dayFmt.format(d);
}

export function fmtDayLong(key: string): string {
  const d = dayToDate(key);
  return d ? dayLongFmt.format(d) : key;
}

export function fmtTime(iso: string | undefined, now: number): string {
  const ms = ageMs(iso, now);
  if (ms === undefined || !iso) return DASH;
  const d = new Date(iso);
  return ms < 20 * 3600_000 ? timeFmt.format(d) : dateTimeFmt.format(d);
}
