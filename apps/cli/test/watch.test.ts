// `signalbox watch --ndjson`: the line splitter, command parsing and scheduler in-process, then the
// real CLI against synthetic agent homes. Synthetic data only; nothing outside the temp dir is read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterHealth, CommandsSnapshot, FleetSnapshot, HistorySnapshot, Report, SessionStatus } from "@signalbox/core";
import pkg from "../package.json" with { type: "json" };
import { calendarSince } from "../src/args.ts";
import type { FleetOptions, Freshness, ReportRequest } from "../src/data.ts";
import { debugEnabled, LineSplitter, MAX_COMMAND_CHARS, parseCommand, Watcher, type WatchLine, type WatchSource } from "../src/watch.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const REPO = join(import.meta.dir, "..", "..", "..");
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LineSplitter", () => {
  test("joins partial chunks, strips CR, keeps empty lines for the parser to skip", () => {
    const s = new LineSplitter();
    expect(s.push('{"cmd":"rep')).toEqual([]);
    expect(s.push('ort","days":30}\r\n{"cmd"')).toEqual(['{"cmd":"report","days":30}']);
    expect(s.push(':"refresh"}\n\n')).toEqual(['{"cmd":"refresh"}', ""]);
    expect(s.end()).toEqual([]);
  });

  test("a multi-byte character split across chunks survives", () => {
    const s = new LineSplitter();
    const bytes = enc.encode('{"cmd":"é"}\n');
    const cut = bytes.indexOf(0xc3) + 1;
    expect(s.push(bytes.slice(0, cut))).toEqual([]);
    expect(s.push(bytes.slice(cut))).toEqual(['{"cmd":"é"}']);
  });

  test("an unterminated last line is returned at end of input", () => {
    const s = new LineSplitter();
    s.push('{"cmd":"refresh"}');
    expect(s.end()).toEqual(['{"cmd":"refresh"}']);
  });

  test("an endless line is dropped once, up to the next newline", () => {
    const s = new LineSplitter(32);
    expect(s.push("x".repeat(20))).toEqual([]);
    expect(s.push("x".repeat(20))).toEqual([{ overflow: true }]);
    expect(s.push("x".repeat(100))).toEqual([]);
    expect(s.push('xx\n{"cmd":"refresh"}\n')).toEqual(['{"cmd":"refresh"}']);
    expect(s.push(`${"y".repeat(40)}\nok\n`)).toEqual([{ overflow: true }, "ok"]);
    expect(s.end()).toEqual([]);
  });
});

describe("debugEnabled", () => {
  test("reads the same off values as the macOS app", () => {
    expect(debugEnabled(undefined)).toBe(false);
    for (const off of ["", "0", "false", "OFF", "no", " 0 "]) expect(debugEnabled(off)).toBe(false);
    for (const on of ["1", "yes", "true", "verbose"]) expect(debugEnabled(on)).toBe(true);
  });
});

describe("parseCommand", () => {
  test("accepts the two commands and ignores unknown keys", () => {
    expect(parseCommand('{"cmd":"refresh","extra":1}')).toEqual({ cmd: "refresh" });
    expect(parseCommand(' {"cmd":"report","days":365} ')).toEqual({ cmd: "report", days: 365 });
    expect(parseCommand("   ")).toBeNull();
  });

  test("everything else is an error message, never a throw", () => {
    for (const bad of ["garbage", "[1]", "null", '"str"', '{"days":3}', '{"cmd":5}']) expect(parseCommand(bad)).toHaveProperty("error");
    for (const days of [0, 366, 2.5, "7", null]) expect(parseCommand(JSON.stringify({ cmd: "report", days }))).toHaveProperty("error");
    expect(parseCommand('{"cmd":"explode"}')).toEqual({ error: 'unknown command "explode"' });
  });
});

// ---------- Watcher with a fake source ----------

interface Call {
  kind: "fleet" | "report" | "health";
  fresh?: Freshness;
  since?: Date;
}

function fakeSource(opts: { delayMs?: number; failFleet?: () => boolean } = {}): WatchSource & { calls: Call[] } {
  const calls: Call[] = [];
  const later = async <T>(v: T) => {
    if (opts.delayMs) await sleep(opts.delayMs);
    return v;
  };
  return {
    calls,
    async fleet(fresh?: Freshness) {
      calls.push({ kind: "fleet", fresh });
      if (opts.failFleet?.()) throw new Error("fleet broke");
      return later({ generatedAt: new Date().toISOString(), sessions: [], limits: [], compactions: [], health: [] } as FleetSnapshot);
    },
    async report(req: ReportRequest, fresh?: Freshness) {
      calls.push({ kind: "report", fresh, since: req.since });
      return later({ range: { since: req.since.toISOString() } } as unknown as Report);
    },
    async health(fresh?: Freshness) {
      calls.push({ kind: "health", fresh });
      return later([{ name: "fake:source", stability: "internal", ok: true, detail: "synthetic" }] as AdapterHealth[]);
    },
  };
}

function watcherWith(source: WatchSource, extra: Partial<ConstructorParameters<typeof Watcher>[0]> = {}) {
  const lines: WatchLine[] = [];
  const w = new Watcher({ source, days: 7, version: "9.9.9", pid: 42, write: (l) => lines.push(JSON.parse(l)), ...extra });
  return { w, lines };
}

