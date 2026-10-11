// The command guide: each agent's researched command catalog (embedded), the installed agent versions
// and the custom commands found on disk. `signalbox commands` prints it; the watch stream sends it as
// its "commands" line. Read-only: versions come from `<agent> --version`, nothing else is run.
import { stat } from "node:fs/promises";
import { EMBEDDED_COMMAND_CATALOG_FILES, embeddedCommandCatalogs, type CommandCatalog, type CommandEntry, type CommandsSnapshot, type SessionInfo } from "@signalbox/core";
import { findBinary } from "./binaries.ts";
import { discoverCustomCommands, type DiscoveryLimits } from "./custom-commands.ts";
import { agentVersion } from "./doctor.ts";
import { ADAPTERS, PLANNED, type AgentBinary } from "./registry.ts";

/** The agents that have a command catalog, from the embedded file names. */
export const CATALOG_AGENTS: readonly string[] = EMBEDDED_COMMAND_CATALOG_FILES.map((f) => f.replace(/\.json$/, ""));

/** Every agent CLI Signalbox knows, with or without an adapter. */
export function agentBinaries(): Array<{ agent: string; bin: AgentBinary }> {
  return [
    ...ADAPTERS.flatMap((e) => (e.bin ? [{ agent: e.id, bin: e.bin }] : [])),
    ...PLANNED.map((p) => ({ agent: p.id, bin: p.bin })),
  ];
}

/** "2.1.293 (Claude Code)", "codex-cli 0.161.0" → the version number; undefined when there is none. */
export function parseVersion(output: string | undefined): string | undefined {
  return output ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0] : undefined;
}

export interface CommandGuideOptions {
  /** Sessions whose cwds are the project scope for custom commands. */
  sessions(): Promise<SessionInfo[]>;
  env?: Record<string, string | undefined>;
  home?: string;
  bins?: Array<{ agent: string; bin: AgentBinary }>;
  limits?: Partial<DiscoveryLimits>;
  now?: () => Date;
}

/**
 * Builds CommandsSnapshot objects. An agent's version is read once per binary: `--version` runs again
 * only when the binary's path, size or mtime changes (an update), or when the last attempt failed.
 */
export class CommandGuide {
  private catalogs?: CommandCatalog[];
  private readonly versions = new Map<string, { key: string; version: string }>();
  private inflight?: Promise<CommandsSnapshot>;

  constructor(private readonly opts: CommandGuideOptions) {}

