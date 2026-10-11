import { describe, expect, test } from "bun:test";
import type { GroupTotals } from "@signalbox/core";
import { buildStack } from "../src/stack.ts";
import { mockFleet, mockHealth, mockReport, type DayTotals } from "../src/mock.ts";

const NOW = new Date(2026, 9, 9, 15, 30);

function sumCost(rows: GroupTotals[]): number {
  return rows.reduce((a, g) => a + g.cost.total, 0);
}

describe("mock report", () => {
  const r = mockReport({ days: 7 }, NOW);

  test("one row per day, oldest first, ending today", () => {
    expect(r.byDay.map((d) => d.key)).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  test("every grouping sums to the total", () => {
    const total = r.totals.cost.total;
    expect(total).toBeGreaterThan(0);
    for (const rows of [r.byAgent, r.byModel, r.byProject, r.byKind, r.byDay]) {
      expect(sumCost(rows)).toBeCloseTo(total, 6);
    }
    for (const d of r.byDay as DayTotals[]) {
      expect(sumCost(d.byModel ?? [])).toBeCloseTo(d.cost.total, 6);
      expect(sumCost(d.byKind ?? [])).toBeCloseTo(d.cost.total, 6);
    }
    expect(r.estimate.recordedUsd).toBeCloseTo(total, 6);
    expect(r.estimate.estimatedLowUsd).toBeGreaterThan(total);
    expect(r.estimate.estimatedHighUsd).toBeGreaterThan(r.estimate.estimatedLowUsd);
  });

  test("derived token totals follow the contract formulas", () => {
    const t = r.totals.tokens;
    expect(r.totals.processedTokens).toBe(t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h);
    expect(r.totals.freshTokens).toBe(t.input + t.cacheWrite5m + t.cacheWrite1h + t.output);
    expect(r.totals.cacheHitRatio).toBeCloseTo(t.cacheRead / (t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input), 10);
  });

  test("the codex model is unpriced, not guessed", () => {
    const codex = mockReport({ days: 30 }, NOW);
    expect(codex.totals.unpricedModels).toEqual(["gpt-5.5-codex"]);
    const row = codex.byModel.find((g) => g.key === "gpt-5.5-codex");
    expect(row?.cost.total).toBe(0);
    expect(row?.unpricedTokens).toBeGreaterThan(0);
  });

  test("agent filter narrows every grouping", () => {
    const only = mockReport({ days: 7, agent: "claude-code" }, NOW);
    expect(only.byAgent.map((g) => g.key)).toEqual(["claude-code"]);
    expect(only.totals.unpricedModels).toEqual([]);
    expect(only.reconciliation.every((x) => x.agent === "claude-code")).toBe(true);
  });

  test("is deterministic", () => {
    expect(mockReport({ days: 7 }, NOW)).toEqual(r);
  });
});

describe("mock fleet", () => {
  const f = mockFleet(NOW);
  test("4 Claude sessions (one waiting) and 1 Codex session", () => {
    expect(f.sessions.filter((s) => s.agent === "claude-code").length).toBe(4);
    expect(f.sessions.filter((s) => s.agent === "codex").length).toBe(1);
    expect(f.sessions.filter((s) => s.status === "waiting").length).toBe(1);
  });
  test("Claude 5h + weekly limits and Codex primary/secondary", () => {
    const kinds = f.limits.map((l) => `${l.agent}:${l.kind}`);
    expect(kinds).toContain("claude-code:five_hour");
    expect(kinds).toContain("claude-code:seven_day");
    expect(kinds).toContain("codex:codex.primary");
    expect(kinds).toContain("codex:codex.secondary");
  });
  test("health covers all three stability levels", () => {
    expect(new Set(mockHealth().map((h) => h.stability))).toEqual(new Set(["documented", "preview", "internal"]));
  });
});

describe("buildStack", () => {
  const r = mockReport({ days: 30 }, NOW);

  test("token-type stack sums to the day totals", () => {
    const s = buildStack(r, "type");
    expect(s.days.length).toBe(30);
    s.totals.forEach((t, i) => expect(t).toBeCloseTo(r.byDay[i]!.cost.total, 6));
  });

  test("kind stack uses fixed slots", () => {
    const s = buildStack(r, "kind");
    const byKey = Object.fromEntries(s.series.map((x) => [x.key, x.color]));
    expect(byKey.main).toBe("--series-1");
    expect(byKey.subagent).toBe("--series-2");
    expect(byKey.workflow).toBe("--series-3");
    expect(byKey.auxiliary).toBe("--series-4");
  });

  test("a model keeps its colour when the filter removes others", () => {
    const all = buildStack(r, "model");
    const opus = all.series.find((x) => x.key === "claude-opus-5-5")?.color;
    const haiku = all.series.find((x) => x.key === "claude-haiku-4-5")?.color;
    const filtered = buildStack(mockReport({ days: 7, agent: "claude-code" }, NOW), "model");
    expect(filtered.series.find((x) => x.key === "claude-opus-5-5")?.color).toBe(opus);
    expect(filtered.series.find((x) => x.key === "claude-haiku-4-5")?.color).toBe(haiku);
  });
});
