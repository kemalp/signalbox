import { describe, expect, test } from "bun:test";
import {
  buildHistory,
  buildReport,
  chooseTitle,
  DEFAULT_HISTORY_LIMIT,
  historyEntry,
  historySources,
  loadPriceTables,
  MAX_TITLE_CHARS,
  mergeAppSessions,
  projectOf,
  resumeCommand,
  sanitizeTitle,
  SPLIT_CONTINUATION_FLAG,
  type AppSessionRecord,
  type HistorySession,
  type LedgerEntry,
  type TokenCounts,
  type UsageRecord,
} from "../src/index.ts";

// Synthetic fixtures only.
const tables = loadPriceTables();
const NOW = new Date("2026-10-11T12:00:00Z");
const tok = (t: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });
const ch = (code: number) => String.fromCodePoint(code);

let seq = 0;
function rec(over: Partial<Omit<UsageRecord, "tokens">> & { tokens?: Partial<TokenCounts> } = {}): UsageRecord {
  const { tokens, ...rest } = over;
  return {
    agent: "claude-code",
    id: `msg_${++seq}`,
    keyQuality: "id",
    sessionId: "s1",
    project: "/work/alpha",
    kind: "main",
    model: "claude-opus-5-5",
    ts: "2026-10-05T12:00:00Z",
    outputFinal: true,
    webSearchRequests: 0,
    ...rest,
    tokens: tok(tokens ?? {}),
  };
}

function session(over: Partial<HistorySession> = {}): HistorySession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    titleSource: "none",
    startedAt: "2026-10-05T11:00:00.000Z",
    lastActivityAt: "2026-10-05T13:00:00.000Z",
    records: [],
    compactions: 0,
    subagentFiles: 0,
    workflowRuns: 0,
    ...over,
  };
}

describe("sanitizeTitle", () => {
  test("one line, no control or bidi characters, collapsed whitespace", () => {
    expect(sanitizeTitle("  Fix the\nlogin\tbug \r\n ")).toBe("Fix the login bug");
    expect(sanitizeTitle(`a${ch(0)}b${ch(27)}[31mc${ch(0x7f)}d${ch(0x9b)}e`)).toBe("ab[31mcde");
    expect(sanitizeTitle(`safe${ch(0x202e)}txt.exe${ch(0x2066)}${ch(0x200f)}`)).toBe("safetxt.exe");
    expect(sanitizeTitle(`line${ch(0x2028)}two${ch(0x2029)}three`)).toBe("line two three");
  });

  test("caps at 120 characters by code point, ending in an ellipsis", () => {
    const long = "word ".repeat(100);
    const out = sanitizeTitle(long)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(out.endsWith("…")).toBe(true);
    const emoji = ch(0x1f600).repeat(200);
    const cut = sanitizeTitle(emoji)!;
    expect(Array.from(cut).length).toBe(MAX_TITLE_CHARS);
    // No half surrogate pair survives the cut.
    expect(Array.from(cut).slice(0, -1).every((c) => c === ch(0x1f600))).toBe(true);
    expect(sanitizeTitle("x".repeat(MAX_TITLE_CHARS))).toBe("x".repeat(MAX_TITLE_CHARS));
    expect(sanitizeTitle("abcdef", 4)).toBe("abc…");
  });

  test("empty, blank and non-strings are no title", () => {
    for (const bad of ["", "   ", `${ch(0)}${ch(27)}`, "\n\t", undefined, null, 42, { title: "x" }, ["x"]]) expect(sanitizeTitle(bad)).toBeUndefined();
  });
});

