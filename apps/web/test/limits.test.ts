import { describe, expect, test } from "bun:test";
import { STALE_AFTER_MS, claudeLimitsHint, limitState } from "../src/limits.tsx";

describe("claudeLimitsHint", () => {
  test("points at the tap mod when its spool is missing, and at /usage only once the mod is loaded", () => {
    const spool = (ok: boolean) => ({ name: "claude-code:spool", stability: "preview" as const, ok, detail: "synthetic" });
    expect(claudeLimitsHint(spool(false))).toBe("no-tap");
    expect(claudeLimitsHint(spool(true))).toBe("tap-waiting");
    expect(claudeLimitsHint(undefined)).toBe("unknown");
  });
});

describe("limitState", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  test("only a recent reading whose window hasn't reset is fresh", () => {
    expect(limitState({ observedAt: at(-60_000), resetsAt: at(3_600_000) }, now)).toBe("fresh");
    expect(limitState({ observedAt: at(-STALE_AFTER_MS), resetsAt: at(3_600_000) }, now)).toBe("fresh");
    expect(limitState({ observedAt: at(-60_000), resetsAt: undefined }, now)).toBe("fresh");
  });

  test("an old reading is stale even before its reset", () => {
    expect(limitState({ observedAt: at(-STALE_AFTER_MS - 1000), resetsAt: at(3_600_000) }, now)).toBe("stale");
    expect(limitState({ observedAt: "not a date", resetsAt: at(3_600_000) }, now)).toBe("stale");
  });

  test("reset passed beats stale", () => {
    expect(limitState({ observedAt: at(-60_000), resetsAt: at(0) }, now)).toBe("reset-passed");
    expect(limitState({ observedAt: at(-86_400_000), resetsAt: at(-1000) }, now)).toBe("reset-passed");
  });
});
