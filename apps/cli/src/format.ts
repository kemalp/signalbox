// Plain-text rendering for the terminal. Pure functions over core's Report: no I/O.
import { homedir } from "node:os";
import { basename } from "node:path";
import type { GroupTotals, HistorySnapshot, Report } from "@signalbox/core";

export function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Local "YYYY-MM-DD HH:MM". */
export function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function tildify(path: string, home = homedir()): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** `prefix` + `text` wrapped to `width` columns; continuation lines are indented to the prefix's width. */
export function wrap(prefix: string, text: string, width: number): string {
  const indent = " ".repeat(prefix.length);
  const lines: string[] = [];
  let line = prefix;
  let empty = true;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + w.length > width) {
      lines.push(line);
      line = indent + w;
    } else {
      line = empty ? line + w : `${line} ${w}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}

function processed(g: GroupTotals): number {
  const t = g.tokens;
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(s.length - n + 1)}`;
}

/** Shortens a path to `n` columns, keeping its root (`~`, `/`) and as many trailing folders as fit: `~/…/sample-web-app`. */
export function clipPath(p: string, n: number): string {
  if (p.length <= n) return p;
  const parts = p.split("/");
  const root = parts[0] === "~" ? "~/" : p.startsWith("/") ? "/" : "";
  let tail = parts.at(-1) ?? p;
  if (`${root}…/${tail}`.length > n) return clip(tail, n);
  for (let i = parts.length - 2; i > (root ? 0 : -1); i--) {
    const next = `${parts[i]}/${tail}`;
    if (`${root}…/${next}`.length > n) break;
    tail = next;
  }
  return `${root}…/${tail}`;
}