describe("chooseTitle", () => {
  test("custom > ai > agent-name > index > none, skipping blank candidates", () => {
    expect(chooseTitle({ custom: "Mine", ai: "Generated", agentName: "agent", index: "idx" })).toEqual({ title: "Mine", titleSource: "custom" });
    expect(chooseTitle({ custom: "  ", ai: "Generated", agentName: "agent" })).toEqual({ title: "Generated", titleSource: "ai" });
    expect(chooseTitle({ agentName: "agent", index: "idx" })).toEqual({ title: "agent", titleSource: "agent-name" });
    expect(chooseTitle({ index: "Codex name" })).toEqual({ title: "Codex name", titleSource: "index" });
    expect(chooseTitle({})).toEqual({ titleSource: "none" });
  });
});

describe("resumeCommand", () => {
  test("only for shell-safe ids", () => {
    expect(resumeCommand("claude --resume", "11111111-1111-4111-8111-111111111111", "/work/a")).toEqual({
      command: "claude --resume 11111111-1111-4111-8111-111111111111",
      cwd: "/work/a",
    });
    expect(resumeCommand("codex resume", "01a10000-0000-7000-8000-00000000000a")).toEqual({ command: "codex resume 01a10000-0000-7000-8000-00000000000a" });
    for (const bad of ["x; rm -rf ~", "$(id)", "-rf", "a b", "", "a\nb", "x".repeat(200)]) expect(resumeCommand("claude --resume", bad)).toBeUndefined();
  });
});

describe("projectOf", () => {
  test("the earliest main-thread record's cwd, else the earliest record's", () => {
    expect(projectOf([rec({ project: "/late", ts: "2026-10-05T13:00:00Z" }), rec({ project: "/early", ts: "2026-10-05T12:00:00Z" })])).toBe("/early");
    expect(projectOf([rec({ kind: "subagent", project: "/sub", ts: "2026-10-05T10:00:00Z" }), rec({ project: "/main", ts: "2026-10-05T12:00:00Z" })])).toBe("/main");
    expect(projectOf([rec({ kind: "workflow", project: "/wf" })])).toBe("/wf");
    expect(projectOf([])).toBeUndefined();
  });
});

