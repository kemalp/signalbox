// `signalbox watch --ndjson`: the stream the macOS app reads, protocol v1. One JSON object per line on
// stdout; logs only on stderr.
//
//   CLI → app  {"type":"hello","v":1,"version":"…","pid":n}
//              {"type":"fleet","at":ISO,"data":FleetSnapshot}          start, every 15 s, after "refresh", and
//                                                                      within ~1 s of a session status change
//              {"type":"report","at":ISO,"days":N,"data":Report}       start, every 60 s, after "report"/"refresh"
//              {"type":"health","at":ISO,"data":AdapterHealth[]}       start, after the first history (whose
//                                                                      counts some rows report), every 5 min
//              {"type":"commands","at":ISO,"data":CommandsSnapshot}   start, every 10 min, and after "refresh"
//                                                                      when the last one is older than 60 s
//              {"type":"history","at":ISO,"data":HistorySnapshot}     once the first fleet and report are done,
//                                                                      every 5 min, and ~5 s after a session
//                                                                      appears in or leaves the fleet's live set
//              {"type":"error","at":ISO,"scope":"fleet|report|health|commands|history|protocol","message":"…"}
//   app → CLI  {"cmd":"report","days":N}   switch the report window (1..365) and emit a report now
//              {"cmd":"refresh"}            emit fleet + report now (ignored while a refresh is running), and
//                                           commands too when the last commands line is older than 60 s
//
// The report window is calendar days, like the web page: days 1 = since local midnight. The process
// never exits on a failed read (it emits an error line instead) and exits 0 when stdin closes. Readers
// must ignore line types they don't know: new ones are added without a protocol version change (the
// "commands" line, the command guide, and the "history" line were added that way).
//
// History: every session with a main transcript (Claude Code) or main rollout (Codex), plus the Claude app's own
// session list (read-only and allow-listed; the app's title wins, and a session it lists without a transcript has
// `hasTranscript: false` and no figures), newest activity first, at most 500 (HistorySnapshot.total/truncated say
// how many matched, `sources` where they came from). `--no-claude-app` leaves the app's list out; the app restarts
// the CLI with or without it. It reuses the adapters' per-file transcript caches (a tick re-reads only files that
// changed), so the first one, after the first scan, is the only full read of older transcripts. "Live" means busy,
// waiting or idle in the last fleet. Titles only: never prompts, message bodies, summaries or tool output.
//
// Status pushes: adapters that can watch their sessions (Claude Code's registry dir, Codex's newest
// rollouts) signal a possible change; signals within `statusDebounceMs` of the first are coalesced into
// one quick fleet (status from those files, no `claude agents --json` run), sent like any fleet line.
// Fleet lines are at least `minFleetGapMs` apart (a line that's ready sooner waits, and a newer one
// replaces it), and a fleet that started before the last one sent is dropped, so a slow tick can't
// overwrite a fresher status.
import type { AdapterHealth, CommandsSnapshot, FleetSnapshot, HistorySnapshot, Report, SessionStatus } from "@signalbox/core";
import { calendarSince } from "./args.ts";
import type { FleetOptions, Freshness, ReportRequest } from "./data.ts";

export const PROTOCOL_VERSION = 1;
export const MIN_WATCH_DAYS = 1;
export const MAX_WATCH_DAYS = 365;
export const DEFAULT_WATCH_DAYS = 7;

export const DEFAULT_INTERVALS = {
  fleetMs: 15_000,
  reportMs: 60_000,
  healthMs: 300_000,
  commandsMs: 600_000,
  commandsRefreshAgeMs: 60_000,
  statusDebounceMs: 400,
  minFleetGapMs: 500,
  historyMs: 300_000,
  historyDebounceMs: 5_000,
} as const;
export type Intervals = {
  fleetMs: number;
  reportMs: number;
  healthMs: number;
  /** The command guide changes rarely (a new custom command, an agent update): every 10 minutes. */
  commandsMs: number;
  /** A refresh also resends the command guide when the last one is at least this old. */
  commandsRefreshAgeMs: number;
  /** A status push waits this long after the first change signal, coalescing the burst. */
  statusDebounceMs: number;
  /** Fleet lines are at least this far apart (500 ms: never more than 2 a second). */
  minFleetGapMs: number;
  /** The session history: every 5 minutes. */
  historyMs: number;
  /** A history line follows this long after a session appears in or leaves the fleet (bursts coalesce). */
  historyDebounceMs: number;
};