describe("Watcher", () => {
  test("hello first, then one fleet, report and health", async () => {
    const { w, lines } = watcherWith(fakeSource(), { intervals: { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6 } });
    w.start();
    await w.idle();
    w.stop();
    expect(lines[0]).toEqual({ type: "hello", v: 1, version: "9.9.9", pid: 42 });
    expect(lines.slice(1).map((l) => l.type).sort()).toEqual(["fleet", "health", "report"]);
    const report = lines.find((l) => l.type === "report")!;
    expect(report).toMatchObject({ days: 7 });
    expect(Date.parse((report as { at: string }).at)).not.toBeNaN();
  });

  test("ticks on its intervals; report and health ticks ask for fresh data", async () => {
    const src = fakeSource();
    const { w, lines } = watcherWith(src, { intervals: { fleetMs: 20, reportMs: 45, healthMs: 70, minFleetGapMs: 0 } });
    w.start();
    await sleep(160);
    w.stop();
    await w.idle();
    const count = (t: string) => lines.filter((l) => l.type === t).length;
    expect(count("fleet")).toBeGreaterThanOrEqual(5);
    expect(count("report")).toBeGreaterThanOrEqual(3);
    expect(count("health")).toBeGreaterThanOrEqual(2);
    expect(count("fleet")).toBeGreaterThan(count("report"));
    // Fleet ticks use the cache; report/health ticks after the first emission force a rescan.
    expect(src.calls.filter((c) => c.kind === "fleet").every((c) => c.fresh?.maxAgeMs === undefined)).toBe(true);
    expect(src.calls.filter((c) => c.kind === "report").slice(1).every((c) => c.fresh?.maxAgeMs === 0)).toBe(true);
  });

  test("a report command switches the window; a report finished for the old window is dropped", async () => {
    const src = fakeSource({ delayMs: 30 });
    const now = new Date(2026, 9, 9, 15, 0, 0);
    const { w, lines } = watcherWith(src, { intervals: { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6 }, now: () => now });
    w.start(); // 7-day report in flight
    w.handleLine('{"cmd":"report","days":30}');
    await w.idle();
    w.stop();
    const reports = lines.filter((l): l is Extract<WatchLine, { type: "report" }> => l.type === "report");
    expect(reports.map((r) => r.days)).toEqual([30]);
    expect(reports[0]!.data.range.since).toBe(calendarSince(30, now).toISOString());
    expect(w.currentDays).toBe(30);
  });

  test("refresh emits fleet + report with fresh data, and a second refresh while one runs is ignored", async () => {
    const src = fakeSource({ delayMs: 20 });
    const { w, lines } = watcherWith(src, { intervals: { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6 } });
    w.start();
    await w.idle();
    const before = lines.length;
    w.handleLine('{"cmd":"refresh"}');
    w.handleLine('{"cmd":"refresh"}');
    await w.idle();
    w.stop();
    const after = lines.slice(before).map((l) => l.type).sort();
    expect(after).toEqual(["fleet", "report"]);
    const forced = src.calls.slice(-2);
    expect(forced.every((c) => c.fresh?.maxAgeMs === 0)).toBe(true);
  });

  test("a refresh during a running fleet tick waits for it and fetches again", async () => {
    const src = fakeSource({ delayMs: 30 });
    const { w, lines } = watcherWith(src, { intervals: { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6 } });
    w.start(); // fleet in flight
    w.handleLine('{"cmd":"refresh"}');
    await w.idle();
    w.stop();
    expect(lines.filter((l) => l.type === "fleet")).toHaveLength(2);
    expect(src.calls.filter((c) => c.kind === "fleet").map((c) => c.fresh?.maxAgeMs)).toEqual([undefined, 0]);
  });

  test("failures become error lines and the stream keeps going", async () => {
    let fail = true;
    const src = fakeSource({ failFleet: () => fail });
    const { w, lines } = watcherWith(src, { intervals: { fleetMs: 15, reportMs: 1e6, healthMs: 1e6 } });
    w.start();
    await w.idle();
    expect(lines).toContainEqual(expect.objectContaining({ type: "error", scope: "fleet", message: "fleet broke" }));
    fail = false;
    await sleep(50);
    w.stop();
    await w.idle();
    expect(lines.some((l) => l.type === "fleet")).toBe(true);
  });

  test("bad stdin lines produce protocol errors", () => {
    const { w, lines } = watcherWith(fakeSource());
    w.handleLine("not json");
    w.handleLine('{"cmd":"bogus"}');
    w.handleLine({ overflow: true });
    w.handleLine("");
    expect(lines.map((l) => (l.type === "error" ? l.scope : l.type))).toEqual(["protocol", "protocol", "protocol"]);
    expect((lines[2] as { message: string }).message).toContain(String(MAX_COMMAND_CHARS));
  });

  test("nothing is written after stop()", async () => {
    const src = fakeSource({ delayMs: 20 });
    const { w, lines } = watcherWith(src);
    w.start();
    w.stop();
    await w.idle();
    expect(lines.map((l) => l.type)).toEqual(["hello"]);
  });
});

