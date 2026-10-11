import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  autoCompactPercent,
  contextWindowFor,
  DEFAULT_MODELS_DIR,
  EMBEDDED_MODEL_FILES,
  embeddedModelTables,
  embeddedPriceTables,
  fillContextWindow,
  findModelSpec,
  parseModelTable,
  type ContextSnapshot,
} from "../src/index.ts";

const tables = embeddedModelTables();

describe("embedded model tables", () => {
  test("are exactly the repo's models/*.json files", () => {
    // A model file added to models/ but not to EMBEDDED_MODELS would silently go missing from the compiled binary.
    expect([...EMBEDDED_MODEL_FILES]).toEqual(readdirSync(DEFAULT_MODELS_DIR).filter((n) => n.endsWith(".json")).sort());
  });

  test("every Claude model with a price has a documented window, with its source", () => {
    const priced = Object.keys(embeddedPriceTables().find((t) => t.provider === "anthropic")!.models).sort();
    const anthropic = tables.find((t) => t.provider === "anthropic")!;
    expect(Object.keys(anthropic.models).sort()).toEqual(priced);
    for (const [key, spec] of Object.entries(anthropic.models)) {
      expect(spec.contextWindow === 1_000_000 || spec.contextWindow === 200_000, key).toBe(true);
      expect(spec.sourceUrl, key).toStartWith("https://platform.claude.com/docs/");
      expect(spec.asOf, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("lookups", () => {
  test("documented windows: exact ids, dated snapshots, provider tags stripped like prices", () => {
    expect(contextWindowFor("claude-opus-5-5", tables)).toEqual({ window: 1_000_000, key: "claude-opus-5-5" });
    expect(contextWindowFor("claude-haiku-4-5-20251001", tables)).toEqual({ window: 200_000, key: "claude-haiku-4-5*" });
    expect(contextWindowFor("claude-opus-4-20250514", tables)?.window).toBe(200_000);
    expect(findModelSpec("claude-sonnet-5-5", tables)?.spec.maxOutput).toBe(128_000);
    // Retired models: the window is documented, the max output no longer is.
    expect(findModelSpec("claude-opus-4-1-20250805", tables)?.spec.maxOutput).toBeUndefined();
  });

  test("unknown models have no window; family prefixes are never guessed", () => {
    for (const m of ["claude-opus-6", "claude-experimental-x", "gpt-5.5", "opus", "", "<synthetic>"]) {
      expect(contextWindowFor(m, tables, "claude-code"), m).toBeUndefined();
    }
  });

  test("Claude Code's [1m] suffix means a 1M window, whatever the base model's documented size", () => {
    expect(contextWindowFor("claude-sonnet-4-5[1m]", tables, "claude-code")).toEqual({ window: 1_000_000, key: "[1m]" });
    expect(contextWindowFor("sonnet[1m]", tables, "claude-code")?.window).toBe(1_000_000);
    // Other agents don't use the suffix: the tag is stripped and the documented size applies.
    expect(contextWindowFor("claude-sonnet-4-5[1m]", tables, "codex")?.window).toBe(200_000);
  });

  test("auto-compact point: only for an agent and window that were observed", () => {
    expect(autoCompactPercent("claude-code", 1_000_000, tables)).toBe(96.7);
    expect(autoCompactPercent("claude-code", 200_000, tables)).toBeUndefined();
    expect(autoCompactPercent("codex", 1_000_000, tables)).toBeUndefined();
  });
});

describe("fillContextWindow", () => {
  const base: ContextSnapshot = { agent: "claude-code", sessionId: "s", tokens: 412_300, observedAt: "2026-10-10T00:00:00.000Z", quality: "estimated", source: "transcript" };

  test("fills window, percent and the auto-compact point from the first model that resolves", () => {
    expect(fillContextWindow(base, ["opus", undefined, "claude-opus-5-5"], tables)).toEqual({
      ...base,
      window: 1_000_000,
      windowSource: "model-table",
      percent: 41.2,
      autoCompactAtPercent: 96.7,
    });
  });

  test("an agent-reported window and percent win", () => {
    const official: ContextSnapshot = { ...base, quality: "official", source: "spool", window: 200_000, windowSource: "agent", percent: 50 };
    expect(fillContextWindow(official, ["claude-opus-5-5"], tables)).toEqual(official);
  });

  test("a prompt bigger than the documented window leaves the window unknown", () => {
    const big = { ...base, tokens: 350_000 };
    expect(fillContextWindow(big, ["claude-sonnet-4-5-20250929"], tables)).toEqual(big);
  });

  test("no model, or an unknown one, changes nothing", () => {
    expect(fillContextWindow(base, [], tables)).toEqual(base);
    expect(fillContextWindow(base, ["claude-experimental-x"], tables)).toEqual(base);
    expect(fillContextWindow({ ...base, agent: "codex" }, ["gpt-5.5"], tables)).toEqual({ ...base, agent: "codex" });
  });
});

describe("parseModelTable", () => {
  const good = () => ({
    provider: "p",
    asOf: "2026-10-10",
    sourceUrl: "https://example.test",
    models: { m: { contextWindow: 1000, maxOutput: 100, asOf: "2026-10-10", sourceUrl: "https://example.test/m" } },
    agents: { a: { stability: "internal", observedIn: "a 1.0", asOf: "2026-10-10", source: "seen", idTags: { "[1m]": 1_000_000 }, autoCompact: [{ contextWindow: 1000, thresholdTokens: 900 }] } },
    futureKey: true,
  });

  test("accepts a valid table and keeps unknown keys", () => {
    expect(parseModelTable(good())).toMatchObject({ provider: "p", futureKey: true });
  });

  test("rejects malformed tables", () => {
    const cases: Array<(t: ReturnType<typeof good>) => unknown> = [
      (t) => ({ ...t, sourceUrl: "" }),
      (t) => ({ ...t, models: [] }),
      (t) => ({ ...t, models: { "a*b": t.models.m } }),
      (t) => ({ ...t, models: { m: { ...t.models.m, contextWindow: 0 } } }),
      (t) => ({ ...t, models: { m: { ...t.models.m, contextWindow: 1.5 } } }),
      (t) => ({ ...t, models: { m: { ...t.models.m, maxOutput: -1 } } }),
      (t) => ({ ...t, models: { m: { ...t.models.m, sourceUrl: undefined } } }),
      (t) => ({ ...t, agents: { a: { ...t.agents.a, stability: "guess" } } }),
      (t) => ({ ...t, agents: { a: { ...t.agents.a, idTags: { "1m": 1_000_000 } } } }),
      (t) => ({ ...t, agents: { a: { ...t.agents.a, autoCompact: [{ contextWindow: 1000, thresholdTokens: 1200 }] } } }),
      (t) => ({ ...t, notes: [1] }),
    ];
    for (const [i, make] of cases.entries()) expect(() => parseModelTable(make(good())), `case ${i}`).toThrow();
  });
});