/**
 * Cache settings for the watch process's SignalboxData. Fleet ticks reuse transcript scans and
 * compactions for up to 2 minutes (each report tick refreshes the scan it shares with the fleet when
 * the window is 7 days), and the fleet's `health` field reuses the 5-minute health reading.
 */
export const WATCH_CACHE = { ttlMs: 120_000, healthTtlMs: 300_000 } as const;

/**
 * Whether SIGNALBOX_DEBUG turns on the per-tick timing log. The macOS app inherits and passes the same
 * variable, so both read "", "0", "false", "no" and "off" (any case) as off (DebugLog.offValues in the app).
 */
export function debugEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** A stdin line longer than this many characters is dropped with an error line; real commands are tiny. */
export const MAX_COMMAND_CHARS = 64 * 1024;

export type ErrorScope = "fleet" | "report" | "health" | "commands" | "history" | "protocol";

export type WatchLine =
  | { type: "hello"; v: typeof PROTOCOL_VERSION; version: string; pid: number }
  | { type: "fleet"; at: string; data: FleetSnapshot }
  | { type: "report"; at: string; days: number; data: Report }
  | { type: "health"; at: string; data: AdapterHealth[] }
  | { type: "commands"; at: string; data: CommandsSnapshot }
  | { type: "history"; at: string; data: HistorySnapshot }
  | { type: "error"; at: string; scope: ErrorScope; message: string };

export type WatchCommand = { cmd: "report"; days: number } | { cmd: "refresh" };

/** `signalbox snapshot --json`: everything one watch session starts with, as one object (also the app's fixture format). */
export interface Snapshot {
  v: typeof PROTOCOL_VERSION;
  generatedAt: string;
  days: number;
  fleet: FleetSnapshot;
  report: Report;
  health: AdapterHealth[];
  /** The command guide; optional so fixtures made before it existed still decode. */
  commands?: CommandsSnapshot;
  /** The session history (newest 500); optional like `commands`. */
  history?: HistorySnapshot;
}

/** What the watcher needs from SignalboxData. */
export interface WatchSource {
  fleet(fresh?: Freshness, opts?: FleetOptions): Promise<FleetSnapshot>;
  report(req: ReportRequest, fresh?: Freshness): Promise<Report>;
  health(fresh?: Freshness): Promise<AdapterHealth[]>;
  /** The command guide. Without it the stream has no "commands" lines. */
  commands?(): Promise<CommandsSnapshot>;
  /** The session history. Without it the stream has no "history" lines. */
  history?(fresh?: Freshness): Promise<HistorySnapshot>;
  /** Session status-change signals, for pushes between fleet ticks. Returns a function that stops them. */
  watchSessions?(onChange: (agent: string) => void): () => void;
}

/** A timer with a promise that settles when it has fired (and its callback ran) or was cancelled. */
interface Pending {
  done: Promise<void>;
  cancel(): void;
}

function pending(ms: number, fn: () => void): Pending {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const t = setTimeout(() => {
    try {
      fn();
    } finally {
      resolve();
    }
  }, ms);
  return {
    done,
    cancel() {
      clearTimeout(t);
      resolve();
    },
  };
}

/**
 * Splits a byte stream into lines. Handles chunks that end mid-line or mid-character, CRLF, and
 * lines that never end: once the pending text passes `maxChars` it is dropped up to the next newline
 * and reported once as `{ overflow: true }`.
 */
