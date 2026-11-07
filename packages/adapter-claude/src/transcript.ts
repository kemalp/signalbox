// One pass over a transcript collects everything Signalbox reads from it: usage (UsageAccumulator), the
// last cost-state row, compact_boundary rows, and the history metadata (title lines, first and last line
// timestamps, gitBranch/entrypoint/version, the first working directory). A line is JSON-parsed only when a
// cheap substring prefilter says it is one of those, and only those fields are kept. Prompts (`user`,
// `last-prompt` lines), message bodies, summaries, attachments and queue operations are never read for text.
// Account ids come from two small line types (2.1.293, desktop sessions only): `bridge-session` (ownerAccountUuid,
// ownerOrganizationUuid) and `artifact-autoreact-ledger` (accountUuid). They are hashed at once (accountEvidence).
import type { AccountEvidence, CompactionEvent, LedgerEntry, UsageRecord } from "../../core/src/index.ts";
import { accountEvidence, sanitizeTitle } from "../../core/src/index.ts";
import type { FileStamp } from "./file-cache.ts";
import { compactionFromLine, costStateStart, ledgerFromCostState } from "./ledger.ts";
import type { TranscriptFile } from "./paths.ts";
import { UsageAccumulator, emptyUsageStats, type UsageStats } from "./usage.ts";
import { isObj, label } from "./util.ts";

export interface TranscriptMeta {
  /** Earliest and latest top-level line timestamps (epoch ms). */
  firstTsMs?: number;
  lastTsMs?: number;
  /**
   * The value of the LAST `custom-title` / `ai-title` / `agent-name` line, sanitized; main transcripts only.
   * A last line whose value is empty clears it.
   */
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  /**
   * The top-level `cwd` of the first main-transcript line that has one: the project of a session with no
   * response (its records carry none). Only that field of the line is kept.
   */
  cwd?: string;
  /** From the top-level fields of main-transcript response lines; the last one wins. */
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  /**
   * The last `bridge-session` line's account and organization, hashed (main transcripts only). These lines carry no
   * timestamp: `atMs` is the latest line time seen before it.
   */
  accountFull?: AccountEvidence;
  /** The last account named without an organization (`artifact-autoreact-ledger`, or a bridge line without one). */
  accountPartial?: AccountEvidence;
}

/** Everything one read of a transcript produces. Cached per file while its mtime and size stay the same. */
export interface TranscriptParse {
  responses: Array<{ key: string; records: UsageRecord[] }>;
  stats: UsageStats;
  meta: TranscriptMeta;
  /** The file's last cost-state row, reduced to ledger entries (observedAt: the file's mtime). */
  ledger: { start?: string; entries: LedgerEntry[] };
  /** compact_boundary rows; main transcripts only. */
  compactions: CompactionEvent[];
}

/**
 * Title lines are tiny (`{"type":"custom-title","customTitle":"…","sessionId":"…"}`); a longer line is never
 * parsed for a title, whatever it contains.
 */
const MAX_TITLE_LINE = 16 * 1024;
const TITLE_TYPES = ['"custom-title"', '"ai-title"', '"agent-name"'] as const;
/** Account lines are small (under 1 KiB seen); a longer line is never parsed for one. */
const MAX_ACCOUNT_LINE = 16 * 1024;
const ACCOUNT_TYPES = ['"bridge-session"', '"artifact-autoreact-ledger"'] as const;
/** A line's timestamp may not be later than the file's mtime by more than this (clock skew). */
const FUTURE_SLACK_MS = 10 * 60_000;
const TS_KEY = '"timestamp":"';
const CWD_KEY = '"cwd":"';

/** A working directory as transcripts record it: an absolute path on one line, else undefined. */
export function pathField(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\") ? v : undefined;
}

/**
 * The top-level timestamp of a line that isn't otherwise parsed: the last `"timestamp":"…"` in it. Top-level
 * keys after `timestamp` hold no nested timestamps in practice (2.1.293: the last occurrence was the
 * top-level one on every user, attachment, progress and system line), while a nested one can come first.
 */
export function rawTimestamp(line: string): number | undefined {
  const i = line.lastIndexOf(TS_KEY);
  if (i === -1) return undefined;
  const start = i + TS_KEY.length;
  const end = line.indexOf('"', start);
  if (end === -1 || end - start > 40) return undefined;
  const t = Date.parse(line.slice(start, end));
  return Number.isNaN(t) ? undefined : t;
}

export class TranscriptReader {
  private readonly stats = emptyUsageStats();
  private readonly acc: UsageAccumulator;
  private readonly meta: TranscriptMeta = {};
  private readonly main: boolean;
  private readonly maxTsMs: number;
  private lastCostState: unknown;
  private readonly compactions: CompactionEvent[] = [];

