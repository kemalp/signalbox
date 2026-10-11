#!/usr/bin/env bun
// The `signalbox` CLI: report, doctor, serve, watch, snapshot, fleet, commands, history. Read-only: it never
// writes agent config or the Claude app's files, never runs a slash command, and prints aggregates and session
// titles only (no message content).
import { loadPriceTables, type PriceTable } from "@signalbox/core";
import pkg from "../package.json" with { type: "json" };
import {
  calendarSince,
  helpText,
  parseArgs,
  reportWindow,
  reportWindowLabel,
  UsageError,
  type CommandsArgs,
  type HistoryArgs,
  type ReportArgs,
  type ServeArgs,
  type SnapshotArgs,
  type WatchArgs,
} from "./args.ts";
import { CATALOG_AGENTS, CommandGuide, filterSnapshot, formatCommands } from "./commands.ts";
import { message, SignalboxData } from "./data.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { formatHistory, formatReport } from "./format.ts";
import { ensurePrivateDir } from "./private-dir.ts";
import { adapterIds, findEntry, loadAdapters, type LoadedAdapter } from "./registry.ts";
import { debugEnabled, LineSplitter, PROTOCOL_VERSION, WATCH_CACHE, Watcher, type Snapshot, type WatchSource } from "./watch.ts";

const VERSION: string = pkg.version;

/** The built-in price tables, or the directory in $SIGNALBOX_PRICING_DIR. */
function priceTables(): PriceTable[] {
  return loadPriceTables(process.env.SIGNALBOX_PRICING_DIR || undefined);
}

/** The tap mod can't set modes, so readers create its spool dir 0700 (and tighten one it made). */
async function makeSpoolDirsPrivate(adapters: LoadedAdapter[]): Promise<void> {
  for (const la of adapters) {
    const dir = la.entry.spoolDir?.(la.adapter);
    if (!dir) continue;
    try {
      const was = await ensurePrivateDir(dir);
      if (was) console.error(`signalbox: ${dir} was mode ${was}; changed it to 0700.`);
    } catch (err) {
      console.error(`signalbox: could not make ${dir} private: ${message(err)}`);
    }
  }
}

async function report(args: ReportArgs): Promise<number> {
  const started = performance.now();
  const now = new Date();
  const { since, until } = reportWindow(args, now);
  const data = new SignalboxData({ adapters: loadAdapters(args.agent), tables: priceTables(), now: () => now });
  const r = await data.report(args.agent ? { since, until, agent: args.agent } : { since, until });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    const agentLabel = args.agent ? (findEntry(args.agent)?.displayName ?? args.agent) : "all agents";
    const noData = (await data.detected(args.agent)).length === 0;
    console.log(
      formatReport(r, {
        width: process.stdout.columns,
        agentLabel,
        windowLabel: reportWindowLabel(args),
        elapsedMs: performance.now() - started,
        noData,
        verbose: args.verbose,
      }),
    );
  }
  return 0;
}

async function doctor(json: boolean): Promise<number> {
  const adapters = loadAdapters();
  const tables = priceTables();
  const data = new SignalboxData({ adapters, tables });
  const d = await runDoctor({ data, adapters, tables, version: VERSION });
  console.log(json ? JSON.stringify(d, null, 2) : formatDoctor(d, process.stdout.columns));
  return 0;
}

