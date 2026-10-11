import { describe, expect, test } from "bun:test";
import { calendarSince, helpText, parseArgs, parseDateArg, reportWindow, reportWindowLabel, UsageError, type ReportArgs } from "../src/args.ts";

const AGENTS = ["claude-code", "codex"];
const parse = (s: string) => parseArgs(s ? s.split(" ") : [], AGENTS);

describe("parseArgs", () => {
  test("report defaults to 7 calendar days, text output", () => {
    expect(parse("report")).toEqual({ command: "report", days: 7, json: false, verbose: false });
  });

  test("report --rolling keeps the N x 24h window, with or without --days", () => {
    expect(parse("report --days 30 --rolling")).toEqual({ command: "report", days: 30, rolling: true, json: false, verbose: false });
    expect(parse("report --rolling")).toEqual({ command: "report", days: 7, rolling: true, json: false, verbose: false });
    expect(() => parse("report --rolling --since 2026-10-01")).toThrow("--rolling applies to --days");
    expect(() => parse("report --rolling=yes")).toThrow(UsageError);
  });

  test("report flags, both --flag value and --flag=value", () => {
    expect(parse("report --days 30 --agent codex --json")).toEqual({ command: "report", days: 30, agent: "codex", json: true, verbose: false });
    expect(parse("report --verbose")).toEqual({ command: "report", days: 7, json: false, verbose: true });
    expect(parse("report --days=2")).toMatchObject({ days: 2 });
    const r = parse("report --since 2026-10-01 --until 2026-10-08T12:00:00Z");
    expect(r).toMatchObject({ command: "report", json: false, verbose: false });
    if (r.command !== "report") throw new Error("unreachable");
    expect(r.days).toBeUndefined();
    expect(r.since).toEqual(new Date(2026, 9, 1));
    expect(r.until?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  test("report rejects bad input with a UsageError", () => {
    for (const bad of [
      "report --days 0",
      "report --days 1.5",
      "report --days abc",
      "report --days",
      "report --days 7 --since 2026-10-01",
      "report --agent gemini-cli",
      "report --json=yes",
      "report --verbose=yes",
      "report extra",
      "report --since 2026-02-30",
      "report --since yesterday",
      "report --days 7 --days 8",
    ]) {
      expect(() => parse(bad), bad).toThrow(UsageError);
    }
  });

  test("doctor, serve, help, version", () => {
    expect(parse("doctor")).toEqual({ command: "doctor", json: false });
    expect(parse("doctor --json")).toEqual({ command: "doctor", json: true });
    expect(parse("serve")).toEqual({ command: "serve", port: 0, open: true });
    expect(parse("serve --port 8787 --no-open")).toEqual({ command: "serve", port: 8787, open: false });
    expect(() => parse("serve --port 70000")).toThrow(UsageError);
    expect(parse("")).toEqual({ command: "help" });
    expect(parse("--help")).toEqual({ command: "help" });
    expect(parse("report --help")).toEqual({ command: "help", topic: "report" });
    expect(parse("--version")).toEqual({ command: "version" });
    expect(() => parse("frobnicate")).toThrow(/unknown command/);
  });

  test("watch, snapshot and fleet need their format flag; days are calendar days 1-365", () => {
    expect(parse("watch --ndjson")).toEqual({ command: "watch", days: 7, claudeApp: true });
    expect(parse("watch --ndjson --days 365")).toEqual({ command: "watch", days: 365, claudeApp: true });
    expect(parse("snapshot --json --days=1")).toEqual({ command: "snapshot", days: 1, claudeApp: true });
    expect(parse("watch --ndjson --no-claude-app")).toEqual({ command: "watch", days: 7, claudeApp: false });
    expect(parse("snapshot --json --no-claude-app")).toEqual({ command: "snapshot", days: 7, claudeApp: false });
    expect(() => parse("watch --ndjson --no-claude-app=1")).toThrow(UsageError);
    expect(() => parse("fleet --json --no-claude-app")).toThrow(UsageError);
    expect(parse("fleet --json")).toEqual({ command: "fleet" });
    for (const bad of ["watch", "watch --json", "watch --ndjson --days 366", "watch --ndjson --days 0", "snapshot", "snapshot --json --days 400", "fleet", "fleet --json --days 3"]) {
      expect(() => parse(bad)).toThrow(UsageError);
    }
    expect(parse("watch --help")).toEqual({ command: "help", topic: "watch" });
  });

  test("history defaults to every session, newest 500, text output", () => {
    expect(parse("history")).toEqual({ command: "history", json: false, limit: 500, claudeApp: true });
    expect(parse("history --all --json")).toEqual({ command: "history", json: true, limit: 500, claudeApp: true });
    expect(parse("history --days 30 --agent codex --limit=20")).toEqual({ command: "history", json: false, days: 30, agent: "codex", limit: 20, claudeApp: true });
    expect(parse("history --json --no-claude-app")).toEqual({ command: "history", json: true, limit: 500, claudeApp: false });
    for (const bad of ["history --days 7 --all", "history --limit 0", "history --limit many", "history --agent gemini", "history --days 0", "history --verbose", "history --all=yes"]) {
      expect(() => parse(bad)).toThrow(UsageError);
    }
    expect(helpText(AGENTS)).toContain("signalbox history [--days N | --all] [--agent ID] [--limit N] [--no-claude-app] [--json]");
  });

  test("help lists the registered agents and says what --days means", () => {
    expect(helpText(AGENTS)).toContain("claude-code, codex");
    expect(helpText(AGENTS)).toContain("not a bill");
    expect(helpText(AGENTS)).toContain("N calendar days");
    expect(helpText(AGENTS)).toContain("--rolling");
  });
});

describe("windows", () => {
  const now = new Date("2026-10-09T12:34:56.000Z");

  const report = (a: Partial<ReportArgs>): ReportArgs => ({ command: "report", json: false, verbose: false, ...a });

  test("--days N is N calendar days: today since local midnight and the N-1 days before it", () => {
    const local = new Date(2026, 9, 9, 15, 30);
    expect(reportWindow(report({ days: 7 }), local)).toEqual({ since: new Date(2026, 9, 3), until: local });
    expect(reportWindow(report({ days: 1 }), local)).toEqual({ since: new Date(2026, 9, 9), until: local });
    // The same start as watch, snapshot and the web page.
    expect(reportWindow(report({ days: 30 }), local).since).toEqual(calendarSince(30, local));
  });

  test("--days with --until: the N days ending with --until's day, or before it when --until is midnight", () => {
    const midnight = new Date(2026, 9, 8);
    expect(reportWindow(report({ days: 7, until: midnight }), now)).toEqual({ since: new Date(2026, 9, 1), until: midnight });
    const afternoon = new Date(2026, 9, 8, 13, 0);
    expect(reportWindow(report({ days: 2, until: afternoon }), now)).toEqual({ since: new Date(2026, 9, 7), until: afternoon });
  });

  test("--days N --rolling is N x 24h ending now, like cc_cost.py", () => {
    const w = reportWindow(report({ days: 7, rolling: true }), now);
    expect(w.until).toEqual(now);
    expect(w.since.toISOString()).toBe("2026-10-02T12:34:56.000Z");
  });

  test("the text report names the window", () => {
    expect(reportWindowLabel(report({ days: 7 }))).toBe("7 calendar days");
    expect(reportWindowLabel(report({ days: 1 }))).toBe("today");
    expect(reportWindowLabel(report({ days: 1, until: new Date(2026, 9, 8) }))).toBe("1 calendar day");
    expect(reportWindowLabel(report({ days: 7, rolling: true }))).toBe("rolling 7 x 24h");
    expect(reportWindowLabel(report({ since: new Date(2026, 9, 1) }))).toBeUndefined();
  });

  test("--since/--until are used as given; an empty window is an error", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-10-05T00:00:00Z");
    expect(reportWindow({ command: "report", since, until, json: false, verbose: false }, now)).toEqual({ since, until });
    expect(() => reportWindow({ command: "report", since: until, until: since, json: false, verbose: false }, now)).toThrow(UsageError);
  });

  test("a future --since without --until says so; windows are capped like --days", () => {
    const future = new Date("2027-01-01T00:00:00Z");
    expect(() => reportWindow({ command: "report", since: future, json: false, verbose: false }, now)).toThrow("--since is in the future");
    expect(() => reportWindow({ command: "report", since: future, until: new Date("2026-12-01T00:00:00Z"), json: false, verbose: false }, now)).toThrow(
      "--since must be before --until",
    );
    expect(() => reportWindow({ command: "report", since: new Date("1970-01-01T00:00:00Z"), json: false, verbose: false }, now)).toThrow("longer than 3650 days");
  });

  test("calendarSince is local midnight days-1 days back", () => {
    const local = new Date(2026, 9, 9, 15, 30);
    expect(calendarSince(1, local)).toEqual(new Date(2026, 9, 9));
    expect(calendarSince(7, local)).toEqual(new Date(2026, 9, 3));
    expect(calendarSince(30, local)).toEqual(new Date(2026, 8, 10));
  });

  test("parseDateArg", () => {
    expect(parseDateArg("2026-10-01", "--since")).toEqual(new Date(2026, 9, 1));
    expect(parseDateArg("2026-10-01T10:00:00+02:00", "--since").toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(() => parseDateArg("2026-13-01", "--since")).toThrow(UsageError);
    // Years 0-99 are real years, not 1900-1999.
    expect(parseDateArg("0001-01-01", "--since").getFullYear()).toBe(1);
  });
});