describe("historyEntry", () => {
  test("prices like the report: same transcript $ and ledger $ as reconciliation", () => {
    const records = [
      rec({ tokens: { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite1h: 3000 } }),
      rec({ model: "claude-sonnet-5-5", kind: "subagent", tokens: { input: 500, output: 100, cacheWrite5m: 800 } }),
      rec({ model: "claude-opus-5-5", outputFinal: false, tokens: { output: 10 } }),
      rec({ model: "claude-experimental-x", tokens: { input: 7, output: 3 } }),
      // The second record of a split response: its tokens count, it is not another response.
      rec({ id: "msg_split#iter1", flags: ["iteration-split", SPLIT_CONTINUATION_FLAG], tokens: { output: 5 } }),
    ];
    const ledger: LedgerEntry[] = [
      { agent: "claude-code", sessionId: "s1", model: "claude-opus-5-5", tokens: tok({ input: 900, output: 1500, cacheRead: 40_000, cacheWrite1h: 2500 }), costUsd: 0.1, source: "cost-state", observedAt: "2026-10-05T12:00:00Z" },
      { agent: "claude-code", sessionId: "s1", model: "claude-opus-5-5", tokens: tok({ input: 1000, output: 2100, cacheRead: 50_000, cacheWrite1h: 3000 }), costUsd: 0.2, source: "cost-state", observedAt: "2026-10-05T13:00:00Z" },
      { agent: "claude-code", sessionId: "s1", model: "claude-sonnet-5-5", tokens: tok({ input: 500, output: 100, cacheWrite5m: 800 }), costUsd: 0.01, source: "cost-state" },
    ];
    const e = historyEntry(session({ records, ledger }), tables, false);
    const report = buildReport({ records, ledger, tables, since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z", timeZone: "UTC", now: NOW });
    const row = report.reconciliation.find((r) => r.sessionId === "s1")!;
    expect(e.costUsd).toBeCloseTo(row.transcriptUsd, 12);
    expect(e.ledgerUsd).toBeCloseTo(row.ledgerUsd!, 12);
    expect(e.costUsd).toBeCloseTo(report.totals.cost.total, 12);
    expect(e.responses).toBe(4);
    expect(e.placeholderShare).toBe(0.25);
    expect(e.unpricedTokens).toBe(10);
    expect(e.tokens).toEqual(report.totals.tokens);
    expect(e.models[0]).toBe("claude-opus-5-5");
    expect(e.models.at(-1)).toBe("claude-experimental-x");
    expect(e.durationMs).toBe(2 * 3_600_000);
    expect(e.project).toBe("/work/alpha");
  });

  test("no records: zero counts, no ledger figure, no title", () => {
    const e = historyEntry(session(), tables, true);
    expect(e).toMatchObject({ responses: 0, costUsd: 0, unpricedTokens: 0, placeholderShare: 0, models: [], live: true, titleSource: "none", hasTranscript: true });
    expect(e.ledgerUsd).toBeUndefined();
    expect(e.title).toBeUndefined();
    expect(e.project).toBeUndefined();
  });
});

describe("buildHistory", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();

  test("newest activity first, with live flags from busy, waiting and idle fleet sessions", () => {
    const sessions = [
      session({ sessionId: "old", startedAt: at(1), lastActivityAt: at(2) }),
      session({ sessionId: "new", startedAt: at(3), lastActivityAt: at(9), title: "New one", titleSource: "custom" }),
      session({ sessionId: "mid", startedAt: at(4), lastActivityAt: at(5) }),
      session({ agent: "codex", sessionId: "cx", startedAt: at(6), lastActivityAt: at(7) }),
      session({ sessionId: "ended", startedAt: at(0), lastActivityAt: at(1) }),
    ];
    const live = [
      { agent: "claude-code", sessionId: "new", status: "busy" as const },
      { agent: "claude-code", sessionId: "mid", status: "idle" as const },
      { agent: "codex", sessionId: "cx", status: "waiting" as const },
      { agent: "claude-code", sessionId: "ended", status: "ended" as const },
      // Same id, other agent: not live.
      { agent: "codex", sessionId: "old", status: "busy" as const },
    ];
    const h = buildHistory({ sessions, tables, live, now: NOW });
    expect(h).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), total: 5, truncated: false });
    expect(h.entries.map((e) => [e.sessionId, e.live])).toEqual([
      ["new", true],
      ["cx", true],
      ["mid", true],
      ["old", false],
      ["ended", false],
    ]);
    expect(h.entries[0]).toMatchObject({ title: "New one", titleSource: "custom" });
  });

  test("limit, total and truncated; since and until filter whole sessions", () => {
    const sessions = Array.from({ length: 7 }, (_, i) => session({ sessionId: `s${i}`, startedAt: at(i), lastActivityAt: at(i + 1) }));
    const h = buildHistory({ sessions, tables, limit: 3 });
    expect(h.entries.map((e) => e.sessionId)).toEqual(["s6", "s5", "s4"]);
    expect(h).toMatchObject({ total: 7, truncated: true });
    // Active at or after 05:00 (s4 ends exactly then), started before 06:00.
    const w = buildHistory({ sessions, tables, since: new Date(at(5)), until: new Date(at(6)) });
    expect(w.entries.map((e) => e.sessionId)).toEqual(["s5", "s4"]);
    expect(w).toMatchObject({ total: 2, truncated: false });
    expect(buildHistory({ sessions: [], tables }).entries).toEqual([]);
    expect(DEFAULT_HISTORY_LIMIT).toBe(500);
    expect(buildHistory({ sessions, tables }).entries).toHaveLength(7);
  });

  test("ties sort by session id; a duplicate session keeps its latest copy; bad timestamps are dropped", () => {
    const sessions = [
      session({ sessionId: "b", lastActivityAt: at(5) }),
      session({ sessionId: "a", lastActivityAt: at(5) }),
      session({ sessionId: "a", lastActivityAt: at(3), title: "stale copy", titleSource: "custom" }),
      session({ sessionId: "x", lastActivityAt: "not a date" }),
    ];
    const h = buildHistory({ sessions, tables });
    expect(h.entries.map((e) => e.sessionId)).toEqual(["a", "b"]);
    expect(h.entries[0]!.title).toBeUndefined();
  });

  test("only the listed entries are priced, so a big history stays cheap", () => {
    const reads = { keep: 0, drop: 0 };
    const watched = (name: keyof typeof reads) =>
      new Proxy([rec()], {
        get(target, prop, receiver) {
          if (prop === Symbol.iterator) reads[name]++;
          return Reflect.get(target, prop, receiver);
        },
      });
    const sessions = [
      session({ sessionId: "keep", lastActivityAt: at(9), records: watched("keep") }),
      session({ sessionId: "drop", lastActivityAt: at(1), records: watched("drop") }),
    ];
    buildHistory({ sessions, tables, limit: 1 });
    expect(reads.keep).toBeGreaterThan(0);
    expect(reads.drop).toBe(0);
  });
});