// ---------- The command guide line, with a fake source ----------

function guideSource(opts: { delayMs?: number; fail?: () => boolean } = {}) {
  const base = fakeSource();
  let built = 0;
  const source: WatchSource = {
    ...base,
    async commands() {
      built++;
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.fail?.()) throw new Error("guide broke");
      return { v: 1, generatedAt: new Date().toISOString(), installed: { "claude-code": "2.1.293" }, catalogs: [], custom: [] } satisfies CommandsSnapshot;
    },
  };
  return { source, built: () => built };
}

describe("Watcher commands line", () => {
  const QUIET_ALL = { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6, commandsMs: 1e6 };

  test("exactly one commands line after hello at start", async () => {
    const src = guideSource();
    const { w, lines } = watcherWith(src.source, { intervals: QUIET_ALL });
    w.start();
    await w.idle();
    w.stop();
    expect(lines[0]!.type).toBe("hello");
    const cmds = lines.filter((l): l is Extract<WatchLine, { type: "commands" }> => l.type === "commands");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.data).toMatchObject({ v: 1, installed: { "claude-code": "2.1.293" } });
    expect(Date.parse(cmds[0]!.at)).not.toBeNaN();
    expect(lines.map((l) => l.type).sort()).toEqual(["commands", "fleet", "health", "hello", "report"]);
  });

  test("a source without a command guide sends no commands line", async () => {
    const { w, lines } = watcherWith(fakeSource(), { intervals: QUIET_ALL });
    w.start();
    await w.idle();
    w.stop();
    expect(lines.some((l) => l.type === "commands")).toBe(false);
  });

  test("ticks on commandsMs", async () => {
    const src = guideSource();
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET_ALL, commandsMs: 30 } });
    w.start();
    await sleep(110);
    w.stop();
    await w.idle();
    expect(lines.filter((l) => l.type === "commands").length).toBeGreaterThanOrEqual(3);
  });

  test("refresh resends it only when the last one is older than commandsRefreshAgeMs", async () => {
    const src = guideSource();
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET_ALL, commandsRefreshAgeMs: 80 } });
    w.start();
    await w.idle();
    w.handleLine('{"cmd":"refresh"}');
    await w.idle();
    expect(lines.filter((l) => l.type === "commands")).toHaveLength(1);
    await sleep(100);
    w.handleLine('{"cmd":"refresh"}');
    await w.idle();
    w.stop();
    expect(lines.filter((l) => l.type === "commands")).toHaveLength(2);
    expect(src.built()).toBe(2);
  });

  test("a slow guide doesn't hold up the other lines, and a failure is an error line with scope commands", async () => {
    let fail = true;
    const src = guideSource({ delayMs: 40, fail: () => fail });
    const { w, lines } = watcherWith(src.source, { intervals: QUIET_ALL });
    w.start();
    await sleep(20);
    expect(lines.map((l) => l.type)).toContain("fleet");
    await w.idle();
    expect(lines).toContainEqual(expect.objectContaining({ type: "error", scope: "commands", message: "guide broke" }));
    fail = false;
    w.handleLine('{"cmd":"refresh"}'); // never sent one yet: a refresh retries it
    await w.idle();
    w.stop();
    expect(lines.filter((l) => l.type === "commands")).toHaveLength(1);
  });
});

// ---------- The history line, with a fake source ----------

type HistoryLine = Extract<WatchLine, { type: "history" }>;

/** A source whose fleet the test sets (sessions and statuses), with a history that counts its builds. */
function historySource(opts: { delayMs?: number; fail?: () => boolean } = {}) {
  let sessions: Array<{ id: string; status: SessionStatus }> = [{ id: "a", status: "busy" }];
  let built = 0;
  const calls: Array<Freshness | undefined> = [];
  const source: WatchSource = {
    async fleet() {
      return {
        generatedAt: new Date().toISOString(),
        sessions: sessions.map((x) => ({ agent: "claude-code", sessionId: x.id, status: x.status, source: "fake" })),
        limits: [],
        compactions: [],
        health: [],
      } as FleetSnapshot;
    },
    async report(req: ReportRequest) {
      return { range: { since: req.since.toISOString() } } as unknown as Report;
    },
    async health() {
      return [] as AdapterHealth[];
    },
    async history(fresh?: Freshness) {
      calls.push(fresh);
      const n = ++built;
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.fail?.()) throw new Error("history broke");
      return { v: 1, generatedAt: new Date().toISOString(), entries: [], total: n, truncated: false } satisfies HistorySnapshot;
    },
  };
  return { source, built: () => built, calls, set: (next: typeof sessions) => (sessions = next) };
}