  constructor(
    private readonly file: TranscriptFile,
    private readonly stamp: FileStamp,
  ) {
    this.acc = new UsageAccumulator(file, this.stats);
    this.main = file.kind === "main";
    this.maxTsMs = stamp.mtimeMs + FUTURE_SLACK_MS;
  }

  addLine(line: string): void {
    const assistant = line.includes('"assistant"');
    const cost = line.includes('"cost-state"');
    const compact = this.main && line.includes('"compact_boundary"');
    const title = this.main && line.length <= MAX_TITLE_LINE && TITLE_TYPES.some((t) => line.includes(t));
    const account = this.main && line.length <= MAX_ACCOUNT_LINE && line.includes('ccountUuid"') && ACCOUNT_TYPES.some((t) => line.includes(t));
    // One line per main transcript, usually the first: a nested object can hold a `cwd` key too, so the line is
    // parsed for its top-level one instead of trusting the first match.
    const needCwd = this.main && this.meta.cwd === undefined && line.includes(CWD_KEY);
    if (!assistant && !cost && !compact && !title && !needCwd && !account) {
      this.noteTs(rawTimestamp(line));
      return;
    }
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      if (assistant) this.stats.parseErrors++; // usually the partial last line of a live file
      else if (!cost && !compact && !title && !account) this.noteTs(rawTimestamp(line));
      return;
    }
    if (!isObj(d)) return;
    if (needCwd) {
      const cwd = pathField(d.cwd);
      if (cwd) this.meta.cwd = cwd;
    }
    if (typeof d.timestamp === "string") {
      const t = Date.parse(d.timestamp);
      this.noteTs(Number.isNaN(t) ? undefined : t);
    }
    if (assistant) {
      this.acc.addObject(d);
      if (this.main && d.type === "assistant") {
        const branch = sanitizeTitle(d.gitBranch);
        if (branch) this.meta.gitBranch = branch;
        const entrypoint = label(d.entrypoint);
        if (entrypoint) this.meta.entrypoint = entrypoint;
        const version = label(d.version);
        if (version) this.meta.version = version;
      }
    }
    if (cost && d.type === "cost-state") this.lastCostState = d;
    if (compact) {
      const ev = compactionFromLine(d, this.file.sessionId);
      if (ev) this.compactions.push(ev);
    }
    if (title) {
      // Only the title field of a top-level title line; every other key is ignored.
      if (d.type === "custom-title") this.meta.customTitle = sanitizeTitle(d.customTitle);
      else if (d.type === "ai-title") this.meta.aiTitle = sanitizeTitle(d.aiTitle);
      else if (d.type === "agent-name") this.meta.agentName = sanitizeTitle(d.agentName);
    }
    if (account) this.noteAccount(d);
  }

  /** Only the id fields of a top-level account line, hashed; every other key is ignored. */
  private noteAccount(d: Record<string, unknown>): void {
    const at = this.meta.lastTsMs;
    const ev =
      d.type === "bridge-session"
        ? accountEvidence(d.ownerAccountUuid, d.ownerOrganizationUuid, "transcript", "recorded", at)
        : d.type === "artifact-autoreact-ledger"
          ? accountEvidence(d.accountUuid, undefined, "transcript", "recorded", at)
          : undefined;
    if (!ev) return;
    if (ev.ref.orgKnown) this.meta.accountFull = ev;
    else this.meta.accountPartial = ev;
  }

  finish(): TranscriptParse {
    const ledger: TranscriptParse["ledger"] = { entries: [] };
    if (this.lastCostState !== undefined) {
      const start = costStateStart(this.lastCostState);
      if (start) ledger.start = start;
      ledger.entries = ledgerFromCostState(this.lastCostState, {
        sessionId: this.file.sessionId,
        kind: this.file.kind,
        observedAt: new Date(this.stamp.mtimeMs).toISOString(),
      });
    }
    const meta: TranscriptMeta = {};
    for (const [k, v] of Object.entries(this.meta)) if (v !== undefined) (meta as Record<string, unknown>)[k] = v;
    return { responses: this.acc.responses(), stats: this.stats, meta, ledger, compactions: this.compactions };
  }

  private noteTs(t: number | undefined): void {
    if (t === undefined || t > this.maxTsMs) return;
    if (this.meta.firstTsMs === undefined || t < this.meta.firstTsMs) this.meta.firstTsMs = t;
    if (this.meta.lastTsMs === undefined || t > this.meta.lastTsMs) this.meta.lastTsMs = t;
  }
}
