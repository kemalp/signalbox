import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PriceTable } from "@signalbox/core";

const table = JSON.parse(readFileSync(join(import.meta.dir, "../../../pricing/openai.json"), "utf8")) as PriceTable & {
  models: Record<string, PriceTable["models"][string] & { fast?: Record<string, number> }>;
};
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
const isRate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

describe("pricing/openai.json", () => {
  test("metadata", () => {
    expect(table.provider).toBe("openai");
    expect(table.currency).toBe("USD");
    expect(table.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(table.sourceUrl).toStartWith("https://developers.openai.com/");
  });

  test("every row has non-negative rates; exact ids only", () => {
    for (const [id, row] of Object.entries(table.models)) {
      expect(id.includes("*")).toBe(false);
      for (const k of RATE_KEYS) expect(isRate(row[k])).toBe(true);
      expect(row.cacheRead).toBeLessThanOrEqual(row.input);
      expect(row.cacheWrite1h).toBe(row.cacheWrite5m);
      if (row.longContext) {
        expect(row.longContext.thresholdTokens).toBe(272000);
        for (const k of RATE_KEYS) expect(isRate(row.longContext[k])).toBe(true);
      }
      if (row.fast) for (const k of RATE_KEYS) expect(isRate(row.fast[k])).toBe(true);
    }
  });

  test("models Codex uses that have a public price are present; ones without stay unpriced", () => {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex"]) {
      expect(table.models[id]).toBeDefined();
    }
    for (const id of ["gpt-reserve", "codex-auto-review", "gpt-5.3-codex-spark"]) expect(table.models[id]).toBeUndefined();
  });

  test("GPT-5.6+ cache writes are 1.25x input; GPT-5.5 has no write premium", () => {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const row = table.models[id]!;
      expect(row.cacheWrite5m).toBeCloseTo(row.input * 1.25, 10);
    }
    expect(table.models["gpt-5.5"]!.cacheWrite5m).toBe(table.models["gpt-5.5"]!.input);
  });
});
