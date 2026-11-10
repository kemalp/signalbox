import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embeddedPriceTables, findPrice, inPeakHours, priceTokens, type PriceTable } from "@signalbox/core";

const load = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../../pricing", name), "utf8")) as PriceTable;
const deepseek = load("deepseek.json");
const moonshot = load("moonshot.json");
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
const isRate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const million = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("pricing/deepseek.json", () => {
  test("metadata", () => {
    expect(deepseek.provider).toBe("deepseek");
    expect(deepseek.currency).toBe("USD");
    expect(deepseek.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(deepseek.sourceUrl).toStartWith("https://api-docs.deepseek.com/");
  });

  test("every row has a peak and an off-peak tier, off-peak at half; exact ids only", () => {
    for (const [id, row] of Object.entries(deepseek.models)) {
      expect(id.includes("*")).toBe(false);
      for (const k of RATE_KEYS) expect(isRate(row[k])).toBe(true);
      expect(row.offPeak).toBeDefined();
      for (const k of RATE_KEYS) expect(row.offPeak![k]).toBeCloseTo(row[k] / 2, 12);
      // No cache-write price is published: a miss is ordinary input.
      expect(row.cacheWrite5m).toBe(row.input);
      expect(row.cacheWrite1h).toBe(row.input);
      expect(row.cacheRead).toBeLessThan(row.input);
    }
  });

  test("the published rows, and the names that are billed as Flash", () => {
    expect(deepseek.models["deepseek-flash"]).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0.006 });
    expect(deepseek.models["deepseek-v4-pro"]).toMatchObject({ input: 1.32, output: 3.96, cacheRead: 0.044 });
    for (const alias of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash", "deepseek-v4.1-flash:cloud"]) {
      expect(deepseek.models[alias]).toEqual(deepseek.models["deepseek-flash"]!);
    }
    // Nothing is guessed for a model the page does not list.
    for (const id of ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro:cloud", "deepseek-v5", "hy4-preview", "glm-5.2:cloud"]) expect(findPrice(id, embeddedPriceTables())).toBeUndefined();
  });

  test("peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday", () => {
    const peak = (iso: string) => inPeakHours(deepseek.peakHours!, Date.parse(iso));
    expect(deepseek.peakHours).toHaveLength(2);
    expect(["2026-11-09T01:00:00Z", "2026-11-10T03:59:00Z", "2026-11-11T06:00:00Z", "2026-11-13T09:59:59Z"].map(peak)).toEqual([true, true, true, true]);
    expect(["2026-11-09T00:59:00Z", "2026-11-09T04:00:00Z", "2026-11-09T05:30:00Z", "2026-11-09T10:00:00Z", "2026-11-14T02:00:00Z", "2026-11-15T07:00:00Z"].map(peak)).toEqual([false, false, false, false, false, false]);
  });

  test("a harness response is priced by when it was made", () => {
    const tables = embeddedPriceTables();
    const peak = priceTokens("deepseek-v4.1-flash", million, tables, { at: "2026-11-09T07:00:00Z" });
    expect(peak).toMatchObject({ priced: true, key: "deepseek-v4.1-flash", offPeak: false });
    expect(peak.cost.total).toBeCloseTo(0.3 + 1.2 + 0.006, 10);
    const off = priceTokens("deepseek-v4.1-flash", million, tables, { at: "2026-11-09T20:00:00Z" });
    expect(off.offPeak).toBe(true);
    expect(off.cost.total).toBeCloseTo(0.15 + 0.6 + 0.003, 10);
  });
});

describe("pricing/moonshot.json", () => {
  test("metadata", () => {
    expect(moonshot.provider).toBe("moonshot");
    expect(moonshot.currency).toBe("USD");
    expect(moonshot.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(moonshot.sourceUrl).toStartWith("https://platform.kimi.ai/");
    expect(moonshot.peakHours).toBeUndefined();
  });

  test("every row has non-negative rates; exact ids only", () => {
    for (const [id, row] of Object.entries(moonshot.models)) {
      expect(id.includes("*")).toBe(false);
      for (const k of RATE_KEYS) expect(isRate(row[k])).toBe(true);
      expect(row.cacheRead).toBeLessThan(row.input);
      expect(row.offPeak).toBeUndefined();
    }
  });

  test("K3 rows carry the page's two write prices; K2 writes are ordinary input", () => {
    expect(moonshot.models["kimi-k3.1-pro"]).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2, cacheWrite1h: 4 });
    expect(moonshot.models["kimi-k3.1-pro-highspeed"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 4, cacheWrite1h: 8 });
    expect(moonshot.models["kimi-k3"]).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3, cacheWrite1h: 6 });
    for (const id of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]) {
      const row = moonshot.models[id]!;
      expect(row.cacheWrite5m).toBe(row.input);
      expect(row.cacheWrite1h).toBe(row.input);
    }
  });

  test("Ollama Cloud's tag for Kimi K3.1 Pro is priced at the Kimi API's rates, whatever the hour", () => {
    expect(moonshot.models["kimi-k3.1-pro:cloud"]).toEqual(moonshot.models["kimi-k3.1-pro"]!);
    const tables = embeddedPriceTables();
    const r = priceTokens("kimi-k3.1-pro:cloud", million, tables, { at: "2026-11-14T20:00:00Z" });
    expect(r).toMatchObject({ priced: true, key: "kimi-k3.1-pro:cloud", offPeak: false });
    expect(r.cost.total).toBeCloseTo(2 + 10 + 0.2, 10);
    expect(findPrice("kimi-k3:cloud", tables)).toBeUndefined();
  });
});
