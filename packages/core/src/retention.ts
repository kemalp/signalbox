// Transcript retention: how long an agent keeps session transcripts, and whether that is shorter than you want.
// Claude Code deletes transcripts (and the rest of its per-session data) older than `cleanupPeriodDays`, in a
// background sweep after any session starts; once deleted, Signalbox's history and cost figures lose them too.
// Semantics from https://code.claude.com/docs/en/settings-reference#cleanupperioddays and
// https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically (checked 2026-11): a whole number of days,
// at least 1, default 30; 0 fails validation, and while the period can't be determined the sweep pauses.
import type { RetentionInfo } from "./types.ts";

/** Claude Code's default when no settings file sets cleanupPeriodDays. */
export const CLAUDE_CODE_DEFAULT_RETENTION_DAYS = 30;
/** `signalbox doctor` warns below this many days; the app's default threshold too. */
export const RETENTION_WARN_DAYS = 90;
/** The longest raw text kept for an invalid value. */
const INVALID_TEXT_MAX = 40;

/**
 * "ok", "short" (kept for fewer days than `warnBelowDays`; 0 turns that check off), "invalid" (the setting isn't a
 * whole number of days, 1 or more: Claude Code reports a settings error) or "unknown" (a file couldn't be read).
 */
export type RetentionStatus = "ok" | "short" | "invalid" | "unknown";

/** A value Claude Code accepts: a whole number of days, 1 or more. */
export function isValidRetentionDays(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/** An invalid value as JSON text, one line, at most 40 characters. */
export function invalidRetentionText(v: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    text = String(v);
  }
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return text.length <= INVALID_TEXT_MAX ? text : `${text.slice(0, INVALID_TEXT_MAX - 1)}…`;
}

/** The days in force: the value set, else the default; undefined when invalid or unknown. */
export function retentionDays(r: RetentionInfo): number | undefined {
  if (r.problem !== undefined || r.invalid !== undefined) return undefined;
  return r.days ?? r.defaultDays;
}

export function retentionStatus(r: RetentionInfo, warnBelowDays: number = RETENTION_WARN_DAYS): RetentionStatus {
  if (r.problem !== undefined) return "unknown";
  if (r.invalid !== undefined) return "invalid";
  const days = r.days ?? r.defaultDays;
  return warnBelowDays > 0 && days < warnBelowDays ? "short" : "ok";
}

/** "365 days (settings.json)", "30 days (not set: the default)", "60 days (managed settings)", "invalid: 0". */
export function retentionText(r: RetentionInfo): string {
  if (r.problem !== undefined) return `unknown (${r.problem})`;
  const where = r.source === "managed" ? "managed settings" : r.source === "user" ? "settings.json" : "not set: the default";
  if (r.invalid !== undefined) return `invalid cleanupPeriodDays ${r.invalid} (${where})`;
  const days = r.days ?? r.defaultDays;
  return `${days} ${days === 1 ? "day" : "days"} (${where})`;
}

/** A doctor warning for a dir whose status isn't "ok", or undefined. */
export function retentionWarning(r: RetentionInfo, warnBelowDays: number = RETENTION_WARN_DAYS): string | undefined {
  const status = retentionStatus(r, warnBelowDays);
  const dir = r.configDir;
  const shared = r.sharesTranscriptsWith?.length ? ` Its transcripts folder is shared with ${r.sharesTranscriptsWith.join(", ")}; the shortest setting wins.` : "";
  switch (status) {
    case "ok":
      return undefined;
    case "unknown":
      return `Can't tell how long Claude Code keeps transcripts in ${dir}: ${r.problem}.`;
    case "invalid":
      return (
        `cleanupPeriodDays in ${r.file ?? dir} is ${r.invalid}, which Claude Code rejects (it takes a whole number of days, 1 or more). ` +
        `Interactive sessions report a settings error; runs that skip the broken value fall back to ${r.defaultDays} days.${shared}`
      );
    case "short": {
      const days = r.days ?? r.defaultDays;
      const why = r.source === "default" ? "cleanupPeriodDays isn't set" : `cleanupPeriodDays is ${days}${r.source === "managed" ? " in the managed settings" : ""}`;
      const fix = r.source === "managed" ? "Your organization's managed settings set it, so only they can change it." : `Add "cleanupPeriodDays": 365 to ${dir}/settings.json to keep them for a year; Signalbox never edits it.`;
      return `Claude Code deletes transcripts older than ${days} days in ${dir} (${why}), and Signalbox's history and costs lose them too. ${fix}${shared}`;
    }
  }
}