function openInBrowser(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!cmd || !Bun.which(cmd)) return false;
  try {
    Bun.spawn([cmd, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function serve(args: ServeArgs): Promise<number> {
  const adapters = loadAdapters();
  const data = new SignalboxData({ adapters, tables: priceTables() });
  await makeSpoolDirsPrivate(adapters);
  // Loaded on demand so the other commands don't pay for the page bundle.
  const { startServer } = await import("@signalbox/web");
  const server = await startServer({
    port: args.port,
    api: {
      report: (q) => data.report(q.agent ? { since: calendarSince(q.days, new Date()), agent: q.agent } : { since: calendarSince(q.days, new Date()) }),
      fleet: () => data.fleet(),
      health: () => data.health(),
    },
  });
  // Warm the default 7-day scan so the first page load is quick.
  void data.report({ since: calendarSince(7, new Date()) }).catch(() => {});
  console.log(`Signalbox is running on 127.0.0.1:${server.port} (read-only, local only). Ctrl-C stops it.`);
  console.log(`Open: ${server.url}`);
  console.log("The link carries this run's access token; it changes every time the server starts.");
  if (args.open && !openInBrowser(server.url)) console.log("(Could not open a browser; paste the link above.)");
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  // SIGHUP is what closing the terminal window sends; without a handler the socket dir stays behind.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop);
  await new Promise<never>(() => {});
  return 0;
}

async function fleet(): Promise<number> {
  const data = new SignalboxData({ adapters: loadAdapters(), tables: priceTables() });
  process.stdout.write(`${JSON.stringify(await data.fleet(), null, 2)}\n`);
  return 0;
}

async function snapshot(args: SnapshotArgs): Promise<number> {
  const now = new Date();
  const data = new SignalboxData({ adapters: loadAdapters(undefined, { claudeApp: args.claudeApp }), tables: priceTables(), now: () => now });
  const [fleetSnap, report] = await Promise.all([data.fleet(), data.report({ since: calendarSince(args.days, now) })]);
  // After the fleet, so its sessions are the custom commands' project scope and the history's live flags.
  const [commands, history] = await Promise.all([new CommandGuide({ sessions: () => data.recentSessions() }).snapshot(), data.history()]);
  // After the history, so rows that report what it read (the Claude app's list, titles) have their counts.
  const health = await data.health({ maxAgeMs: 0 });
  const out: Snapshot = { v: PROTOCOL_VERSION, generatedAt: now.toISOString(), days: args.days, fleet: fleetSnap, report, health, commands, history };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

async function commands(args: CommandsArgs): Promise<number> {
  const data = new SignalboxData({ adapters: loadAdapters(), tables: [] });
  const snap = filterSnapshot(await new CommandGuide({ sessions: () => data.recentSessions({ full: true }) }).snapshot(), args.agent);
  if (args.json) process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  else console.log(formatCommands(snap, { width: process.stdout.columns, verbose: args.verbose }));
  return 0;
}

async function history(args: HistoryArgs): Promise<number> {
  const now = new Date();
  const data = new SignalboxData({ adapters: loadAdapters(args.agent, { claudeApp: args.claudeApp }), tables: priceTables(), now: () => now });
  const req = { since: args.days ? calendarSince(args.days, now) : undefined, agent: args.agent, limit: args.limit };
  const h = await data.history(req);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(h, null, 2)}\n`);
  } else {
    const noData = (await data.detected(args.agent)).length === 0;
    console.log(
      formatHistory(h, {
        width: process.stdout.columns,
        agentLabel: args.agent ? (findEntry(args.agent)?.displayName ?? args.agent) : "all agents",
        windowLabel: args.days ? (args.days === 1 ? "today" : `last ${args.days} calendar days`) : "every session",
        noData,
      }),
    );
  }
  return 0;
}

/** The watch stream's source: SignalboxData plus the command guide, which takes the fleet's sessions as project scope. */
function watchSource(data: SignalboxData, guide: CommandGuide): WatchSource {
  return {
    fleet: (fresh, opts) => data.fleet(fresh, opts),
    report: (req, fresh) => data.report(req, fresh),
    health: (fresh) => data.health(fresh),
    watchSessions: (onChange) => data.watchSessions(onChange),
    commands: () => guide.snapshot(),
    history: (fresh) => data.history({}, fresh),
  };
}

/** Waits (briefly) for queued stdout to reach the pipe before a hard exit. */
function drainStdout(timeoutMs: number): Promise<void> {
  if (!process.stdout.writableLength) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.stdout.once("drain", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** `watch --ndjson`: see watch.ts for the protocol. Exits 0 on stdin close, SIGINT, SIGTERM, SIGHUP or a closed stdout. */
async function watch(args: WatchArgs): Promise<never> {
  const adapters = loadAdapters(undefined, { claudeApp: args.claudeApp });
  const data = new SignalboxData({ adapters, tables: priceTables(), ...WATCH_CACHE });
  await makeSpoolDirsPrivate(adapters);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    watcher.stop();
    resolveDone();
  };
  const log = debugEnabled(process.env.SIGNALBOX_DEBUG) ? (m: string) => console.error(`signalbox watch: ${m}`) : undefined;
  const guide = new CommandGuide({ sessions: () => data.recentSessions() });
  const watcher = new Watcher({
    source: watchSource(data, guide),
    days: args.days,
    version: VERSION,
    write: (line) => {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        shutdown();
      }
    },
    log,
  });
  // EPIPE: the reader is gone, so is the app.
  process.stdout.on("error", shutdown);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, shutdown);
  // Never die on a bug in one tick: report it and keep streaming.
  process.on("uncaughtException", (err) => watcher.error("protocol", `internal error: ${message(err)}`));
  process.on("unhandledRejection", (err) => watcher.error("protocol", `internal error: ${message(err)}`));
  watcher.start();
  if (log) {
    const modes = adapters.map((la) => `${la.adapter.id}=${la.entry.sessionWatchMode?.(la.adapter) ?? "none"}`);
    log(`status pushes: ${modes.join(" ")}`);
  }
  void (async () => {
    const lines = new LineSplitter();
    try {
      const reader = Bun.stdin.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closing) break;
        for (const line of lines.push(value)) watcher.handleLine(line);
      }
      for (const line of lines.end()) watcher.handleLine(line);
    } catch (err) {
      console.error(`signalbox watch: reading stdin failed: ${message(err)}`);
    }
    shutdown();
  })();
  await done;
  await drainStdout(1000);
  // Scans and child processes may still be running; nobody is listening for their results.
  process.exit(0);
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv, adapterIds(), CATALOG_AGENTS);
    switch (args.command) {
      case "help":
        console.log(helpText(adapterIds(), CATALOG_AGENTS));
        return 0;
      case "version":
        console.log(VERSION);
        return 0;
      case "report":
        return await report(args);
      case "doctor":
        return await doctor(args.json);
      case "serve":
        return await serve(args);
      case "watch":
        return await watch(args);
      case "snapshot":
        return await snapshot(args);
      case "fleet":
        return await fleet();
      case "commands":
        return await commands(args);
      case "history":
        return await history(args);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`signalbox: ${err.message}\nRun "signalbox --help" for usage.`);
      return 2;
    }
    console.error(`signalbox: ${message(err)}`);
    return 1;
  }
}

// Set exitCode instead of calling process.exit(): a hard exit drops whatever stdout still has queued
// for a pipe, which cut `report --json | jq` off at 64-128 KiB.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
