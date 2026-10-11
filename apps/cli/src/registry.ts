// Every agent Signalbox knows about. A new agent plugs in here and nowhere else in the CLI.
import { join } from "node:path";
import { claudeAppSetting, createClaudeAdapter, scanIssues, type ClaudeCodeAdapter } from "@signalbox/adapter-claude";
import { createCodexAdapter, type CodexAdapter } from "@signalbox/adapter-codex";
import type { Adapter, AgentId, ClaudeAppOffReason } from "@signalbox/core";
import { findBinary } from "./binaries.ts";

export interface DataDir {
  label: string;
  path: string;
}

export interface AgentBinary {
  /** Executable name, looked up on PATH and then in the usual install dirs (see binaries.ts). */
  name: string;
  /** Environment variable that overrides the PATH lookup, if the adapter honours one. */
  envVar?: string;
  versionArgs: string[];
}

/** Per-run adapter settings from the command line. */
export interface LoadOptions {
  /**
   * False with --no-claude-app: the Claude Code adapter leaves out the Claude app's session list. Default true,
   * which still leaves it out when CLAUDE_CONFIG_DIR points away from ~/.claude (see claudeAppSetting).
   */
  claudeApp?: boolean;
}

/** What the history took from an app's own session list (HistorySnapshot.sources.claudeApp). */
export interface AppListSource {
  enabled: boolean;
  records: number;
  off?: ClaudeAppOffReason;
}

export interface AdapterEntry<A extends Adapter = Adapter> {
  id: AgentId;
  displayName: string;
  /** The agent's own CLI, for `doctor` version checks. */
  bin?: AgentBinary;
  create(opts?: LoadOptions): A;
  /** Directories and files `doctor` reports on. Paths only; nothing is opened. The first is the agent's home. */
  dataDirs(adapter: A): DataDir[];
  /** Environment variable that moves the agent's home directory, if any. */
  homeEnv?: string;
  /** The tap spool directory, for adapters that read one. */
  spoolDir?(adapter: A): string;
  /** Data the adapter's last completed usage scan had to skip (unreadable files, bad lines), as sentences. */
  scanIssues?(adapter: A): string[];
  /** How the adapter's watchSessions is following changes (e.g. "fs.watch", "poll"), for the debug log. */
  sessionWatchMode?(adapter: A): string | undefined;
  /** The Claude app's session list as the adapter's last listHistory read it, for HistorySnapshot.sources. */
  claudeApp?(adapter: A): AppListSource | undefined;
}

/** Keeps each entry's adapter type through to its own `dataDirs`. */
function entry<A extends Adapter>(e: AdapterEntry<A>): AdapterEntry {
  return e as unknown as AdapterEntry;
}

export const ADAPTERS: readonly AdapterEntry[] = [
  entry<ClaudeCodeAdapter>({
    id: "claude-code",
    displayName: "Claude Code",
    bin: { name: "claude", envVar: "SIGNALBOX_CLAUDE_BIN", versionArgs: ["--version"] },
    // Resolved here rather than by the adapter's own PATH lookup, so a Finder-launched app (bare PATH) still finds claude.
    create: (opts) => {
      const app = claudeAppSetting(opts?.claudeApp !== false);
      return createClaudeAdapter({
        claudeBin: findBinary("claude", { envVar: "SIGNALBOX_CLAUDE_BIN" })?.path,
        ...("dir" in app ? { claudeAppDir: app.dir } : { claudeAppDir: false, claudeAppOff: { reason: app.off, detail: app.detail } }),
      });
    },
    homeEnv: "CLAUDE_CONFIG_DIR",
    dataDirs: (a) => {
      const app = a.claudeAppStatus();
      return [
        { label: "config", path: a.configDir },
        { label: "transcripts", path: join(a.configDir, "projects") },
        { label: "registry", path: join(a.configDir, "sessions") },
        ...(app?.enabled && app.dir ? [{ label: "app sessions", path: app.dir }] : []),
      ];
    },
    spoolDir: (a) => a.spoolDir,
    scanIssues: (a) => {
      const stats = a.lastScanStats();
      return stats ? scanIssues(stats) : [];
    },
    sessionWatchMode: (a) => a.sessionWatchMode(),
    claudeApp: (a) => {
      const st = a.claudeAppStatus();
      if (!st) return undefined;
      return st.off ? { enabled: st.enabled, records: st.records ?? 0, off: st.off } : { enabled: st.enabled, records: st.records ?? 0 };
    },
  }),
  entry<CodexAdapter>({
    id: "codex",
    displayName: "Codex",
    bin: { name: "codex", versionArgs: ["--version"] },
    create: () => createCodexAdapter(),
    homeEnv: "CODEX_HOME",
    sessionWatchMode: () => "poll",
    dataDirs: (a) => [
      { label: "home", path: a.codexHome },
      { label: "rollouts", path: join(a.codexHome, "sessions") },
      { label: "archived", path: join(a.codexHome, "archived_sessions") },
      { label: "session index", path: join(a.codexHome, "session_index.jsonl") },
    ],
  }),
];

/** Agents with a researched data format but no adapter yet. `doctor` only reports their binary. */
export const PLANNED: ReadonlyArray<{ id: AgentId; displayName: string; bin: AgentBinary; doc: string }> = [
  { id: "gemini-cli", displayName: "Gemini CLI", bin: { name: "gemini", versionArgs: ["--version"] }, doc: "docs/adapters/gemini.md" },
];

export function adapterIds(): string[] {
  return ADAPTERS.map((e) => e.id);
}

export function findEntry(id: string): AdapterEntry | undefined {
  return ADAPTERS.find((e) => e.id === id);
}

export interface LoadedAdapter {
  entry: AdapterEntry;
  adapter: Adapter;
}

/** Instantiates every registered adapter, or only `only` when given. */
export function loadAdapters(only?: string, opts: LoadOptions = {}): LoadedAdapter[] {
  return ADAPTERS.filter((e) => !only || e.id === only).map((e) => ({ entry: e, adapter: e.create(opts) }));
}