describe("Watcher history line", () => {
  const QUIET_H = { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6, historyMs: 1e6, historyDebounceMs: 40, minFleetGapMs: 0 };

  test("exactly one history line at start, after hello and after the first fleet and report", async () => {
    const src = historySource();
    const { w, lines } = watcherWith(src.source, { intervals: QUIET_H });
    w.start();
    await w.idle();
    w.stop();
    const types = lines.map((l) => l.type);
    expect(types[0]).toBe("hello");
    expect(types.filter((t) => t === "history")).toHaveLength(1);
    expect(types.indexOf("history")).toBeGreaterThan(types.indexOf("fleet"));
    expect(types.indexOf("history")).toBeGreaterThan(types.indexOf("report"));
    const h = lines.find((l): l is HistoryLine => l.type === "history")!;
    expect(h.data).toMatchObject({ v: 1, entries: [], truncated: false });
    expect(Date.parse(h.at)).not.toBeNaN();
    // Always fresh data: the adapters' per-file caches keep it cheap.
    expect(src.calls).toEqual([{ maxAgeMs: 0 }]);
  });

  test("a fresh health line follows the first history line (rows report what it read)", async () => {
    const src = historySource({ delayMs: 20 });
    const healthCalls: Array<Freshness | undefined> = [];
    const source: WatchSource = {
      ...src.source,
      async health(fresh?: Freshness) {
        healthCalls.push(fresh);
        return [] as AdapterHealth[];
      },
    };
    const { w, lines } = watcherWith(source, { intervals: QUIET_H });
    w.start();
    await w.idle();
    w.stop();
    const types = lines.map((l) => l.type);
    const h = types.indexOf("history");
    expect(types.filter((t) => t === "health")).toHaveLength(2);
    expect(types.lastIndexOf("health")).toBeGreaterThan(h);
    // The start one may reuse a cached reading; the one after the history must not.
    expect(healthCalls).toEqual([{}, { maxAgeMs: 0 }]);
  });

  test("ticks on historyMs", async () => {
    const src = historySource();
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET_H, historyMs: 30 } });
    w.start();
    await sleep(110);
    w.stop();
    await w.idle();
    expect(lines.filter((l) => l.type === "history").length).toBeGreaterThanOrEqual(3);
  });

  test("a session that ends or appears brings one debounced history line; a status change within the live set doesn't", async () => {
    const src = historySource();
    const { w, lines } = watcherWith(src.source, { intervals: QUIET_H });
    w.start();
    await w.idle();
    const count = () => lines.filter((l) => l.type === "history").length;
    expect(count()).toBe(1);

    src.set([{ id: "a", status: "waiting" }]); // still live
    await w.fleet(true);
    await w.idle();
    expect(count()).toBe(1);

    src.set([{ id: "a", status: "ended" }]); // ended
    await w.fleet(true);
    const t0 = performance.now();
    src.set([
      { id: "a", status: "ended" },
      { id: "b", status: "busy" },
    ]); // and a new one, inside the same debounce
    await w.fleet(true);
    await w.idle();
    expect(count()).toBe(2);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(30);
    w.stop();
  });

  test("a change while a history is being built runs it once more afterwards", async () => {
    const src = historySource({ delayMs: 60 });
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET_H, historyDebounceMs: 5 } });
    w.start();
    await sleep(20); // the first history is running
    src.set([]);
    await w.fleet(true);
    await w.idle();
    w.stop();
    expect(lines.filter((l) => l.type === "history")).toHaveLength(2);
    expect(src.built()).toBe(2);
  });

  test("a failure is an error line with scope history; stop() cancels a pending one", async () => {
    let fail = true;
    const src = historySource({ fail: () => fail });
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET_H, historyDebounceMs: 1e6 } });
    w.start();
    await w.idle();
    expect(lines).toContainEqual(expect.objectContaining({ type: "error", scope: "history", message: "history broke" }));
    fail = false;
    src.set([]);
    await w.fleet(true); // schedules a history in 1e6 ms
    w.stop();
    await w.idle(); // returns: the pending one was cancelled
    expect(lines.some((l) => l.type === "history")).toBe(false);
  });
});

// ---------- Status pushes, with a fake source ----------

type Fleet = Extract<WatchLine, { type: "fleet" }>;

/** A source whose session watch the test drives, and whose fleets report which call they came from. */
function signallingSource(opts: { delayMs?: (quick: boolean) => number } = {}) {
  let listener: ((agent: string) => void) | undefined;
  let stopped = 0;
  const fleets: Array<{ quick: boolean; n: number }> = [];
  const source: WatchSource = {
    async fleet(_fresh?: Freshness, o?: FleetOptions) {
      const quick = o?.quick === true;
      const n = fleets.push({ quick, n: fleets.length + 1 });
      const delay = opts.delayMs?.(quick) ?? 0;
      if (delay) await sleep(delay);
      return { generatedAt: new Date().toISOString(), sessions: [{ agent: "fake", sessionId: `call-${n}`, status: quick ? "waiting" : "busy", source: quick ? "quick" : "full" }], limits: [], compactions: [], health: [] } as FleetSnapshot;
    },
    async report(req: ReportRequest) {
      return { range: { since: req.since.toISOString() } } as unknown as Report;
    },
    async health() {
      return [] as AdapterHealth[];
    },
    watchSessions(onChange) {
      listener = onChange;
      return () => {
        stopped++;
        listener = undefined;
      };
    },
  };
  return { source, fleets, signal: (agent = "claude-code") => listener?.(agent), stopped: () => stopped };
}

const QUIET = { fleetMs: 1e6, reportMs: 1e6, healthMs: 1e6 };

