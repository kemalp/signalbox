// Hand-rolled argv parsing (no dependencies). Pure: no I/O, so it is unit-tested directly.
import { DEFAULT_HISTORY_LIMIT } from "@signalbox/core";

export type Command = "report" | "doctor" | "serve" | "watch" | "snapshot" | "fleet" | "commands" | "history" | "help" | "version";

export interface ReportArgs {
  command: "report";
  /**
   * Window in days when --since is not given: calendar days (today since local midnight and the
   * days - 1 before it, like watch, snapshot and the web page), or N x 24h with `rolling`.
   */
  days?: number;
  /** --rolling: `days` is N x 24h ending at `until`, like research/cost/cc_cost.py --days N. */
  rolling?: boolean;
  since?: Date;
  /** Exclusive. Default: now. */
  until?: Date;
  agent?: string;
  json: boolean;
  /** Text output also prints the notes and the estimate method. */
  verbose: boolean;
}

export interface ServeArgs {
  command: "serve";
  port: number;
  open: boolean;
}

/** `watch --ndjson` and `snapshot --json`: a calendar-day report window, like the web page. */
export interface WatchArgs {
  command: "watch";
  days: number;
  /** False with --no-claude-app: the history leaves out the Claude app's session list. */
  claudeApp: boolean;
}

export interface SnapshotArgs {
  command: "snapshot";
  days: number;
  /** False with --no-claude-app. */
  claudeApp: boolean;
}

/** `commands`: the command guide (every agent with a catalog, or one). */
export interface CommandsArgs {
  command: "commands";
  json: boolean;
  verbose: boolean;
  agent?: string;
}

/** `history`: past and live sessions with their titles, newest first. */
export interface HistoryArgs {
  command: "history";
  json: boolean;
  /** Sessions with activity in the last N calendar days; undefined is --all (the default). */
  days?: number;
  agent?: string;
  limit: number;
  /** False with --no-claude-app. */
  claudeApp: boolean;
}

export type ParsedArgs =
  | ReportArgs
  | HistoryArgs
  | ServeArgs
  | WatchArgs
  | SnapshotArgs
  | CommandsArgs
  | { command: "fleet" }
  | { command: "doctor"; json: boolean }
  | { command: "help"; topic?: string }
  | { command: "version" };

export class UsageError extends Error {
  override name = "UsageError";
}

const DEFAULT_DAYS = 7;
const MAX_DAYS = 3650;
const MAX_HISTORY_LIMIT = 100_000;
/** The app and the web page offer at most a year (the protocol's 1..365). */
const MAX_CALENDAR_DAYS = 365;

/** `YYYY-MM-DD` is local midnight; anything with a time must be a full ISO-8601 timestamp. */
export function parseDateArg(raw: string, flag: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    // setFullYear, because new Date(y, m, d) maps years 0-99 to 1900-1999.
    const date = new Date(2000, 0, 1);
    date.setFullYear(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      throw new UsageError(`${flag}: not a calendar date: ${raw}`);
    }
    return date;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new UsageError(`${flag}: expected YYYY-MM-DD or an ISO timestamp, got "${raw}"`);
}

function parseIntArg(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag}: expected a whole number, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`${flag}: must be between ${min} and ${max}`);
  return n;
}

