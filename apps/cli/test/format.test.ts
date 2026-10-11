import { describe, expect, test } from "bun:test";
import { buildHistory, buildReport, loadPriceTables, type HistorySession, type TokenCounts, type UsageRecord } from "@signalbox/core";
import { clipPath, fmtDuration, fmtTokens, fmtUsd, formatHistory, formatReport, median, tildify, wrap } from "../src/format.ts";

const tables = loadPriceTables();
const tok = (t: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });
const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  agent: "claude-code",
  id: Math.random().toString(36).slice(2),
  keyQuality: "id",
  sessionId: "s1",
  project: "/home/test/alpha",
  kind: "main",
  model: "claude-opus-5-5",
  ts: "2026-10-05T12:00:00Z",
  tokens: tok({ input: 1_000_000, cacheRead: 9_000_000 }),
  outputFinal: true,
  webSearchRequests: 0,
  ...over,
});

describe("formatters", () => {
  test("numbers", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtTokens(1_880_000_000)).toBe("1.88B");
    expect(fmtTokens(45_500_000)).toBe("45.5M");
    expect(fmtTokens(18_800)).toBe("18.8K");
    expect(fmtTokens(12)).toBe("12");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(tildify("/home/test/alpha", "/home/test")).toBe("~/alpha");
    expect(tildify("/home/tester", "/home/test")).toBe("/home/tester");
  });

  test("wrap keeps every line within the width and indents continuations", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const out = wrap("  - ", text, 20).split("\n");
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(20);
    expect(out[0]!.startsWith("  - one")).toBe(true);
    expect(out[1]!.startsWith("    ")).toBe(true);
    expect(wrap("x: ", "", 20)).toBe("x: ");
  });
});