describe("Watcher status pushes", () => {
  test("a burst of change signals becomes one quick fleet after the debounce", async () => {
    const src = signallingSource();
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET, statusDebounceMs: 60, minFleetGapMs: 0 } });
    w.start();
    await w.idle();
    const before = lines.filter((l) => l.type === "fleet").length;
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) src.signal();
    src.signal("codex");
    await w.idle();
    const pushed = lines.filter((l): l is Fleet => l.type === "fleet").slice(before);
    expect(pushed).toHaveLength(1);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    expect(pushed[0]!.data.sessions[0]!.status).toBe("waiting");
    expect(src.fleets.map((f) => f.quick)).toEqual([false, true]);
    w.stop();
    expect(src.stopped()).toBe(1);
    src.signal(); // after stop: ignored
    await w.idle();
    expect(src.fleets).toHaveLength(2);
  });

  test("fleet lines stay minFleetGapMs apart under a signal storm, and the newest data wins", async () => {
    const src = signallingSource({ delayMs: () => 5 });
    const writes: Array<{ t: number; line: WatchLine }> = [];
    const w = new Watcher({
      source: src.source,
      days: 7,
      version: "9.9.9",
      write: (l) => writes.push({ t: performance.now(), line: JSON.parse(l) }),
      intervals: { ...QUIET, statusDebounceMs: 20, minFleetGapMs: 150 },
    });
    w.start();
    const storm = setInterval(() => src.signal(), 5);
    await sleep(700);
    clearInterval(storm);
    await w.idle();
    w.stop();
    const fleetWrites = writes.filter((x) => x.line.type === "fleet");
    expect(fleetWrites.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < fleetWrites.length; i++) expect(fleetWrites[i]!.t - fleetWrites[i - 1]!.t).toBeGreaterThanOrEqual(145);
    // Far fewer fleets were computed than signals sent, and the last line is the last computation.
    expect(src.fleets.length).toBeLessThan(40);
    const last = fleetWrites.at(-1)!.line as Fleet;
    expect(last.data.sessions[0]!.sessionId).toBe(`call-${src.fleets.length}`);
  });

  test("a slow tick that started before a status push is dropped, not sent after it", async () => {
    // The first (full) fleet takes 300 ms; the push starts later, finishes first and must stay the last word.
    const src = signallingSource({ delayMs: (quick) => (quick ? 0 : 300) });
    const { w, lines } = watcherWith(src.source, { intervals: { ...QUIET, statusDebounceMs: 10, minFleetGapMs: 0 } });
    w.start();
    await sleep(20);
    src.signal();
    await w.idle();
    w.stop();
    const fleets = lines.filter((l): l is Fleet => l.type === "fleet");
    expect(fleets.map((f) => f.data.sessions[0]!.source)).toEqual(["quick"]);
    expect(src.fleets.map((f) => f.quick)).toEqual([false, true]);
  });

  test("statusSignal works without a session watch (a source that ignores quick)", async () => {
    const { w, lines } = watcherWith(fakeSource(), { intervals: QUIET });
    w.start();
    w.statusSignal("claude-code");
    await w.idle();
    w.stop();
    expect(lines.filter((l) => l.type === "fleet")).toHaveLength(2);
  });
});

// ---------- The real CLI against synthetic agent homes ----------

const SID = "77777777-7777-4777-8777-777777777777";
/** Prompt text in the synthetic transcript: it must never appear on stdout. */
const CANARY = "CANARY_SECRET";
/** The child runs in a fixed non-UTC zone (UTC+5:30, no DST), so "calendar days" means its local midnight. */
const CHILD_TZ = "Asia/Kolkata";
const CHILD_OFFSET_MS = 5.5 * 3_600_000;

/** Local midnight in CHILD_TZ, `days - 1` days before `now`: calendarSince() as the child computes it. */
function childSince(days: number, now = new Date()): string {
  const local = new Date(now.getTime() + CHILD_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (days - 1)) - CHILD_OFFSET_MS).toISOString();
}
let root: string;
let env: Record<string, string>;

/** One synthetic Claude Code main transcript with two priced responses from an hour ago. */
function syntheticTranscript(): string {
  const ts = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const line = (id: string, msAgo: number) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: SID,
      cwd: "/Users/test/gamma",
      version: "2.1.300",
      timestamp: ts(msAgo),
      requestId: `req_${id}`,
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "synthetic" }],
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  const extra = [
    { type: "custom-title", customTitle: "Gamma session", sessionId: SID },
    { type: "last-prompt", lastPrompt: `${CANARY} last prompt`, sessionId: SID },
    { type: "user", message: { role: "user", content: `${CANARY} prompt` }, timestamp: ts(3_700_000), sessionId: SID, cwd: "/Users/test/gamma" },
  ].map((x) => JSON.stringify(x));
  return `${[...extra, line("msg_G1", 3_600_000), line("msg_G2", 3_500_000)].join("\n")}\n`;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-watch-"));
  const claude = join(root, "home", ".claude");
  const project = join(claude, "projects", "-Users-test-gamma");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(claude, "sessions"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "tmp"));
  writeFileSync(join(project, `${SID}.jsonl`), syntheticTranscript());
  // A live session: the registry row points at this test process's pid.
  writeFileSync(
    join(claude, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: "/Users/test/gamma", status: "busy", kind: "interactive", entrypoint: "cli" }),
  );
  // The Codex fixtures, minus the credential decoys (never copied, never read).
  cpSync(join(REPO, "packages", "adapter-codex", "test", "fixtures", "codex-home"), join(root, "home", ".codex"), {
    recursive: true,
    filter: (src) => !/auth/.test(src.slice(src.lastIndexOf("/") + 1)),
  });
  env = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(root, "home", ".codex"),
    SIGNALBOX_CLAUDE_BIN: "/nonexistent",
    SIGNALBOX_BIN_DIRS: "",
    PATH: join(root, "bin"),
    TMPDIR: join(root, "tmp"),
    TZ: CHILD_TZ,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Spawns `watch --ndjson` and hands out parsed stdout lines as they arrive. */
