// Transcript retention: how long an agent keeps session transcripts, and whether that is shorter than you want.
// Claude Code deletes transcripts (and the rest of its per-session data) older than `cleanupPeriodDays`, in a
// background sweep after a session starts; once deleted, Signalbox's history and cost figures lose them too.
// Semantics from https://code.claude.com/docs/en/settings-reference#cleanupperioddays and
// https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically (checked 2026-11): a whole number of days,
// at least 1, default 30; 0 fails validation, and while the period can't be determined (an invalid value, a settings
// file that isn't valid JSON or can't be read) the sweep pauses. From Claude Code 2.1.248 on, desktop app and Cowork
// sessions are kept at any age unless managed settings set cleanupPeriodDays or desktopSessionCleanupPeriodDays is
// set (which Signalbox doesn't read).
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

/** The version from which Claude Code keeps desktop app sessions unless told otherwise. */
export const CLAUDE_CODE_DESKTOP_KEPT_SINCE = "2.1.248";

/** The days in force: the value set, else the default; undefined when invalid or unknown. */
export function retentionDays(r: RetentionInfo): number | undefined {
  if (r.problem !== undefined || r.invalid !== undefined) return undefined;
  if (r.days === undefined) return r.source === "default" ? r.defaultDays : undefined;
  return isValidRetentionDays(r.days) ? r.days : undefined;
}

export function retentionStatus(r: RetentionInfo, warnBelowDays: number = RETENTION_WARN_DAYS): RetentionStatus {
  if (r.problem !== undefined) return "unknown";
  if (r.invalid !== undefined) return "invalid";
  const days = retentionDays(r);
  if (days === undefined) return "unknown";
  return warnBelowDays > 0 && days < warnBelowDays ? "short" : "ok";
}

const dayCount = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** "365 days (settings.json)", "30 days (not set: the default)", "60 days (managed settings)", "invalid: 0". */
export function retentionText(r: RetentionInfo): string {
  if (r.problem !== undefined) return `unknown (${r.problem})`;
  const where = r.source === "managed" ? "managed settings" : r.source === "user" ? "settings.json" : r.source === "default" ? "not set: the default" : r.source;
  if (r.invalid !== undefined) return `invalid cleanupPeriodDays ${r.invalid} (${where})`;
  const days = retentionDays(r);
  return days === undefined ? `unknown (no valid value from ${where})` : `${dayCount(days)} (${where})`;
}

/** A doctor warning for a dir whose status isn't "ok", or undefined. */
export function retentionWarning(r: RetentionInfo, warnBelowDays: number = RETENTION_WARN_DAYS): string | undefined {
  const status = retentionStatus(r, warnBelowDays);
  const dir = r.configDir;
  const shared = r.sharesTranscriptsWith?.length ? ` Its transcripts folder is shared with ${r.sharesTranscriptsWith.join(", ")}; the shortest setting wins.` : "";
  const managed = r.source === "managed";
  switch (status) {
    case "ok":
      return undefined;
    case "unknown":
      return `Can't tell how long Claude Code keeps transcripts in ${dir}: ${r.problem ?? "no valid value"}.`;
    case "invalid":
      return (
        `cleanupPeriodDays in ${r.file ?? dir} is ${r.invalid}, which Claude Code rejects (it takes a whole number of days, 1 or more). ` +
        `Until it's fixed, interactive sessions report a settings error and Claude Code pauses its transcript cleanup, so nothing is deleted.${shared}`
      );
    case "short": {
      const days = retentionDays(r)!;
      const why = r.source === "default" ? "cleanupPeriodDays isn't set" : `cleanupPeriodDays is ${days}${managed ? ` in ${r.file ?? "the managed settings"}` : ""}`;
      const what = managed ? "session transcripts, desktop app sessions included," : "terminal and SDK session transcripts";
      const fix = managed
        ? "Your organization's managed settings set it, so only they can change it (an MDM profile or console-served settings, if your organization uses them, replace the managed files; Signalbox can't see those)."
        : `Add "cleanupPeriodDays": 365 to ${dir}/settings.json to keep them for a year; Signalbox never edits it. Desktop app sessions are kept from Claude Code ${CLAUDE_CODE_DESKTOP_KEPT_SINCE} on, unless desktopSessionCleanupPeriodDays is set.`;
      return `Claude Code deletes ${what} older than ${dayCount(days)} in ${dir} (${why}), and Signalbox's history and costs lose them too. ${fix}${shared}`;
    }
  }
}