describe("formatReport", () => {
  test("prints totals, groups, notes and the not-a-bill label", () => {
    const r = buildReport({
      records: [
        rec({}),
        rec({ kind: "workflow", tokens: tok({ cacheWrite5m: 100_000, output: 8 }), outputFinal: false }),
        rec({ agent: "codex", sessionId: "c1", project: undefined, model: "codex-auto-review", kind: "auxiliary" }),
      ],
      tables,
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-08T00:00:00Z",
      timeZone: "UTC",
    });
    const text = formatReport(r, { width: 100, agentLabel: "all agents", verbose: true });
    expect(text).toContain("list-price equivalents, not a bill");
    expect(text).toContain("(7 days, local time)");
    expect(formatReport(r, { width: 100, windowLabel: "7 calendar days" })).toContain("(7 calendar days, local time)");
    expect(text).toMatch(/Recorded\s+\$\d/);
    expect(text).toContain("equals recorded");
    expect(text).toContain("By agent");
    expect(text).toContain("By model");
    expect(text).toContain("codex-auto-review");
    expect(text).toContain("unpriced");
    expect(text).toContain("By kind");
    expect(text).toContain("By project");
    expect(text).toContain("Notes");
    expect(text).toContain("Prices: anthropic as of");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("an empty range prints without dividing by zero", () => {
    const r = buildReport({ records: [], tables, since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", timeZone: "UTC" });
    const text = formatReport(r, { width: 80 });
    expect(text).toContain("cache hit -");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("By agent");
  });

  test("no detected agent prints 'no data' instead of $0.00", () => {
    const r = buildReport({ records: [], tables, since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", timeZone: "UTC" });
    r.notes.unshift("No agent data was found on this machine.");
    const text = formatReport(r, { width: 80, noData: true });
    expect(text).toMatch(/Recorded\s+no data/);
    expect(text).not.toContain("$0.00");
    expect(text).toContain("No agent data was found on this machine.");
  });

  test("whole-session k is labelled as such, not as the k the estimate uses", () => {
    const r = buildReport({
      records: [rec({ tokens: tok({ input: 1_000_000 }) })], // $4
      ledger: [{ agent: "claude-code", sessionId: "s1", model: "claude-opus-5-5", tokens: tok({ input: 1_250_000 }), costUsd: 5, source: "test" }],
      tables,
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-08T00:00:00Z",
      timeZone: "UTC",
    });
    const text = formatReport(r, { width: 140, verbose: true });
    expect(text).toContain("Session k     median 0.80 over 1 session (range 0.80 - 0.80; whole sessions, all models; the estimate uses per-model k)");
    expect(text).not.toContain("Ledger k");
  });

  test("the default view hides notes, the estimate method and session k, and says how to see them", () => {
    const r = buildReport({
      records: [
        rec({ tokens: tok({ input: 1_000_000 }) }),
        rec({ agent: "codex", sessionId: "c1", project: undefined, model: "codex-auto-review", kind: "auxiliary" }),
      ],
      ledger: [{ agent: "claude-code", sessionId: "s1", model: "claude-opus-5-5", tokens: tok({ input: 1_250_000 }), costUsd: 5, source: "test" }],
      tables,
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-08T00:00:00Z",
      timeZone: "UTC",
    });
    expect(r.notes.length).toBeGreaterThan(0);
    const text = formatReport(r, { width: 80 });
    expect(text).not.toContain("Notes");
    expect(text).not.toContain("Estimate method:");
    expect(text).not.toContain("Session k");
    expect(text).toMatch(/Unpriced\s+.*codex-auto-review/);
    expect(text).toContain("More: --verbose shows");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    const verbose = formatReport(r, { width: 80, verbose: true });
    expect(verbose).toContain("Notes");
    expect(verbose).toContain("Estimate method:");
    expect(verbose).not.toContain("More: --verbose");
  });
});

describe("clipPath", () => {
  test("keeps the root and the last folder", () => {
    expect(clipPath("~/Projects/sample-web-app", 22)).toBe("~/…/sample-web-app");
    expect(clipPath("~/Projects/sample-web-app", 25)).toBe("~/Projects/sample-web-app");
    expect(clipPath("/Volumes/Backup/work/app", 15)).toBe("/…/work/app");
    expect(clipPath("/Volumes/Backup/work/app", 10)).toBe("/…/app");
    expect(clipPath("a/b/c/deep", 8)).toBe("…/c/deep");
    expect(clipPath("a/b/c/deep", 7)).toBe("…/deep");
  });

  test("falls back to clipping the folder name when even that does not fit", () => {
    expect(clipPath("~/x/a-very-long-folder-name", 10)).toBe("…lder-name");
    expect(clipPath("~/x/a-very-long-folder-name", 10).length).toBe(10);
  });
});

describe("formatHistory", () => {
  const session = (over: Partial<HistorySession>): HistorySession => ({
    agent: "claude-code",
    sessionId: "s1",
    titleSource: "none",
    startedAt: "2026-10-05T10:00:00.000Z",
    lastActivityAt: "2026-10-05T12:14:00.000Z",
    records: [],
    compactions: 0,
    subagentFiles: 0,
    workflowRuns: 0,
    ...over,
  });

  test("durations", () => {
    expect(fmtDuration(0)).toBe("<1m");
    expect(fmtDuration(45 * 60_000)).toBe("45m");
    expect(fmtDuration(134 * 60_000)).toBe("2h 14m");
    expect(fmtDuration(76 * 3_600_000)).toBe("3d 4h");
  });

  test("one row per session: title or Untitled, project folder, duration, $, live and unpriced marks", () => {
    const h = buildHistory({
      sessions: [
        session({ sessionId: "a", title: "Ship the history list", titleSource: "custom", records: [rec({ sessionId: "a" })], project: "/home/test/alpha" }),
        session({ sessionId: "b", lastActivityAt: "2026-10-05T11:00:00.000Z", records: [rec({ sessionId: "b", model: "claude-experimental-x" })] }),
        session({ agent: "codex", sessionId: "c", lastActivityAt: "2026-10-05T09:00:00.000Z", startedAt: "2026-10-05T09:00:00.000Z", title: "x".repeat(300), titleSource: "index" }),
      ],
      tables,
      live: [{ agent: "claude-code", sessionId: "a", status: "busy" }],
      limit: 2,
    });
    const text = formatHistory(h, { width: 100 });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Signalbox history  all agents, every session (2 of 3 sessions)");
    const a = lines.find((l) => l.includes("Ship the history list"))!;
    expect(a).toContain("claude-code");
    expect(a).toContain("alpha");
    expect(a).toContain("2h 14m");
    expect(a).toContain("$");
    expect(a.trimEnd().endsWith("live")).toBe(true);
    const b = lines.find((l) => l.includes("Untitled"))!;
    expect(b).toContain("*");
    expect(text).toContain("Showing the newest 2 of 3 sessions; --limit N shows more.");
    expect(text).toContain("* includes tokens of a model with no list price");
    expect(text).toContain("not a bill");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(100);
  });

  test("long titles are clipped to the width; no data and empty windows say so", () => {
    const h = buildHistory({ sessions: [session({ title: "word ".repeat(40).trim(), titleSource: "custom" })], tables });
    for (const l of formatHistory(h, { width: 80 }).split("\n")) expect(l.length).toBeLessThanOrEqual(80);
    expect(formatHistory(h, { width: 80 })).toContain("…");
    const empty = buildHistory({ sessions: [], tables });
    expect(formatHistory(empty, { windowLabel: "today" })).toContain("No sessions in this window.");
    expect(formatHistory(empty, { noData: true })).toContain("unknown rather than empty");
  });
});