function spawnWatch(args: string[] = []) {
  const proc = Bun.spawn([process.execPath, MAIN, "watch", "--ndjson", ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: WatchLine[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    }
  })();
  const waitFor = async (pred: (l: WatchLine) => boolean, timeoutMs = 15_000): Promise<WatchLine> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = lines.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out; got ${lines.map((l) => l.type).join(",")}`);
      await sleep(20);
    }
  };
  const send = (text: string) => {
    proc.stdin.write(text);
    proc.stdin.flush();
  };
  return { proc, lines, waitFor, send, pump, rest: () => buf };
}

describe("signalbox watch --ndjson (spawned)", () => {
  test("streams hello/fleet/report/health, answers commands, exits 0 when stdin closes", async () => {
    const w = spawnWatch();
    try {
      await w.waitFor((l) => l.type === "fleet");
      await w.waitFor((l) => l.type === "report");
      await w.waitFor((l) => l.type === "health");
      expect(w.lines[0]).toMatchObject({ type: "hello", v: 1, version: pkg.version, pid: w.proc.pid });

      const fleet = w.lines.find((l) => l.type === "fleet") as Extract<WatchLine, { type: "fleet" }>;
      const live = fleet.data.sessions.find((s) => s.sessionId === SID)!;
      expect(live).toMatchObject({ agent: "claude-code", status: "busy", cwd: "/Users/test/gamma", model: "claude-opus-5-5" });
      // 2 x (1000 in + 500 out) at claude-opus-5-5 list price; the exact rate is pricing's concern.
      expect(live.costUsd).toBeGreaterThan(0);
      expect(fleet.data.health.length).toBeGreaterThan(0);

      const report = w.lines.find((l) => l.type === "report") as Extract<WatchLine, { type: "report" }>;
      expect(report.days).toBe(7);
      // Claude's two synthetic responses; the Codex fixtures' fixed dates may or may not fall in the window.
      expect(report.data.byAgent.find((g) => g.key === "claude-code")?.responses).toBe(2);
      expect(report.data.range.since).toBe(childSince(7));

      const commands = (await w.waitFor((l) => l.type === "commands")) as Extract<WatchLine, { type: "commands" }>;
      expect(w.lines.filter((l) => l.type === "commands")).toHaveLength(1);
      expect(Object.keys(commands.data)).toEqual(["v", "generatedAt", "installed", "catalogs", "custom"]);
      expect(commands.data.catalogs.map((c) => c.agent)).toEqual(["claude-code", "codex", "gemini-cli"]);
      // No agent binaries in the sandbox: versions unknown, so absent.
      expect(commands.data.installed).toEqual({});

      const history = (await w.waitFor((l) => l.type === "history")) as HistoryLine;
      const gamma = history.data.entries.find((e) => e.sessionId === SID)!;
      expect(gamma).toMatchObject({ agent: "claude-code", title: "Gamma session", titleSource: "custom", live: true, responses: 2, project: "/Users/test/gamma" });
      expect(gamma.resume).toEqual({ command: `claude --resume ${SID}`, cwd: "/Users/test/gamma" });
      expect(gamma.costUsd).toBeGreaterThan(0);
      expect(history.data.total).toBe(history.data.entries.length);
      expect(w.lines.findIndex((l) => l.type === "history")).toBeGreaterThan(w.lines.findIndex((l) => l.type === "report"));

      const health = w.lines.find((l) => l.type === "health") as Extract<WatchLine, { type: "health" }>;
      const names = health.data.map((h) => h.name);
      expect(names).toContain("claude-code:transcripts");
      expect(names).toContain("codex:rollouts");
      expect(health.data.find((h) => h.name === "claude-code:transcripts")!.ok).toBe(true);

      // A command split across writes, then garbage, then an unknown command: all survive.
      const seen = w.lines.length;
      w.send('{"cmd":"rep');
      await sleep(100);
      w.send('ort","days":30}\n');
      const r30 = (await w.waitFor((l) => l.type === "report" && l.days === 30)) as Extract<WatchLine, { type: "report" }>;
      expect(r30.data.range.since).toBe(childSince(30));
      expect(r30.data.byAgent.find((g) => g.key === "claude-code")?.responses).toBe(2);
      expect(w.lines.slice(seen).some((l) => l.type === "error")).toBe(false);

      w.send("this is not json\n");
      w.send('{"cmd":"self-destruct"}\n');
      await w.waitFor((l) => l.type === "error" && l.message.startsWith("unknown command"));
      expect(w.lines.filter((l) => l.type === "error").every((l) => (l as { scope: string }).scope === "protocol")).toBe(true);

      const fleets = w.lines.filter((l) => l.type === "fleet").length;
      w.send('{"cmd":"refresh"}\n');
      await w.waitFor(() => w.lines.filter((l) => l.type === "fleet").length > fleets);

      w.proc.stdin.end();
      const code = await Promise.race([w.proc.exited, sleep(5000).then(() => "hung")]);
      expect(code).toBe(0);
      await w.pump;
      expect(w.rest()).toBe("");
      expect(JSON.stringify(w.lines)).not.toContain(CANARY);
    } finally {
      w.proc.kill();
    }
  }, 30_000);

  test("SIGTERM exits 0", async () => {
    const w = spawnWatch(["--days", "1"]);
    try {
      const r = (await w.waitFor((l) => l.type === "report")) as Extract<WatchLine, { type: "report" }>;
      expect(r.days).toBe(1);
      w.proc.kill("SIGTERM");
      expect(await Promise.race([w.proc.exited, sleep(5000).then(() => "hung")])).toBe(0);
    } finally {
      w.proc.kill();
    }
  }, 20_000);

  test("stderr carries no protocol lines, stdout no logs", async () => {
    const w = spawnWatch();
    try {
      await w.waitFor((l) => l.type === "health");
      w.proc.stdin.end();
      await w.proc.exited;
      await w.pump;
      const err = await new Response(w.proc.stderr).text();
      expect(err).not.toContain('"type"');
      expect(w.lines.every((l) => typeof l.type === "string")).toBe(true);
    } finally {
      w.proc.kill();
    }
  }, 20_000);
});

describe("watch --ndjson status pushes (spawned)", () => {
  const SID2 = "88888888-8888-4888-8888-888888888888";
  let home: string;
  let pushEnv: Record<string, string>;
  let registryFile: string;
  let runsFile: string;

  const writeRegistry = (status: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      registryFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: SID2,
        cwd: "/Users/test/delta",
        startedAt: Date.now() - 600_000,
        kind: "interactive",
        entrypoint: "cli",
        name: "delta",
        status,
        updatedAt: Date.now(),
        statusUpdatedAt: Date.now(),
        ...extra,
      }),
    );
  const agentsRuns = () => {
    try {
      return readFileSync(runsFile, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "signalbox-push-"));
    const claude = join(home, ".claude");
    mkdirSync(join(claude, "sessions"), { recursive: true });
    mkdirSync(join(home, "bin"));
    mkdirSync(join(home, "tmp"));
    // agents --json only runs when Claude Code's global config exists.
    writeFileSync(join(claude, ".claude.json"), "{}\n");
    registryFile = join(claude, "sessions", `${process.pid}.json`);
    runsFile = join(home, "agents-runs");
    // A synthetic `claude agents --json --all`: counts its runs and always says "busy" (a stale view
    // the registry must beat). Shell builtins only: the child's PATH is just the bin dir.
    const fake = join(home, "bin", "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '2.1.293 (Claude Code)'; exit 0; fi\necho run >> '${runsFile}'\nprintf '%s\\n' '${JSON.stringify([
        { pid: process.pid, cwd: "/Users/test/delta", kind: "interactive", startedAt: Date.now() - 600_000, sessionId: SID2, name: "delta", status: "busy" },
      ])}'\n`,
    );
    chmodSync(fake, 0o755);
    writeRegistry("busy", { statusUpdatedAt: Date.now() - 60_000 });
    pushEnv = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(home, ".codex"),
      SIGNALBOX_CLAUDE_BIN: fake,
      SIGNALBOX_BIN_DIRS: "",
      PATH: join(home, "bin"),
      TMPDIR: join(home, "tmp"),
      TZ: "UTC",
    };
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test("a registry status change reaches stdout within 1.5 s, without running agents --json again", async () => {
    const proc = Bun.spawn([process.execPath, MAIN, "watch", "--ndjson"], { env: pushEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: WatchLine[] = [];
    const pump = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      const reader = proc.stdout.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          lines.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      }
    })();
    const statusIn = (l: WatchLine) => (l.type === "fleet" ? l.data.sessions.find((x) => x.sessionId === SID2) : undefined);
    const nextFleet = async (from: number, want: string, timeoutMs: number) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const hit = lines.slice(from).find((l) => statusIn(l)?.status === want);
        if (hit) return statusIn(hit)!;
        if (performance.now() > deadline) throw new Error(`no fleet with status ${want} within ${timeoutMs} ms; got ${lines.slice(from).map((l) => l.type).join(",")}`);
        await sleep(10);
      }
    };
    try {
      const first = await nextFleet(0, "busy", 15_000);
      expect(first.source).toBe("agents --json+registry");
      await sleep(300);
      const runsBefore = agentsRuns();
      expect(runsBefore).toBeGreaterThanOrEqual(1);

      const latencies: number[] = [];
      for (const [status, extra] of [
        ["waiting", { waitingFor: "permission prompt" }],
        ["busy", {}],
        ["waiting", { waitingFor: "input needed" }],
      ] as const) {
        const from = lines.length;
        const t0 = performance.now();
        writeRegistry(status, extra);
        const s = await nextFleet(from, status, 1500);
        latencies.push(Math.round(performance.now() - t0));
        expect(s.statusSince).toBeDefined();
        if (status === "waiting") expect(s.waitingFor).toBe(extra.waitingFor);
        else expect(s.waitingFor).toBeUndefined();
      }
      // Not one claude spawn per change: pushes reuse the last agents --json result.
      expect(agentsRuns()).toBe(runsBefore);
      expect(latencies.every((ms) => ms < 1500)).toBe(true);

      // A burst of writes to a key file next to it is not a registry change.
      const fleetsBefore = lines.filter((l) => l.type === "fleet").length;
      writeFileSync(join(pushEnv.CLAUDE_CONFIG_DIR!, "sessions", `${process.pid}.deadbeef.key`), "synthetic");
      await sleep(800);
      expect(lines.filter((l) => l.type === "fleet").length).toBe(fleetsBefore);

      proc.stdin.end();
      expect(await Promise.race([proc.exited, sleep(5000).then(() => "hung")])).toBe(0);
      await pump;
    } finally {
      proc.kill();
    }
  }, 30_000);
});