function groupTable(
  title: string,
  rows: GroupTotals[],
  opts: { limit?: number; label?: (k: string) => string; width: number; clipKey?: (s: string, n: number) => string },
): string[] {
  if (rows.length === 0) return [];
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  // The columns after the name take 58; rows flagged "unpriced" take 10 more.
  const fixed = shown.some((r) => r.unpricedModels.length > 0) ? 68 : 58;
  const keyWidth = Math.max(10, Math.min(opts.width - fixed, Math.max(...shown.map((r) => (opts.label ? opts.label(r.key) : r.key).length))));
  const head = `${title}${opts.limit && rows.length > opts.limit ? ` (top ${opts.limit} of ${rows.length})` : ""}`;
  const out = [head];
  for (const r of shown) {
    const name = (opts.clipKey ?? clip)(opts.label ? opts.label(r.key) : r.key, keyWidth).padEnd(keyWidth);
    const placeholder = r.placeholderResponses > 0 ? fmtPct(r.placeholderResponses / r.responses, 0) : "-";
    const unpriced = r.unpricedModels.length > 0 ? "  unpriced" : "";
    out.push(
      `  ${name}  ${fmtUsd(r.cost.total).padStart(11)}  ${fmtInt(r.responses).padStart(7)} resp  ${fmtTokens(processed(r)).padStart(7)} tok  ${placeholder.padStart(4)} ph${unpriced}`,
    );
  }
  return out;
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

export interface ReportTextOptions {
  width?: number;
  agentLabel?: string;
  /** How the window was chosen, e.g. "7 calendar days" or "rolling 7 x 24h". Default: its length in days. */
  windowLabel?: string;
  /** Seconds the scan and report took, shown in the footer. */
  elapsedMs?: number;
  /** No adapter found any data: print "no data" instead of $0.00 totals. */
  noData?: boolean;
  /** Also print whole-session k, the token-type breakdown, the notes and the estimate method. */
  verbose?: boolean;
}

export function formatReport(r: Report, opts: ReportTextOptions = {}): string {
  const width = Math.max(72, Math.min(opts.width ?? 100, 140));
  const t = r.totals;
  const e = r.estimate;
  const out: string[] = [];
  const days = (Date.parse(r.range.until) - Date.parse(r.range.since)) / 86_400_000;
  out.push(`Signalbox report  ${opts.agentLabel ?? "all agents"}`);
  const label = opts.windowLabel ?? `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
  out.push(`${fmtLocal(r.range.since)} -> ${fmtLocal(r.range.until)} (${label}, local time)`);
  out.push("All dollar figures are list-price equivalents, not a bill.");
  out.push("");
  const tag = (s: string) => s.padEnd(14);
  if (opts.noData) {
    out.push(`${tag("Recorded")}no data (no agent data was found, so usage is unknown rather than $0)`);
    out.push("", "Notes");
    for (const n of r.notes) out.push(wrap("  - ", n, width));
    return out.join("\n");
  }
  out.push(`${tag("Recorded")}${fmtUsd(e.recordedUsd)}  (transcript-priced responses: a lower bound)`);
  const sameRange = Math.abs(e.estimatedLowUsd - e.recordedUsd) < 0.005 && Math.abs(e.estimatedHighUsd - e.recordedUsd) < 0.005;
  out.push(
    `${tag("Estimated")}${sameRange ? `${fmtUsd(e.estimatedLowUsd)}  (no ledger to calibrate against, so it equals recorded)` : `${fmtUsd(e.estimatedLowUsd)} - ${fmtUsd(e.estimatedHighUsd)}  (calibrated against the agents' own ledgers)`}`,
  );
  // Whole-session k across all models, for orientation only; the estimate uses per-model k (see the method).
  const ks = r.reconciliation.flatMap((row) => (row.k !== undefined ? [row.k] : []));
  if (opts.verbose && ks.length > 0) {
    const m = median(ks)!;
    out.push(
      `${tag("Session k")}median ${m.toFixed(2)} over ${ks.length} ${ks.length === 1 ? "session" : "sessions"} (range ${Math.min(...ks).toFixed(2)} - ${Math.max(...ks).toFixed(2)}; whole sessions, all models; the estimate uses per-model k)`,
    );
  }
  out.push(
    `${tag("Tokens")}processed ${fmtTokens(t.processedTokens)}  fresh ${fmtTokens(t.freshTokens)}  cache hit ${t.processedTokens > 0 ? fmtPct(t.cacheHitRatio) : "-"}`,
  );
  if (t.savedByCachingUsd > 0) out.push(`${tag("Cache savings")}${fmtUsd(t.savedByCachingUsd)}  (gross, vs. paying full input price)`);
  if (opts.verbose) out.push(
    `${tag("")}input ${fmtTokens(t.tokens.input)}  output ${fmtTokens(t.tokens.output)}  cache read ${fmtTokens(t.tokens.cacheRead)}  cache write ${fmtTokens(t.tokens.cacheWrite5m)} (5m) + ${fmtTokens(t.tokens.cacheWrite1h)} (1h)`,
  );
  out.push(
    `${tag("Responses")}${fmtInt(t.responses)}${t.responses > 0 ? `  (${fmtPct(t.placeholderResponses / t.responses)} with placeholder output, "ph")` : ""}`,
  );
  const c = t.cost;
  if (c.total > 0) {
    const parts = (
      [
        ["cache reads", c.cacheRead],
        ["5m writes", c.cacheWrite5m],
        ["1h writes", c.cacheWrite1h],
        ["output", c.output],
        ["input", c.input],
        ["web search", c.webSearch],
      ] as const
    )
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${fmtPct(v / c.total, 0)}`);
    out.push(wrap(tag("Where $ went"), parts.join(", "), width));
  }
  if (t.unpricedModels.length > 0) {
    out.push(
      wrap(tag("Unpriced"), `${fmtTokens(t.unpricedTokens)} tokens counted as $0 (no list price): ${t.unpricedModels.join(", ")}`, width),
    );
  }
  const home = homedir();
  for (const block of [
    groupTable("By agent", r.byAgent, { width }),
    groupTable("By model", r.byModel, { width }),
    groupTable("By kind", r.byKind, { width }),
    groupTable("By project", r.byProject, { width, limit: 10, label: (k) => tildify(k, home), clipKey: clipPath }),
  ]) {
    if (block.length === 0) continue;
    out.push("", ...block);
  }
  if (opts.verbose) {
    if (r.notes.length) {
      out.push("", "Notes");
      for (const n of r.notes) out.push(wrap("  - ", n, width));
    }
    out.push("", wrap("Estimate method: ", e.method, width));
  }
  out.push(
    "",
    `Prices: ${r.priceTables.map((p) => `${p.provider} as of ${p.asOf}`).join(", ")}${opts.elapsedMs !== undefined ? `   (${(opts.elapsedMs / 1000).toFixed(2)} s)` : ""}`,
  );
  if (!opts.verbose) {
    const notes = r.notes.length === 1 ? "1 note" : `${r.notes.length} notes`;
    out.push(`More: --verbose shows ${r.notes.length ? `${notes} and ` : ""}how the estimate is calculated.`);
  }
  return out.join("\n");
}