describe("mergeAppSessions (the Claude app's session list)", () => {
  const T = (h: number) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();
  const app = (over: Partial<AppSessionRecord> = {}): AppSessionRecord => ({ agent: "claude-code", appSessionId: "local_1", ...over });
  const transcript = session({
    sessionId: "cli-1",
    title: "Transcript title",
    titleSource: "ai",
    project: "/work/alpha",
    startedAt: T(2),
    lastActivityAt: T(5),
    records: [rec({ sessionId: "cli-1", ts: T(3), tokens: { input: 1_000_000 } })],
    compactions: 1,
    subagentFiles: 2,
    workflowRuns: 0,
    resume: { command: "claude --resume cli-1", cwd: "/work/alpha" },
    transcriptPath: "/home/.claude/projects/-work-alpha/cli-1.jsonl",
  });

  test("a linked record joins its transcript: the app's title wins, earliest start and latest activity, archived from the app", () => {
    const [m, ...rest] = mergeAppSessions(
      [transcript],
      [app({ agentSessionId: "cli-1", title: "App title", titleSource: "auto", createdAt: T(1), lastActivityAt: T(4), archived: true, effort: "high", model: "claude-opus-5-5" })],
    );
    expect(rest).toEqual([]);
    expect(m).toMatchObject({
      sessionId: "cli-1",
      title: "App title",
      titleSource: "app",
      appTitleSource: "auto",
      startedAt: T(1), // the app's created time is earlier
      lastActivityAt: T(5), // the transcript's last line is later
      appSessionId: "local_1",
      archived: true,
      effort: "high",
      project: "/work/alpha",
    });
    const e = historyEntry(m!, tables, false);
    expect(e).toMatchObject({ hasTranscript: true, title: "App title", titleSource: "app", appTitleSource: "auto", archived: true, appSessionId: "local_1", responses: 1, compactions: 1 });
    expect(e.costUsd).toBeGreaterThan(0);
    expect(e.resume).toEqual({ command: "claude --resume cli-1", cwd: "/work/alpha" });
    // The transcript's own span (02:00 to 05:00), not the widened 01:00 start.
    expect(e.durationMs).toBe(3 * 3_600_000);
    // The input is not changed.
    expect(transcript).toMatchObject({ title: "Transcript title", titleSource: "ai", startedAt: T(2) });
    expect(transcript.appSessionId).toBeUndefined();
  });

  test("a later app activity moves lastActivityAt; an app record without a title keeps the transcript's", () => {
    const [m] = mergeAppSessions([transcript], [app({ agentSessionId: "cli-1", createdAt: T(3), lastActivityAt: T(8), archived: false })]);
    expect(m).toMatchObject({ title: "Transcript title", titleSource: "ai", startedAt: T(2), lastActivityAt: T(8), archived: false });
    expect(m!.appTitleSource).toBeUndefined();
  });

  test("the duration is the transcript's own span, however much later the app's last activity is", () => {
    const t = (iso: string) => new Date(iso).toISOString();
    const half = session({ sessionId: "cli-d", startedAt: t("2026-10-10T10:00:00Z"), lastActivityAt: t("2026-10-10T10:30:00Z"), records: [rec({ sessionId: "cli-d", ts: t("2026-10-10T10:10:00Z") })] });
    const [m] = mergeAppSessions([half], [app({ agentSessionId: "cli-d", createdAt: t("2026-10-10T09:59:00Z"), lastActivityAt: t("2026-10-12T10:30:00Z") })]);
    // Ordering and grouping use the widened times …
    expect(m).toMatchObject({ startedAt: t("2026-10-10T09:59:00Z"), lastActivityAt: t("2026-10-12T10:30:00Z") });
    expect(m).toMatchObject({ transcriptStartedAt: t("2026-10-10T10:00:00Z"), transcriptLastAt: t("2026-10-10T10:30:00Z") });
    const e = historyEntry(m!, tables, false);
    expect(e.lastActivityAt).toBe(t("2026-10-12T10:30:00Z"));
    // … the duration does not: 30 minutes, not 48.5 hours.
    expect(e.durationMs).toBe(30 * 60_000);
    // Only the entry's documented fields reach the output.
    expect("transcriptStartedAt" in e).toBe(false);
    expect("transcriptLastAt" in e).toBe(false);
    // A transcript session no app lists measures startedAt to lastActivityAt, as before.
    expect(historyEntry(half, tables, false).durationMs).toBe(30 * 60_000);
  });

  test("a record that says transcriptUnavailable still joins a transcript that is on this Mac", () => {
    const merged = mergeAppSessions([transcript], [app({ agentSessionId: "cli-1", title: "App title", transcriptUnavailable: true, lastActivityAt: T(4) })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ sessionId: "cli-1", title: "App title", titleSource: "app", appSessionId: "local_1" });
    const e = historyEntry(merged[0]!, tables, false);
    expect(e).toMatchObject({ hasTranscript: true, responses: 1 });
    expect(e.resume).toBeDefined();
    // Without the transcript it is app-only, like any unmatched record.
    const [alone] = mergeAppSessions([], [app({ agentSessionId: "cli-1", title: "App title", transcriptUnavailable: true, lastActivityAt: T(4) })]);
    expect(alone).toMatchObject({ sessionId: "cli-1", hasTranscript: false, records: [] });
  });

  test("app-only sessions: no transcript, no figures (undefined, never 0), no resume", () => {
    const merged = mergeAppSessions(
      [transcript],
      [
        app({ appSessionId: "local_gone", agentSessionId: "cli-gone", title: "Transcript deleted", createdAt: T(1), lastActivityAt: T(2), cwd: "/work/beta", model: "claude-fable-5", effort: "xhigh", archived: false }),
        app({ appSessionId: "local_nocli", title: "Never linked", lastActivityAt: T(6), originCwd: "/work/gamma", archived: true, transcriptUnavailable: true }),
        app({ appSessionId: "local_notime", agentSessionId: "cli-notime", title: "No time" }),
      ],
    );
    expect(merged.map((s) => s.sessionId)).toEqual(["cli-1", "cli-gone", "local_nocli"]);
    const gone = historyEntry(merged[1]!, tables, false);
    expect(gone).toMatchObject({
      agent: "claude-code",
      sessionId: "cli-gone",
      appSessionId: "local_gone",
      hasTranscript: false,
      title: "Transcript deleted",
      titleSource: "app",
      project: "/work/beta",
      models: ["claude-fable-5"],
      effort: "xhigh",
      archived: false,
      startedAt: T(1),
      lastActivityAt: T(2),
      durationMs: 3_600_000,
    });
    for (const k of ["responses", "tokens", "costUsd", "unpricedTokens", "placeholderShare", "ledgerUsd", "compactions", "subagentFiles", "workflowRuns", "resume", "transcriptPath"] as const) {
      expect(gone[k]).toBeUndefined();
    }
    const nocli = historyEntry(merged[2]!, tables, false);
    expect(nocli).toMatchObject({ sessionId: "local_nocli", hasTranscript: false, project: "/work/gamma", archived: true, startedAt: T(6), lastActivityAt: T(6), models: [] });
  });

  test("a session the app lists twice counts once, with its latest record", () => {
    const merged = mergeAppSessions(
      [transcript],
      [app({ appSessionId: "local_old", agentSessionId: "cli-1", title: "Old", lastActivityAt: T(3) }), app({ appSessionId: "local_new", agentSessionId: "cli-1", title: "New", lastActivityAt: T(4) })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ appSessionId: "local_new", title: "New" });
  });

  test("buildHistory: app-only entries are listed and live when in the fleet; sources count what matched", () => {
    const sessions = mergeAppSessions(
      [transcript, session({ sessionId: "cli-2", startedAt: T(0), lastActivityAt: T(1) })],
      [
        app({ appSessionId: "local_a", agentSessionId: "cli-1", title: "App title", archived: true, lastActivityAt: T(4) }),
        app({ appSessionId: "local_b", agentSessionId: "cli-run", title: "Running, no transcript yet", createdAt: T(9), lastActivityAt: T(10) }),
        app({ appSessionId: "local_c", title: "Old app-only", archived: true, createdAt: T(0), lastActivityAt: T(0) }),
      ],
    );
    const h = buildHistory({ sessions, tables, live: [{ agent: "claude-code", sessionId: "cli-run", status: "busy" }], claudeApp: { enabled: true, records: 3 } });
    expect(h.entries.map((e) => [e.sessionId, e.hasTranscript, e.live])).toEqual([
      ["cli-run", false, true],
      ["cli-1", true, false],
      ["cli-2", true, false],
      ["local_c", false, false],
    ]);
    expect(h.sources).toEqual({ transcripts: 2, claudeApp: { enabled: true, records: 3, merged: 1, appOnly: 2, archived: 2 } });
    // Counts follow the window: since 01:00 drops local_c.
    const w = buildHistory({ sessions, tables, since: new Date(T(1)), claudeApp: { enabled: true, records: 3 } });
    expect(w.sources).toEqual({ transcripts: 2, claudeApp: { enabled: true, records: 3, merged: 1, appOnly: 1, archived: 1 } });
    // Without the app's list, only transcripts are counted and claudeApp says whether the reader was off.
    expect(buildHistory({ sessions: [transcript], tables }).sources).toEqual({ transcripts: 1 });
    expect(buildHistory({ sessions: [transcript], tables, claudeApp: { enabled: false, records: 0 } }).sources).toEqual({
      transcripts: 1,
      claudeApp: { enabled: false, records: 0, merged: 0, appOnly: 0, archived: 0 },
    });
    // Why it was off, when it was.
    expect(buildHistory({ sessions: [transcript], tables, claudeApp: { enabled: false, records: 0, off: "claude-config-dir" } }).sources?.claudeApp).toEqual({
      enabled: false,
      records: 0,
      merged: 0,
      appOnly: 0,
      archived: 0,
      off: "claude-config-dir",
    });
    expect(buildHistory({ sessions: [transcript], tables, claudeApp: { enabled: true, records: 0, off: "flag" } }).sources?.claudeApp?.off).toBeUndefined();
  });

  test("a duplicate key keeps the copy with a transcript over an app-only one", () => {
    const appOnly = session({ sessionId: "cli-1", hasTranscript: false, lastActivityAt: T(9), appSessionId: "local_x" });
    const h = buildHistory({ sessions: [appOnly, transcript], tables });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]!.hasTranscript).toBe(true);
    expect(historySources([appOnly]).transcripts).toBe(0);
  });
});
