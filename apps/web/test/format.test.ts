import { describe, expect, test } from "bun:test";
import {
  DASH,
  basename,
  clipId,
  contextPercent,
  fmtAgo,
  fmtCountdown,
  fmtDuration,
  fmtPercent,
  fmtRatio,
  fmtTokens,
  fmtUsd,
  fmtUsdTick,
  limitLabel,
  niceCeil,
  parseHashToken,
  severity,
  windowLabel,
} from "../src/format.ts";

describe("fmtUsd", () => {
  test("two decimals with grouping", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.086)).toBe("$0.09");
    expect(fmtUsd(657.123)).toBe("$657.12");
    expect(fmtUsd(6987.4)).toBe("$6,987.40");
    expect(fmtUsd(1234567.891)).toBe("$1,234,567.89");
  });
  test("tiny non-zero values don't read as zero", () => {
    expect(fmtUsd(0.001)).toBe("<$0.01");
  });
  test("unknown is a dash, never $0", () => {
    expect(fmtUsd(undefined)).toBe(DASH);
    expect(fmtUsd(null)).toBe(DASH);
    expect(fmtUsd(Number.NaN)).toBe(DASH);
  });
  test("axis ticks", () => {
    expect(fmtUsdTick(0)).toBe("$0");
    expect(fmtUsdTick(50)).toBe("$50");
    expect(fmtUsdTick(2.5)).toBe("$2.50");
    expect(fmtUsdTick(1500)).toBe("$1.5K");
  });
});

describe("fmtTokens", () => {
  test("K / M / B with ~3 significant digits", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1K");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500)).toBe("1.5K");
    expect(fmtTokens(12_345)).toBe("12.3K");
    expect(fmtTokens(212_000)).toBe("212K");
    expect(fmtTokens(45_500_000)).toBe("45.5M");
    expect(fmtTokens(1_880_000_000)).toBe("1.88B");
    expect(fmtTokens(1_838_660_000_000)).toBe("1839B");
  });
  test("rounding never shows 1000K", () => {
    expect(fmtTokens(999_999)).toBe("1M");
    expect(fmtTokens(999_960_000)).toBe("1B");
  });
  test("unknown is a dash", () => {
    expect(fmtTokens(undefined)).toBe(DASH);
  });
});

describe("percent and ratio", () => {
  test("formats", () => {
    expect(fmtRatio(0.977)).toBe("97.7%");
    expect(fmtRatio(undefined)).toBe(DASH);
    expect(fmtPercent(63)).toBe("63%");
    expect(fmtPercent(96.7, 1)).toBe("96.7%");
  });
  test("severity thresholds", () => {
    expect(severity(10)).toBe("ok");
    expect(severity(75)).toBe("warn");
    expect(severity(90)).toBe("crit");
    expect(severity(undefined)).toBe("ok");
  });
});

describe("time", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  test("durations", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(12 * 60_000)).toBe("12m");
    expect(fmtDuration(2 * 3600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(fmtDuration(3 * 3600_000)).toBe("3h");
    expect(fmtDuration(3 * 86_400_000 + 4 * 3600_000)).toBe("3d 4h");
  });
  test("ago", () => {
    expect(fmtAgo("2026-10-09T11:59:20Z", now)).toBe("40s ago");
    expect(fmtAgo("2026-10-09T12:00:01Z", now)).toBe("just now");
    expect(fmtAgo(undefined, now)).toBe(DASH);
    expect(fmtAgo("not a date", now)).toBe(DASH);
  });
  test("countdown", () => {
    expect(fmtCountdown("2026-10-09T14:14:00Z", now)).toBe("resets in 2h 14m");
    expect(fmtCountdown("2026-10-09T11:00:00Z", now)).toBe("reset passed");
    expect(fmtCountdown(undefined, now)).toBe("reset time unknown");
  });
});

describe("labels", () => {
  test("limit labels keep unknown kinds verbatim", () => {
    expect(limitLabel({ kind: "five_hour" })).toBe("5-hour window");
    expect(limitLabel({ kind: "codex.secondary" })).toBe("Secondary window");
    expect(limitLabel({ kind: "five_hour", label: "Session" })).toBe("Session");
    expect(limitLabel({ kind: "brand_new_bucket" })).toBe("brand_new_bucket");
  });
  test("window labels", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(90)).toBe("90m");
    expect(windowLabel(undefined)).toBeUndefined();
  });
  test("clipId keeps short ids and clips long ones", () => {
    expect(clipId("claude-mystery-9")).toBe("claude-mystery-9");
    const long = "x".repeat(300);
    expect(clipId(long)).toHaveLength(64);
    expect(clipId(long).endsWith("…")).toBe(true);
  });
  test("basename", () => {
    expect(basename("/Users/you/code/api-refactor")).toBe("api-refactor");
    expect(basename("/Users/you/code/api-refactor/")).toBe("api-refactor");
    expect(basename("C:\\work\\repo")).toBe("repo");
    expect(basename(undefined)).toBeUndefined();
  });
  test("context percent falls back to tokens / window", () => {
    const base = { agent: "claude-code", sessionId: "s", observedAt: "", source: "t" } as const;
    expect(contextPercent({ ...base, tokens: 500, window: 1000, quality: "estimated" })).toBe(50);
    expect(contextPercent({ ...base, tokens: 500, percent: 41.2, quality: "official" })).toBe(41.2);
    expect(contextPercent({ ...base, tokens: 500, quality: "estimated" })).toBeUndefined();
    expect(contextPercent(undefined)).toBeUndefined();
  });
});

describe("parseHashToken", () => {
  test("reads #token=", () => {
    const t = "Abc_def-0123456789xyzXYZ0123456789abcdefghi";
    expect(parseHashToken(`#token=${t}`)).toBe(t);
    expect(parseHashToken(`token=${t}`)).toBe(t);
    expect(parseHashToken(`#foo=1&token=${t}`)).toBe(t);
  });
  test("rejects missing or junk tokens", () => {
    expect(parseHashToken("")).toBeUndefined();
    expect(parseHashToken("#token=")).toBeUndefined();
    expect(parseHashToken("#token=short")).toBeUndefined();
    expect(parseHashToken("#token=<script>alert(1)</script>xxxxxxxx")).toBeUndefined();
  });
});

describe("niceCeil", () => {
  test("rounds up to 1/2/2.5/5 x 10^n", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(87)).toBe(100);
    expect(niceCeil(101)).toBe(200);
    expect(niceCeil(230)).toBe(250);
    expect(niceCeil(4.2)).toBe(5);
    expect(niceCeil(0.031)).toBeCloseTo(0.05);
  });
});