/** "<1m", "45m", "2h 14m", "3d 4h". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clipEnd(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : `${chars.slice(0, Math.max(1, n - 1)).join("")}…`;
}

function padEndChars(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - Array.from(s).length));
}

export interface HistoryTextOptions {
  width?: number;
  /** e.g. "all agents", "Claude Code". */
  agentLabel?: string;
  /** e.g. "every session", "last 7 calendar days". */
  windowLabel?: string;
  /** No adapter found any data: say so instead of printing an empty table. */
  noData?: boolean;
}

/** `signalbox history`: one row per session, newest first: date, agent, title, project folder, duration, $. */
export function formatHistory(h: HistorySnapshot, opts: HistoryTextOptions = {}): string {
  const width = Math.max(72, Math.min(opts.width ?? 100, 160));
  const out: string[] = [];
  const count = h.truncated ? `${fmtInt(h.entries.length)} of ${fmtInt(h.total)}` : fmtInt(h.total);
  out.push(`Signalbox history  ${opts.agentLabel ?? "all agents"}, ${opts.windowLabel ?? "every session"} (${count} ${h.total === 1 ? "session" : "sessions"})`);
  if (opts.noData) {
    out.push("No agent data was found on this machine, so the history is unknown rather than empty. Run `signalbox doctor` for details.");
    return out.join("\n");
  }
  if (h.entries.length === 0) {
    out.push("No sessions in this window.");
    return out.join("\n");
  }
  const agentW = Math.max(5, ...h.entries.map((e) => String(e.agent).length));
  // Narrow terminals get the date without the time and a shorter project column; the title takes the rest.
  const wide = width >= 100;
  const dateW = wide ? 16 : 10;
  const projW = wide ? 16 : 12;
  const timeW = 7;
  const costW = 10;
  const marksW = 8; // "  * live"
  const titleW = Math.max(12, width - (dateW + 2 + agentW + 2 + 2 + projW + 2 + timeW + 2 + costW + marksW));
  out.push("");
  out.push(
    `${(wide ? "Last active" : "Date").padEnd(dateW)}  ${"Agent".padEnd(agentW)}  ${"Title".padEnd(titleW)}  ${"Project".padEnd(projW)}  ${"Time".padStart(timeW)}  ${"Cost".padStart(costW)}`,
  );
  let unpriced = false;
  let appOnly = false;
  for (const e of h.entries) {
    const date = fmtLocal(e.lastActivityAt).slice(0, dateW);
    const title = padEndChars(clipEnd(e.title ?? "Untitled", titleW), titleW);
    const project = padEndChars(clipEnd(e.project ? basename(e.project) || e.project : "-", projW), projW);
    // No responses, or an app-only session (figures unknown): no dollar figure.
    const cost = e.costUsd === undefined || !e.responses ? "-" : fmtUsd(e.costUsd);
    // Time is the transcript's first to last line; an app-only session has none to measure.
    const time = e.hasTranscript === false ? "-" : fmtDuration(e.durationMs);
    const hasUnpriced = (e.unpricedTokens ?? 0) > 0;
    const marks = [hasUnpriced ? "*" : "", e.live ? "live" : "", e.hasTranscript === false ? "app" : "", e.archived ? "archived" : ""]
      .filter(Boolean)
      .join(" ");
    if (hasUnpriced) unpriced = true;
    if (e.hasTranscript === false) appOnly = true;
    out.push(
      `${date.padEnd(dateW)}  ${String(e.agent).padEnd(agentW)}  ${title}  ${project}  ${time.padStart(timeW)}  ${cost.padStart(costW)}${marks ? `  ${marks}` : ""}`.trimEnd(),
    );
  }
  out.push("");
  if (h.truncated) out.push(wrap("", `Showing the newest ${fmtInt(h.entries.length)} of ${fmtInt(h.total)} sessions; --limit N shows more.`, width));
  if (unpriced) out.push(wrap("", "* includes tokens of a model with no list price, counted as $0.", width));
  if (appOnly) out.push(wrap("", "app: listed by the Claude app, with no transcript on this Mac, so its time and figures are unknown.", width));
  out.push(wrap("", "Titles are the agents' (and the Claude app's) own session names, never prompts. Dollar figures are list-price equivalents, not a bill.", width));
  return out.join("\n");
}