export class LineSplitter {
  private buf = "";
  private skipping = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly maxChars = MAX_COMMAND_CHARS) {}

  push(chunk: Uint8Array | string): Array<string | { overflow: true }> {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.take(text);
  }

  /** The unterminated last line at end of input, if any. */
  end(): Array<string | { overflow: true }> {
    const out = this.take(this.decoder.decode());
    if (!this.skipping && this.buf !== "") out.push(stripCr(this.buf));
    this.buf = "";
    this.skipping = false;
    return out;
  }

  private take(text: string): Array<string | { overflow: true }> {
    const out: Array<string | { overflow: true }> = [];
    let rest = text;
    for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n")) {
      const piece = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        this.buf = "";
        continue;
      }
      const line = this.buf + piece;
      this.buf = "";
      if (line.length > this.maxChars) out.push({ overflow: true });
      else out.push(stripCr(line));
    }
    if (this.skipping) return out;
    this.buf += rest;
    if (this.buf.length > this.maxChars) {
      this.buf = "";
      this.skipping = true;
      out.push({ overflow: true });
    }
    return out;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** One stdin line → a command, `null` for a blank line, or `{ error }` for the protocol error line. */
export function parseCommand(line: string): WatchCommand | { error: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let d: unknown;
  try {
    d = JSON.parse(trimmed);
  } catch {
    return { error: `stdin: not a JSON line (${preview(trimmed)})` };
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return { error: `stdin: expected a JSON object (${preview(trimmed)})` };
  const cmd = (d as Record<string, unknown>).cmd;
  if (typeof cmd !== "string") return { error: `stdin: missing "cmd" (${preview(trimmed)})` };
  switch (cmd) {
    case "refresh":
      return { cmd: "refresh" };
    case "report": {
      const days = (d as Record<string, unknown>).days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_WATCH_DAYS || days > MAX_WATCH_DAYS) {
        return { error: `report: "days" must be a whole number from ${MIN_WATCH_DAYS} to ${MAX_WATCH_DAYS}` };
      }
      return { cmd: "report", days };
    }
    default:
      return { error: `unknown command ${JSON.stringify(cmd.slice(0, 40))}` };
  }
}

function preview(s: string): string {
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
}

export interface WatcherOptions {
  source: WatchSource;
  days: number;
  version: string;
  pid?: number;
  /** Receives each protocol line, already serialized, without the trailing newline. */
  write(line: string): void;
  intervals?: Partial<Intervals>;
  now?: () => Date;
  /** Debug log (stderr), e.g. per-tick timings. */
  log?(msg: string): void;
}

/**
 * A forced refresh asks for data no older than the request: reuse only in-flight work. A forced scan is
 * still cheap when little changed: the Claude Code adapter keeps each transcript's parse while its mtime
 * and size stay the same, so a report tick re-reads only the files that grew.
 */
const FORCE: Freshness = { maxAgeMs: 0 };

/** Fleet statuses that count as a live session for history triggers (and HistorySnapshot's `live`). */
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "waiting", "idle"]);

