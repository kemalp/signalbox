// Transcript retention: which values Claude Code accepts, and when a period is short, invalid or unknown.
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_DEFAULT_RETENTION_DAYS,
  invalidRetentionText,
  isValidRetentionDays,
  RETENTION_WARN_DAYS,
  retentionDays,
  retentionStatus,
  retentionText,
  retentionWarning,
  type RetentionInfo,
} from "../src/index.ts";

const base = (extra: Partial<RetentionInfo> = {}): RetentionInfo => ({
  agent: "claude-code",
  configDir: "/Users/you/.claude",
  source: "default",
  defaultDays: CLAUDE_CODE_DEFAULT_RETENTION_DAYS,
  ...extra,
});

describe("retention", () => {
  test("Claude Code takes a whole number of days, 1 or more", () => {
    for (const v of [1, 30, 365, 3650]) expect(isValidRetentionDays(v)).toBe(true);
    for (const v of [0, -1, 2.5, "30", null, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) expect(isValidRetentionDays(v)).toBe(false);
  });

  test("an invalid value is kept as short, one-line JSON text", () => {
    expect(invalidRetentionText(0)).toBe("0");
    expect(invalidRetentionText("30")).toBe('"30"');
    expect(invalidRetentionText("a\nb")).toBe('"a\\nb"');
    expect(invalidRetentionText("x".repeat(100))).toHaveLength(40);
    expect(invalidRetentionText({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  test("unset means the default, 30 days: short against the 90-day threshold, fine with the check off", () => {
    expect(RETENTION_WARN_DAYS).toBe(90);
    expect(retentionDays(base())).toBe(30);
    expect(retentionStatus(base())).toBe("short");
    expect(retentionStatus(base(), 30)).toBe("ok");
    expect(retentionStatus(base(), 0)).toBe("ok");
    expect(retentionText(base())).toBe("30 days (not set: the default)");
  });

  test("a set value, a managed one, an invalid one and an unreadable file", () => {
    const year = base({ source: "user", days: 365, file: "/Users/you/.claude/settings.json" });
    expect(retentionStatus(year)).toBe("ok");
    expect(retentionText(year)).toBe("365 days (settings.json)");
    expect(retentionWarning(year)).toBeUndefined();
    const managed = base({ source: "managed", days: 60 });
    expect(retentionStatus(managed)).toBe("short");
    expect(retentionWarning(managed)).toContain("only they can change it");
    const zero = base({ source: "user", invalid: "0", file: "/Users/you/.claude/settings.json" });
    expect(retentionDays(zero)).toBeUndefined();
    expect(retentionStatus(zero, 0)).toBe("invalid");
    expect(retentionText(zero)).toBe("invalid cleanupPeriodDays 0 (settings.json)");
    expect(retentionWarning(zero)).toContain("whole number of days, 1 or more");
    const broken = base({ problem: "/Users/you/.claude/settings.json isn't valid JSON" });
    expect(retentionStatus(broken)).toBe("unknown");
    expect(retentionWarning(broken)).toContain("Can't tell");
  });

  test("the warning says what to add, and mentions a shared transcripts folder", () => {
    const w = retentionWarning(base({ configDir: "/Users/you/.claude-team", sharesTranscriptsWith: ["/Users/you/.claude"] }))!;
    expect(w).toContain("terminal and SDK session transcripts older than 30 days in /Users/you/.claude-team (cleanupPeriodDays isn't set)");
    expect(w).toContain('Add "cleanupPeriodDays": 365 to /Users/you/.claude-team/settings.json');
    expect(w).toContain("Desktop app sessions are kept from Claude Code 2.1.248 on, unless desktopSessionCleanupPeriodDays is set");
    expect(w).toContain("shared with /Users/you/.claude; the shortest setting wins");
  });

  test("a managed value covers desktop sessions too, and the files can be replaced by sources Signalbox can't see", () => {
    const w = retentionWarning(base({ source: "managed", days: 14, file: "/Library/Application Support/ClaudeCode/managed-settings.json" }))!;
    expect(w).toContain("desktop app sessions included, older than 14 days");
    expect(w).toContain("cleanupPeriodDays is 14 in /Library/Application Support/ClaudeCode/managed-settings.json");
    expect(w).toContain("an MDM profile or console-served settings");
    expect(w).not.toContain("Add ");
  });

  test("an invalid value pauses the cleanup; it never falls back to the default", () => {
    const w = retentionWarning(base({ source: "user", invalid: "0", file: "/Users/you/.claude/settings.json" }))!;
    expect(w).toContain("pauses its transcript cleanup, so nothing is deleted");
    expect(w).not.toContain("fall back");
  });

  test("one day is singular", () => {
    const one = base({ source: "user", days: 1, file: "/Users/you/.claude/settings.json" });
    expect(retentionText(one)).toBe("1 day (settings.json)");
    expect(retentionWarning(one)).toContain("older than 1 day in");
  });

  test("a value that isn't a whole number of days, or a missing one from a file, is unknown, never the default", () => {
    for (const days of [0, -3, 1.5, Number.NaN]) {
      const r = base({ source: "user", days, file: "/Users/you/.claude/settings.json" });
      expect(retentionDays(r)).toBeUndefined();
      expect(retentionStatus(r, 30)).toBe("unknown");
    }
    const noValue = base({ source: "managed" });
    expect(retentionDays(noValue)).toBeUndefined();
    expect(retentionStatus(noValue)).toBe("unknown");
    expect(retentionText(noValue)).toBe("unknown (no valid value from managed settings)");
    expect(retentionWarning(noValue)).toContain("Can't tell");
  });
});