/** Splits `--flag=value` and reads `--flag value`, rejecting unknown flags. */
function readFlags(argv: string[], valued: ReadonlySet<string>, boolean: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (out.has(name)) throw new UsageError(`${name} given twice`);
    if (boolean.has(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      out.set(name, "");
    } else if (valued.has(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      out.set(name, value);
    } else {
      throw new UsageError(`unknown option ${name}`);
    }
  }
  return out;
}

/** `catalogAgents`: the agents `commands --agent` accepts (those with a command catalog); default `knownAgents`. */
export function parseArgs(argv: string[], knownAgents: readonly string[], catalogAgents: readonly string[] = knownAgents): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return rest[0] ? { command: "help", topic: rest[0] } : { command: "help" };
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return { command: "version" };
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help", topic: cmd };

  switch (cmd) {
    case "report": {
      const f = readFlags(rest, new Set(["--days", "--since", "--until", "--agent"]), new Set(["--json", "--verbose", "--rolling"]));
      if (f.has("--days") && f.has("--since")) throw new UsageError("use either --days or --since, not both");
      if (f.has("--rolling") && f.has("--since")) throw new UsageError("--rolling applies to --days, not to --since");
      const out: ReportArgs = { command: "report", json: f.has("--json"), verbose: f.has("--verbose") };
      if (f.has("--since")) out.since = parseDateArg(f.get("--since")!, "--since");
      else out.days = f.has("--days") ? parseIntArg(f.get("--days")!, "--days", 1, MAX_DAYS) : DEFAULT_DAYS;
      if (f.has("--rolling")) out.rolling = true;
      if (f.has("--until")) out.until = parseDateArg(f.get("--until")!, "--until");
      if (f.has("--agent")) {
        const agent = f.get("--agent")!;
        if (!knownAgents.includes(agent)) throw new UsageError(`--agent: unknown agent "${agent}" (known: ${knownAgents.join(", ")})`);
        out.agent = agent;
      }
      return out;
    }
    case "doctor": {
      const f = readFlags(rest, new Set(), new Set(["--json"]));
      return { command: "doctor", json: f.has("--json") };
    }
    case "watch": {
      const f = readFlags(rest, new Set(["--days"]), new Set(["--ndjson", "--no-claude-app"]));
      if (!f.has("--ndjson")) throw new UsageError("watch needs --ndjson (the only output format it has)");
      return {
        command: "watch",
        days: f.has("--days") ? parseIntArg(f.get("--days")!, "--days", 1, MAX_CALENDAR_DAYS) : DEFAULT_DAYS,
        claudeApp: !f.has("--no-claude-app"),
      };
    }
    case "snapshot": {
      const f = readFlags(rest, new Set(["--days"]), new Set(["--json", "--no-claude-app"]));
      if (!f.has("--json")) throw new UsageError("snapshot needs --json (the only output format it has)");
      return {
        command: "snapshot",
        days: f.has("--days") ? parseIntArg(f.get("--days")!, "--days", 1, MAX_CALENDAR_DAYS) : DEFAULT_DAYS,
        claudeApp: !f.has("--no-claude-app"),
      };
    }
    case "fleet": {
      const f = readFlags(rest, new Set(), new Set(["--json"]));
      if (!f.has("--json")) throw new UsageError("fleet needs --json (the only output format it has)");
      return { command: "fleet" };
    }
    case "commands": {
      const f = readFlags(rest, new Set(["--agent"]), new Set(["--json", "--verbose"]));
      if (f.has("--json") && f.has("--verbose")) throw new UsageError("use either --json or --verbose, not both");
      const out: CommandsArgs = { command: "commands", json: f.has("--json"), verbose: f.has("--verbose") };
      if (f.has("--agent")) {
        const agent = f.get("--agent")!;
        if (!catalogAgents.includes(agent)) throw new UsageError(`--agent: no command guide for "${agent}" (known: ${catalogAgents.join(", ")})`);
        out.agent = agent;
      }
      return out;
    }
    case "history": {
      const f = readFlags(rest, new Set(["--days", "--agent", "--limit"]), new Set(["--json", "--all", "--no-claude-app"]));
      if (f.has("--days") && f.has("--all")) throw new UsageError("use either --days or --all, not both");
      const out: HistoryArgs = {
        command: "history",
        json: f.has("--json"),
        limit: f.has("--limit") ? parseIntArg(f.get("--limit")!, "--limit", 1, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT,
        claudeApp: !f.has("--no-claude-app"),
      };
      if (f.has("--days")) out.days = parseIntArg(f.get("--days")!, "--days", 1, MAX_DAYS);
      if (f.has("--agent")) {
        const agent = f.get("--agent")!;
        if (!knownAgents.includes(agent)) throw new UsageError(`--agent: unknown agent "${agent}" (known: ${knownAgents.join(", ")})`);
        out.agent = agent;
      }
      return out;
    }
    case "serve": {
      const f = readFlags(rest, new Set(["--port"]), new Set(["--no-open"]));
      return {
        command: "serve",
        port: f.has("--port") ? parseIntArg(f.get("--port")!, "--port", 0, 65535) : 0,
        open: !f.has("--no-open"),
      };
    }
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

/**
 * The [since, until) window of a report command. `until` defaults to `now`. `--days N` is N calendar
 * days ending with the day `until` falls in (or, when `until` is exactly local midnight, the N days
 * before it); with `--rolling` it is N x 24h ending at `until`.
 */
export function reportWindow(a: ReportArgs, now: Date): { since: Date; until: Date } {
  const until = a.until ?? now;
  if (a.since === undefined) {
    const days = a.days ?? DEFAULT_DAYS;
    const since = a.rolling ? new Date(until.getTime() - days * 86_400_000) : calendarSince(days, new Date(until.getTime() - 1));
    return { since, until };
  }
  const since = a.since;
  if (since.getTime() >= until.getTime()) {
    throw new UsageError(a.until ? "the window is empty: --since must be before --until" : "--since is in the future");
  }
  if (until.getTime() - since.getTime() > MAX_DAYS * 86_400_000) {
    throw new UsageError(`the window is longer than ${MAX_DAYS} days; use a later --since`);
  }
  return { since, until };
}

/** How the text report names its window: "today", "7 calendar days", "rolling 7 x 24h"; undefined for --since. */
export function reportWindowLabel(a: ReportArgs): string | undefined {
  if (a.since !== undefined) return undefined;
  const days = a.days ?? DEFAULT_DAYS;
  if (a.rolling) return `rolling ${days} x 24h`;
  if (days === 1) return a.until ? "1 calendar day" : "today";
  return `${days} calendar days`;
}

/** Local midnight `days - 1` days before `now`: the web's "Today" / 7d / 30d are calendar days. */
export function calendarSince(days: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

export function helpText(agents: readonly string[], catalogAgents: readonly string[] = agents): string {
  return `signalbox: a local control room for AI coding agents (read-only, nothing leaves this machine)

Usage:
  signalbox report [--days N [--rolling] | --since DATE] [--until DATE] [--agent ID]
                   [--verbose | --json]
  signalbox doctor [--json]
  signalbox serve [--port N] [--no-open]
  signalbox watch --ndjson [--days N] [--no-claude-app]
  signalbox snapshot --json [--days N] [--no-claude-app]
  signalbox fleet --json
  signalbox commands [--agent ID] [--verbose | --json]
  signalbox history [--days N | --all] [--agent ID] [--limit N] [--no-claude-app] [--json]

report   Usage and list-price-equivalent dollars from local transcripts.
         --days N      N calendar days: today since local midnight and the N-1 days
                       before it (default 7; 1 = today), like watch, snapshot and the page
         --rolling     with --days: N x 24h ending at --until instead (like cc_cost.py)
         --since DATE  YYYY-MM-DD (local midnight) or an ISO timestamp
         --until DATE  exclusive end of the window (default: now)
         --agent ID    only one agent (${agents.join(", ")})
         --verbose     also print the notes and how the estimate is calculated
         --json        print the full report as JSON (the /api/report shape)
doctor   Versions, data sources and their stability, price tables, tap spool, warnings.
serve    Start the local page on 127.0.0.1 and open it in the browser.
         --port N      fixed port (default: random)
         --no-open     print the URL only
watch    Stream fleet, report, health, the command guide and the session history as JSON
         lines on stdout (protocol v1, for the macOS app). Reads {"cmd":"report","days":N} and
         {"cmd":"refresh"} lines on stdin; exits when stdin closes.
         --days N      report window in calendar days, 1-365 (default 7; 1 = today)
         --no-claude-app  the history leaves out the Claude app's session list (see history)
snapshot Print one JSON object: {v, generatedAt, days, fleet, report, health, commands, history}.
         --days N      report window in calendar days, 1-365 (default 7; 1 = today)
         --no-claude-app  the history leaves out the Claude app's session list (see history)
fleet    Print live sessions, limits, context and compactions as JSON (the /api/fleet shape).
commands What each agent's slash commands and shell commands do, which ones Signalbox already
         shows, and the custom commands, skills and plugin commands found on this machine
         (names and descriptions only; project ones for the folders of recent sessions).
         --agent ID    only one agent (${catalogAgents.join(", ")})
         --verbose     also print each command's details and side effects
         --json        {v, generatedAt, installed, catalogs, custom} (also a watch line)
history  Past and live sessions, newest first, like the Claude app's session list: title,
         project, duration and list-price $. Sessions come from transcripts and from the
         Claude app's own list (read-only; its title wins; a session it lists without a
         transcript has no figures). Titles only, never prompts or message text.
         --days N      sessions with activity in the last N calendar days (default: --all)
         --all         every session on this machine
         --agent ID    only one agent (${agents.join(", ")})
         --limit N     at most N sessions (default ${DEFAULT_HISTORY_LIMIT})
         --no-claude-app  sessions with a transcript only, with the titles the transcripts hold
         --json        {v, generatedAt, entries, total, truncated, sources} (also a watch line)

Environment: CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME (agent homes); SIGNALBOX_CLAUDE_BIN
(the claude binary; otherwise PATH, then ~/.local/bin, ~/.claude/local, ~/.bun/bin, Homebrew,
nvm, volta, asdf); SIGNALBOX_PRICING_DIR (price tables to use instead of the built-in ones);
SIGNALBOX_CLAUDE_APP_DIR (the Claude app's session list, read-only; default
~/Library/Application Support/Claude/claude-code-sessions); SIGNALBOX_CLAUDE_APP_TRACE=1 (one
stderr line per path the Claude app reader lists, stats or opens, to audit a run).

Dollar figures are list-price equivalents, not a bill.`;
}