describe("snapshot --json and fleet --json (spawned)", () => {
  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath, MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  }

  test("snapshot is one object with the protocol's fields", async () => {
    const { out, code } = await run(["snapshot", "--json", "--days", "30"]);
    expect(code).toBe(0);
    const snap = JSON.parse(out);
    expect(Object.keys(snap).sort()).toEqual(["commands", "days", "fleet", "generatedAt", "health", "history", "report", "v"]);
    expect(snap.commands).toMatchObject({ v: 1, installed: {}, custom: [] });
    expect(snap).toMatchObject({ v: 1, days: 30 });
    expect(snap.report.byAgent.find((g: { key: string }) => g.key === "claude-code")?.responses).toBe(2);
    expect(snap.report.range.since).toBe(childSince(30, new Date(snap.generatedAt)));
    expect(snap.fleet.sessions.some((s: { sessionId: string }) => s.sessionId === SID)).toBe(true);
    expect(snap.health.some((h: { name: string }) => h.name === "claude-code:transcripts")).toBe(true);
  }, 20_000);

  test("fleet --json is the /api/fleet shape", async () => {
    const { out, code } = await run(["fleet", "--json"]);
    expect(code).toBe(0);
    const f = JSON.parse(out) as FleetSnapshot;
    expect(Object.keys(f).sort()).toEqual(["compactions", "generatedAt", "health", "limits", "sessions"]);
    expect(f.sessions.find((s) => s.sessionId === SID)?.status).toBe("busy");
  }, 20_000);

  test("history --json: titles and stats, never prompt text", async () => {
    const { out, code } = await run(["history", "--json"]);
    expect(code).toBe(0);
    expect(out).not.toContain(CANARY);
    const h = JSON.parse(out) as HistorySnapshot;
    expect(Object.keys(h)).toEqual(["v", "generatedAt", "entries", "total", "truncated", "sources"]);
    const gamma = h.entries.find((e) => e.sessionId === SID)!;
    expect(gamma).toMatchObject({ title: "Gamma session", titleSource: "custom", live: true, responses: 2, hasTranscript: true });
    // The Claude app's list is on by default; this HOME has none, so it adds nothing.
    expect(h.sources?.claudeApp).toEqual({ enabled: true, records: 0, merged: 0, appOnly: 0, archived: 0 });
    expect(h.sources?.transcripts).toBe(h.total);
    // The Codex fixtures add named sessions from session_index.jsonl, archived ones included.
    expect(h.entries.some((e) => e.agent === "codex" && e.titleSource === "index")).toBe(true);
    for (let i = 1; i < h.entries.length; i++) expect(h.entries[i - 1]!.lastActivityAt >= h.entries[i]!.lastActivityAt).toBe(true);
    const one = JSON.parse((await run(["history", "--json", "--limit", "1", "--agent", "codex"])).out) as HistorySnapshot;
    expect(one.entries).toHaveLength(1);
    expect(one.entries[0]!.agent).toBe("codex");
    expect(one).toMatchObject({ truncated: true });
    expect(one.total).toBeGreaterThan(1);
  }, 20_000);

  test("history prints a table with the title", async () => {
    const { out, code } = await run(["history", "--days", "7"]);
    expect(code).toBe(0);
    expect(out).toContain("Signalbox history  all agents, last 7 calendar days");
    expect(out).toContain("Gamma session");
    expect(out).not.toContain(CANARY);
  }, 20_000);

  test("missing format flags and out-of-range days are usage errors", async () => {
    for (const args of [["watch"], ["snapshot"], ["fleet"], ["watch", "--ndjson", "--days", "366"], ["snapshot", "--json", "--days", "0"]]) {
      const { code, err } = await run(args);
      expect(code).toBe(2);
      expect(err).toContain("signalbox:");
    }
  }, 20_000);
});
