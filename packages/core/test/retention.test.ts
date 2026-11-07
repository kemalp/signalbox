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
    expect(w).toContain("older than 30 days in /Users/you/.claude-team (cleanupPeriodDays isn't set)");
    expect(w).toContain('Add "cleanupPeriodDays": 365 to /Users/you/.claude-team/settings.json');
    expect(w).toContain("shared with /Users/you/.claude; the shortest setting wins");
  });
});