  /** One snapshot; concurrent callers share the one being built. */
  snapshot(): Promise<CommandsSnapshot> {
    this.inflight ??= this.build().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async build(): Promise<CommandsSnapshot> {
    this.catalogs ??= embeddedCommandCatalogs();
    const [installed, sessions] = await Promise.all([this.installed(), this.opts.sessions().catch(() => [] as SessionInfo[])]);
    const projects = sessions.map((s) => s.cwd).filter((c): c is string => typeof c === "string" && c !== "");
    const custom = await discoverCustomCommands({ env: this.opts.env, home: this.opts.home, projects, limits: this.opts.limits });
    return {
      v: 1,
      generatedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      installed,
      catalogs: structuredClone(this.catalogs),
      custom,
    };
  }

  /** agent id → installed version, for every agent whose CLI is found and answers `--version`. */
  async installed(): Promise<Record<string, string>> {
    const env = this.opts.env ?? process.env;
    const found = await Promise.all(
      (this.opts.bins ?? agentBinaries()).map(async ({ agent, bin }) => {
        const where = findBinary(bin.name, { envVar: bin.envVar, env, home: this.opts.home });
        if (!where) return undefined;
        const st = await stat(where.path).catch(() => undefined);
        if (!st?.isFile()) return undefined;
        const key = `${where.path}|${st.size}|${st.mtimeMs}`;
        const cached = this.versions.get(agent);
        if (cached?.key === key) return [agent, cached.version] as const;
        const version = parseVersion((await agentVersion(bin, env, this.opts.home)).version);
        if (!version) {
          this.versions.delete(agent);
          return undefined;
        }
        this.versions.set(agent, { key, version });
        return [agent, version] as const;
      }),
    );
    const out: Record<string, string> = {};
    for (const f of found) if (f) out[f[0]] = f[1];
    return out;
  }
}

/** Keeps only `agent`'s catalog and custom commands. */
export function filterSnapshot(snap: CommandsSnapshot, agent: string | undefined): CommandsSnapshot {
  if (!agent) return snap;
  const installed: CommandsSnapshot["installed"] = {};
  if (snap.installed[agent] !== undefined) installed[agent] = snap.installed[agent];
  return { ...snap, installed, catalogs: snap.catalogs.filter((c) => c.agent === agent), custom: snap.custom.filter((c) => c.agent === agent) };
}

// ---------- Text output ----------

const VIEW_LABEL: Record<string, string> = { sessions: "Sessions", usage: "Usage", limits: "Limits", health: "Health" };

function tag(e: CommandEntry): string {
  switch (e.signalbox.status) {
    case "view":
      return e.signalbox.view ? `[Signalbox: ${VIEW_LABEL[e.signalbox.view] ?? e.signalbox.view}]` : "[Signalbox shows this]";
    case "planned":
      return "[planned]";
    case "never":
      return "[not offered]";
    default:
      return "";
  }
}

/** Cuts a line to `n` columns, ending it with "…". */
function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

function rows(entries: CommandEntry[], width: number, verbose: boolean): string[] {
  const label = (e: CommandEntry) => (e.args ? `${e.name} ${e.args}` : e.name);
  const col = Math.min(30, Math.max(...entries.map((e) => label(e).length), 8));
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = label(e);
    const t = tag(e);
    // The summary gives way to the tag when the line is too long.
    const text = `${clip(e.summary, width - col - 4 - (t ? t.length + 1 : 0))}${t ? ` ${t}` : ""}`;
    if (name.length > col) out.push(clip(`  ${name}`, width), `  ${" ".repeat(col)}  ${text}`);
    else out.push(`  ${name.padEnd(col)}  ${text}`);
    if (verbose) {
      const pad = " ".repeat(col + 4);
      if (e.aliases?.length) out.push(clip(`${pad}aliases: ${e.aliases.join(", ")}`, width));
      if (e.details) out.push(...wrapText(e.details, width - pad.length).map((l) => pad + l));
      if (e.sideEffects) out.push(...wrapText(`Side effects: ${e.sideEffects}`, width - pad.length).map((l) => pad + l));
      out.push(...wrapText(`Signalbox: ${e.signalbox.note}`, width - pad.length).map((l) => pad + l));
    }
  }
  return out;
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(40, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > w) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The human-readable guide: per agent, its slash commands, shell commands and custom commands. No `width`: lines aren't cut. */
export function formatCommands(snap: CommandsSnapshot, opts: { width?: number; verbose?: boolean } = {}): string {
  const width = opts.width ? Math.max(60, opts.width) : Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (const cat of snap.catalogs) {
    const installed = snap.installed[cat.agent];
    const drift = installed && installed !== cat.verifiedVersion ? ` (this guide was checked on ${cat.verifiedVersion}; some commands may differ)` : "";
    out.push(...wrapText(`${cat.displayName}: ${installed ? `${installed} installed` : "not found on this machine"}${drift}. Guide as of ${cat.asOf}.`, width), "");
    out.push(`Slash commands (${cat.commands.length})`, ...rows(cat.commands, width, opts.verbose === true), "");
    if (cat.cliCommands.length) out.push(`Shell commands (${cat.cliCommands.length})`, ...rows(cat.cliCommands, width, opts.verbose === true), "");
    const custom = snap.custom.filter((c) => c.agent === cat.agent);
    if (custom.length) {
      out.push(`Custom commands (${custom.length})`);
      const col = Math.min(30, Math.max(...custom.map((c) => c.name.length), 8));
      for (const c of custom) {
        let where = c.scope === "plugin" ? `plugin ${c.source}` : c.scope === "project" ? `project ${c.project ?? ""}` : "user";
        // Codex deprecated custom prompts for skills, and recent Codex CLI releases don't load them.
        if (c.agent === "codex" && c.kind === "prompt") where += ", legacy prompt";
        out.push(clip(`  ${c.name.padEnd(col)}  ${c.description ?? "(no description)"} [${where}]`, width));
      }
      out.push("");
    }
  }
  out.push("[Signalbox: …] Signalbox already shows this. [planned] Signalbox may run it for you later. [not offered] deliberately left to the agent.");
  out.push("Everything else: copy the command and run it in the session. --verbose adds details; --json prints the full guide.");
  return out.join("\n");
}