function liveKeys(fleet: FleetSnapshot): Set<string> {
  return new Set(fleet.sessions.filter((s) => LIVE_STATUSES.has(s.status)).map((s) => `${s.agent}/${s.sessionId}`));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Schedules fleet/report/health emissions and handles stdin commands. Overlapping ticks of the same
 * stream are skipped, and a report finished for a window the app has since switched away from is
 * dropped (the app gets the new window's report instead).
 */
export class Watcher {
  private days: number;
  private stopped = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private fleetRun?: Promise<void>;
  private fleetQueued?: Promise<void>;
  private healthRun?: Promise<void>;
  private commandsRun?: Promise<void>;
  /** performance.now() of the last "commands" line. */
  private lastCommandsAt?: number;
  private readonly reportRuns = new Map<number, Promise<void>>();
  private refreshing = false;
  private readonly intervals: Intervals;
  private readonly now: () => Date;
  private stopWatching?: () => void;
  /** The debounce before a status push. */
  private statusWait?: Pending;
  private statusSignals = new Map<string, number>();
  private quickRun?: Promise<void>;
  private quickAgain = false;
  /** Fleet computations started, and the newest one sent (or waiting to be). */
  private fleetSeq = 0;
  private sentSeq = 0;
  private lastFleetWrite = -Infinity;
  private heldFleet?: FleetSnapshot;
  private heldWait?: Pending;
  /** The first history line, which waits for the first fleet and report. */
  private firstHistory?: Promise<void>;
  private historyRun?: Promise<void>;
  private historyAgain = false;
  /** The debounce between a fleet whose live set changed and the history line it triggers. */
  private historyWait?: Pending;
  /** Live sessions in the last fleet line sent; undefined until the first one. */
  private lastLive?: Set<string>;

  constructor(private readonly opts: WatcherOptions) {
    this.days = opts.days;
    this.intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
    this.now = opts.now ?? (() => new Date());
  }

  get currentDays(): number {
    return this.days;
  }

  start(): void {
    this.emit({ type: "hello", v: PROTOCOL_VERSION, version: this.opts.version, pid: this.opts.pid ?? process.pid });
    const firstFleet = this.fleet();
    const firstReport = this.report(this.days);
    void this.health();
    void this.commands();
    this.timers.push(
      setInterval(() => void this.fleet(), this.intervals.fleetMs),
      setInterval(() => void this.report(this.days, FORCE), this.intervals.reportMs),
      setInterval(() => void this.health(FORCE), this.intervals.healthMs),
    );
    if (this.opts.source.commands) this.timers.push(setInterval(() => void this.commands(), this.intervals.commandsMs));
    if (this.opts.source.history) {
      // After the first scan, so the history reuses the transcripts it parsed; its live flags use that fleet.
      // Then a health line: rows such as the Claude app's list and the titles report what the last history read.
      const first: Promise<void> = Promise.allSettled([firstFleet, firstReport]).then(() => {
        if (this.firstHistory === first) this.firstHistory = undefined;
        if (!this.stopped) void this.history().then(() => this.healthAfter());
      });
      this.firstHistory = first;
      this.timers.push(setInterval(() => void this.history(), this.intervals.historyMs));
    }
    try {
      this.stopWatching = this.opts.source.watchSessions?.((agent) => this.statusSignal(agent));
    } catch (err) {
      this.opts.log?.(`status pushes off: ${message(err)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.statusWait?.cancel();
    this.statusWait = undefined;
    this.heldWait?.cancel();
    this.heldWait = undefined;
    this.historyWait?.cancel();
    this.historyWait = undefined;
  }

  /** Resolves once nothing is in flight or scheduled to send (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [
        this.fleetRun,
        this.fleetQueued,
        this.healthRun,
        this.commandsRun,
        this.quickRun,
        this.statusWait?.done,
        this.heldWait?.done,
        this.firstHistory,
        this.historyRun,
        this.historyWait?.done,
        ...this.reportRuns.values(),
      ].filter(Boolean);
      if (busy.length === 0) return;
      await Promise.allSettled(busy);
    }
  }

  /** A possible session status change in `agent`: schedules one quick fleet for the whole burst. */
  statusSignal(agent: string): void {
    if (this.stopped) return;
    this.statusSignals.set(agent, (this.statusSignals.get(agent) ?? 0) + 1);
    if (this.statusWait) return;
    const wait = pending(this.intervals.statusDebounceMs, () => {
      if (this.statusWait === wait) this.statusWait = undefined;
      void this.quickFleet();
    });
    this.statusWait = wait;
  }

  /** A fleet from cheap reads (see FleetOptions.quick). One at a time; a request meanwhile runs once more after it. */
  quickFleet(): Promise<void> {
    if (this.quickRun) {
      this.quickAgain = true;
      return this.quickRun;
    }
    const signals = [...this.statusSignals].map(([a, n]) => `${a}×${n}`).join(" ");
    this.statusSignals.clear();
    const seq = ++this.fleetSeq;
    const run = this.timed(`fleet (status push${signals ? `: ${signals}` : ""})`, () => this.opts.source.fleet({}, { quick: true }))
      .then((data) => this.sendFleet(seq, data))
      .catch((err) => this.error("fleet", message(err)))
      .finally(() => {
        if (this.quickRun === run) this.quickRun = undefined;
        if (this.quickAgain && !this.stopped) {
          this.quickAgain = false;
          void this.quickFleet();
        }
      });
    this.quickRun = run;
    return run;
  }

  handleLine(line: string | { overflow: true }): void {
    if (this.stopped) return;
    if (typeof line !== "string") {
      this.error("protocol", `stdin: line longer than ${MAX_COMMAND_CHARS} characters, dropped`);
      return;
    }
    const c = parseCommand(line);
    if (c === null) return;
    if ("error" in c) {
      this.error("protocol", c.error);
      return;
    }
    if (c.cmd === "report") {
      this.days = c.days;
      void this.report(c.days);
    } else {
      void this.refresh();
    }
  }

  /**
   * fleet + report with fresh data, and the command guide when the last one is older than
   * `commandsRefreshAgeMs`; a refresh that arrives while one runs is ignored.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.opts.log?.("refresh ignored: one is already running");
      return;
    }
    if (this.lastCommandsAt === undefined || performance.now() - this.lastCommandsAt >= this.intervals.commandsRefreshAgeMs) void this.commands();
    this.refreshing = true;
    try {
      await Promise.all([this.fleet(true), this.report(this.days, FORCE, true)]);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Emits a fleet line. A tick that finds one running skips; a forced call runs once more after the
   * running one (shared by every forced call that arrives meanwhile), so its data postdates the request.
   */
  fleet(force = false): Promise<void> {
    if (this.fleetRun) {
      if (!force) return this.fleetRun;
      this.fleetQueued ??= this.fleetRun.then(() => {
        this.fleetQueued = undefined;
        return this.fleet(true);
      });
      return this.fleetQueued;
    }
    const seq = ++this.fleetSeq;
    const run = this.timed("fleet", () => this.opts.source.fleet(force ? FORCE : {}))
      .then((data) => this.sendFleet(seq, data))
      .catch((err) => this.error("fleet", message(err)))
      .finally(() => {
        if (this.fleetRun === run) this.fleetRun = undefined;
      });
    this.fleetRun = run;
    return run;
  }

  /** Emits a report for `days` unless one for the same window is already running (then that one is the answer). */
  report(days: number, fresh: Freshness = {}, force = false): Promise<void> {
    const running = this.reportRuns.get(days);
    if (running) return force ? running.then(() => this.report(days, fresh)) : running;
    const run = this.timed(`report ${days}d`, () => this.opts.source.report({ since: calendarSince(days, this.now()) }, fresh))
      .then((data) => {
        if (days === this.days) this.emit({ type: "report", at: this.at(), days, data });
        else this.opts.log?.(`report ${days}d dropped: the window is now ${this.days}d`);
      })
      .catch((err) => this.error("report", message(err)))
      .finally(() => {
        if (this.reportRuns.get(days) === run) this.reportRuns.delete(days);
      });
    this.reportRuns.set(days, run);
    return run;
  }

  /** A fresh health line once any health run in flight (which may predate what it should report) is done. */
  private healthAfter(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const running = this.healthRun;
    return running ? running.then(() => this.health(FORCE)) : this.health(FORCE);
  }

  health(fresh: Freshness = {}): Promise<void> {
    if (this.healthRun) return this.healthRun;
    const run = this.timed("health", () => this.opts.source.health(fresh))
      .then((data) => this.emit({ type: "health", at: this.at(), data }))
      .catch((err) => this.error("health", message(err)))
      .finally(() => {
        if (this.healthRun === run) this.healthRun = undefined;
      });
    this.healthRun = run;
    return run;
  }

  /** Emits a "commands" line, unless the source has no command guide; one at a time (a call meanwhile shares it). */
  commands(): Promise<void> {
    if (!this.opts.source.commands) return Promise.resolve();
    if (this.commandsRun) return this.commandsRun;
    const run = this.timed("commands", () => this.opts.source.commands!())
      .then((data) => {
        if (this.stopped) return;
        this.lastCommandsAt = performance.now();
        this.emit({ type: "commands", at: this.at(), data });
      })
      .catch((err) => this.error("commands", message(err)))
      .finally(() => {
        if (this.commandsRun === run) this.commandsRun = undefined;
      });
    this.commandsRun = run;
    return run;
  }

  /**
   * Emits a "history" line, unless the source has none. One at a time: a tick that finds one running shares
   * it; `again` (a session appeared or ended) runs once more after it, so the line postdates the change.
   */
  history(again = false): Promise<void> {
    const source = this.opts.source;
    if (!source.history) return Promise.resolve();
    if (this.historyRun) {
      if (again) this.historyAgain = true;
      return this.historyRun;
    }
    const run = this.timed("history", () => source.history!(FORCE))
      .then((data) => this.emit({ type: "history", at: this.at(), data }))
      .catch((err) => this.error("history", message(err)))
      .finally(() => {
        if (this.historyRun === run) this.historyRun = undefined;
        if (this.historyAgain && !this.stopped) {
          this.historyAgain = false;
          void this.history();
        }
      });
    this.historyRun = run;
    return run;
  }

  /** A history line `historyDebounceMs` from now; a request while one is waiting joins it. */
  private historySoon(): void {
    if (this.stopped || !this.opts.source.history || this.historyWait) return;
    const wait = pending(this.intervals.historyDebounceMs, () => {
      if (this.historyWait === wait) this.historyWait = undefined;
      void this.history(true);
    });
    this.historyWait = wait;
  }

  error(scope: ErrorScope, msg: string): void {
    this.emit({ type: "error", at: this.at(), scope, message: msg });
  }

  /** Sends fleet #seq unless a later-started one went first, keeping lines `minFleetGapMs` apart. */
  private sendFleet(seq: number, data: FleetSnapshot): void {
    if (this.stopped) return;
    if (seq < this.sentSeq) {
      this.opts.log?.(`fleet #${seq} dropped: #${this.sentSeq} started later and was sent first`);
      return;
    }
    this.sentSeq = seq;
    const wait = this.lastFleetWrite + this.intervals.minFleetGapMs - performance.now();
    if (wait <= 0 && !this.heldWait) {
      this.writeFleet(data);
      return;
    }
    this.heldFleet = data;
    if (this.heldWait) return;
    const held = pending(Math.max(0, wait), () => {
      if (this.heldWait === held) this.heldWait = undefined;
      const d = this.heldFleet;
      this.heldFleet = undefined;
      if (d) this.writeFleet(d);
    });
    this.heldWait = held;
  }

  private writeFleet(data: FleetSnapshot): void {
    this.lastFleetWrite = performance.now();
    this.emit({ type: "fleet", at: this.at(), data });
    // A session that appeared or ended changes the history (its live flag, a new row): resend it soon.
    const live = liveKeys(data);
    if (this.lastLive && !sameSet(this.lastLive, live)) this.historySoon();
    this.lastLive = live;
  }

  private at(): string {
    return this.now().toISOString();
  }

  private emit(line: WatchLine): void {
    if (this.stopped) return;
    this.opts.write(JSON.stringify(line));
  }

  /** Wall and process CPU time of one operation, to the debug log. CPU overlaps with concurrent work. */
  private async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.opts.log) return fn();
    const wall = performance.now();
    const cpu = process.cpuUsage();
    try {
      return await fn();
    } finally {
      const used = process.cpuUsage(cpu);
      this.opts.log(`${label}: ${Math.round(performance.now() - wall)} ms wall, ${Math.round((used.user + used.system) / 1000)} ms cpu`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
