// Live sessions: `claude agents --json --all` (preview) merged with the session registry
// <configDir>/sessions/<pid>.json (internal). The registry dir also holds `<pid>.<hash>.key`
// files, which are credential material: only names matching REGISTRY_FILE are ever opened.
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { SessionInfo, SessionStatus } from "../../core/src/index.ts";
import { errCode, isObj, label, num, str, toIso } from "./util.ts";

export const REGISTRY_FILE = /^\d+\.json$/;

export function isRegistryFileName(name: string): boolean {
  return REGISTRY_FILE.test(name);
}

export interface RegistryEntry {
  file: string;
  pid?: number;
  pidDomain?: string;
  sessionId?: string;
  cwd?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  name?: string;
  status?: string;
  /** Claude Code's label for what a waiting session waits for, e.g. "permission prompt" (see `label`). */
  waitingFor?: string;
  statusUpdatedAt?: string;
  startedAt?: string;
  updatedAt?: string;
}

export function parseRegistryEntry(d: unknown, file: string): RegistryEntry | undefined {
  if (!isObj(d)) return undefined;
  const e: RegistryEntry = { file };
  const pid = num(d.pid);
  if (pid !== undefined && Number.isInteger(pid) && pid > 0) e.pid = pid;
  const strings = ["pidDomain", "sessionId", "cwd", "kind", "entrypoint", "version", "name", "status"] as const;
  for (const k of strings) {
    const v = str(d[k]);
    if (v !== undefined) e[k] = v;
  }
  const waitingFor = label(d.waitingFor);
  if (waitingFor !== undefined) e.waitingFor = waitingFor;
  const times = ["statusUpdatedAt", "startedAt", "updatedAt"] as const;
  for (const k of times) {
    const v = toIso(d[k]);
    if (v !== undefined) e[k] = v;
  }
  return e;
}

export interface RegistryRead {
  dirExists: boolean;
  entries: RegistryEntry[];
  /** Registry files that failed to read or parse (often mid-write). */
  errors: number;
}

export async function readRegistry(sessionsDir: string): Promise<RegistryRead> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return { dirExists: false, entries: [], errors: 0 };
  }
  const entries: RegistryEntry[] = [];
  let errors = 0;
  for (const name of names.filter(isRegistryFileName).sort()) {
    try {
      const e = parseRegistryEntry(JSON.parse(await Bun.file(join(sessionsDir, name)).text()), name);
      if (e) entries.push(e);
      else errors++;
    } catch {
      errors++;
    }
  }
  return { dirExists: true, entries, errors };
}

/** true = alive, false = gone, undefined = can't tell (pid from another pid domain). */
export function isPidAlive(pid: number, pidDomain?: string): boolean | undefined {
  if (pidDomain && pidDomain !== process.platform) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = errCode(e);
    if (code === "EPERM") return true; // exists, owned by someone else
    if (code === "ESRCH") return false;
    return undefined;
  }
}

/** Status words from agents --json (`status` for interactive, `state` for background) and the registry. */
export function mapStatus(s: string | undefined): SessionStatus {
  switch (s) {
    case "busy":
    case "running":
      return "busy";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    case "ended":
    case "exited":
    case "stopped":
    case "completed":
    case "failed":
    case "killed":
    case "cancelled":
    case "canceled":
      return "ended";
    default:
      return "unknown";
  }
}

export interface AgentsEntry {
  sessionId?: string;
  /** Background sessions carry `id` (and `state`) instead of `pid` (and `status`). */
  id?: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  startedAt?: string;
}

/**
 * Parses `claude agents --json` output (verified keys: pid|id, cwd, kind, startedAt, sessionId, name,
 * status|state, and waitingFor on a waiting session, which it copies from the registry).
 */
export function parseAgentsJson(v: unknown): AgentsEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AgentsEntry[] = [];
  for (const d of v) {
    if (!isObj(d)) continue;
    const e: AgentsEntry = {};
    const sid = str(d.sessionId);
    if (sid) e.sessionId = sid;
    const id = str(d.id);
    if (id) e.id = id;
    const pid = num(d.pid);
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) e.pid = pid;
    for (const k of ["cwd", "kind", "name"] as const) {
      const s = str(d[k]);
      if (s) e[k] = s;
    }
    const status = str(d.status) ?? str(d.state);
    if (status) e.status = status;
    const waitingFor = label(d.waitingFor);
    if (waitingFor) e.waitingFor = waitingFor;
    const started = toIso(d.startedAt);
    if (started) e.startedAt = started;
    if (!e.sessionId && !e.id && e.pid === undefined) continue;
    out.push(e);
  }
  return out;
}

export type AgentsRun =
  | { ok: true; entries: AgentsEntry[]; bin: string; ms: number; /** When the child was started (epoch ms). */ at: number }
  | { ok: false; reason: string; bin?: string; /** Deliberately not run (nothing to list), not a failure. */ skipped?: true };

/**
 * Puts the binary's own directory on the child's PATH when it is missing (a Finder-launched app
 * gets PATH=/usr/bin:/bin:...), so an npm-installed `claude` (`#!/usr/bin/env node`) in an nvm or
 * Homebrew bin dir finds the node installed next to it.
 */
export function withBinDirOnPath(bin: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!isAbsolute(bin)) return env;
  const dir = dirname(bin);
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return parts.includes(dir) ? env : { ...env, PATH: [dir, ...parts].join(delimiter) };
}

function spawnAgents(bin: string, env: Record<string, string | undefined>) {
  return Bun.spawn([bin, "agents", "--json", "--all"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    cwd: homedir(),
    env: withBinDirOnPath(bin, env),
  });
}

/** Runs `<bin> agents --json --all` with an argv array (never a shell) and a hard timeout. */
export async function runAgentsJson(
  bin: string | undefined,
  opts: { timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<AgentsRun> {
  if (!bin) return { ok: false, reason: "claude binary not found (set SIGNALBOX_CLAUDE_BIN)" };
  const at = Date.now();
  const started = performance.now();
  let proc: ReturnType<typeof spawnAgents>;
  try {
    proc = spawnAgents(bin, opts.env ?? process.env);
  } catch (e) {
    return { ok: false, reason: `could not start ${bin} (${errCode(e)})`, bin };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), proc.exited]),
      timeout,
    ]);
    if (result === "timeout") {
      proc.kill();
      return { ok: false, reason: `timed out after ${opts.timeoutMs} ms`, bin };
    }
    const [text, code] = result;
    if (code !== 0) return { ok: false, reason: `exited with code ${code}`, bin };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "output was not valid JSON", bin };
    }
    const entries = parseAgentsJson(parsed);
    if (!entries) return { ok: false, reason: "output was not a JSON array", bin };
    return { ok: true, entries, bin, ms: Math.round(performance.now() - started), at };
  } catch (e) {
    return { ok: false, reason: `failed (${errCode(e)})`, bin };
  } finally {
    clearTimeout(timer);
  }
}

/** true = alive, false = gone, undefined = can't tell. */
export type PidCheck = (pid: number, pidDomain?: string) => boolean | undefined;

export interface MergeOptions {
  /**
   * When the agents --json run started (epoch ms). A registry row written after it is newer than the
   * run: its status wins, and a session the run did not list is new rather than suspect.
   */
  agentsAt?: number;
}

function latestMs(...isos: Array<string | undefined>): number {
  let best = -Infinity;
  for (const s of isos) {
    const t = s ? Date.parse(s) : NaN;
    if (t > best) best = t;
  }
  return best;
}

/**
 * Merges agents --json with the registry (entrypoint, version, statusUpdatedAt and the newest status,
 * which agents --json copies from it when it runs). agents --json wins for status unless the registry
 * row changed after the run started (`agentsAt`), so a cached run plus a fresh registry read gives the
 * current status without spawning claude. Registry-only rows get their liveness from the pid.
 */
export function mergeSessions(
  agents: AgentsEntry[] | undefined,
  registry: RegistryEntry[],
  alive: PidCheck,
  opts: MergeOptions = {},
): SessionInfo[] {
  const out = new Map<string, SessionInfo>();
  for (const a of agents ?? []) {
    const sessionId = a.sessionId ?? a.id ?? `pid:${a.pid}`;
    const s: SessionInfo = { agent: "claude-code", sessionId, status: mapStatus(a.status), source: "agents --json" };
    if (a.pid !== undefined) s.pid = a.pid;
    if (a.cwd) s.cwd = a.cwd;
    if (a.name) s.name = a.name;
    if (a.kind) s.kind = a.kind;
    if (a.startedAt) s.startedAt = a.startedAt;
    if (a.waitingFor && s.status === "waiting") s.waitingFor = a.waitingFor;
    out.set(sessionId, s);
  }
  const inRegistry = new Set<string>();
  for (const r of registry) {
    const sessionId = r.sessionId ?? (r.pid !== undefined ? `pid:${r.pid}` : `registry:${r.file}`);
    inRegistry.add(sessionId);
    const regStatus = mapStatus(r.status);
    const existing = out.get(sessionId);
    if (existing) {
      existing.source = "agents --json+registry";
      if (existing.pid === undefined && r.pid !== undefined) existing.pid = r.pid;
      if (!existing.cwd && r.cwd) existing.cwd = r.cwd;
      if (!existing.name && r.name) existing.name = r.name;
      if (!existing.kind && r.kind) existing.kind = r.kind;
      if (!existing.startedAt && r.startedAt) existing.startedAt = r.startedAt;
      if (r.entrypoint) existing.entrypoint = r.entrypoint;
      if (r.version) existing.version = r.version;
      const newer = opts.agentsAt !== undefined && latestMs(r.statusUpdatedAt) > opts.agentsAt;
      if (newer && regStatus !== "unknown" && regStatus !== existing.status) {
        existing.status = regStatus;
        delete existing.waitingFor;
      }
      if (r.statusUpdatedAt && regStatus === existing.status) existing.statusSince = r.statusUpdatedAt;
      if (r.waitingFor && regStatus === "waiting" && existing.status === "waiting") existing.waitingFor = r.waitingFor;
      if (r.updatedAt) existing.lastActivity = r.updatedAt;
      continue;
    }
    const live = r.pid !== undefined ? alive(r.pid, r.pidDomain) : undefined;
    // A live-looking pid that a successful agents --json run did not list is either a race with a
    // new registry file or a reused pid: report "unknown" rather than trust the stale status. A file
    // written after the run started is simply newer than the run.
    const newerThanRun = opts.agentsAt !== undefined && latestMs(r.startedAt, r.updatedAt, r.statusUpdatedAt) > opts.agentsAt;
    const status: SessionStatus = live === false ? "ended" : agents && !newerThanRun ? "unknown" : regStatus;
    const s: SessionInfo = { agent: "claude-code", sessionId, status, source: "registry" };
    if (r.pid !== undefined) s.pid = r.pid;
    if (r.cwd) s.cwd = r.cwd;
    if (r.name) s.name = r.name;
    if (r.kind) s.kind = r.kind;
    if (r.entrypoint) s.entrypoint = r.entrypoint;
    if (r.version) s.version = r.version;
    if (r.startedAt) s.startedAt = r.startedAt;
    if (r.updatedAt) s.lastActivity = r.updatedAt;
    if (status === regStatus && r.statusUpdatedAt) s.statusSince = r.statusUpdatedAt;
    if (status === "waiting" && r.waitingFor) s.waitingFor = r.waitingFor;
    out.set(sessionId, s);
  }
  // A listed process whose registry file is gone and whose pid has exited ended after the run (its
  // file is removed on exit); a cached run would otherwise keep showing it as live.
  for (const [sessionId, s] of out) {
    if (inRegistry.has(sessionId) || s.pid === undefined || s.status === "ended") continue;
    if (alive(s.pid) === false) {
      s.status = "ended";
      delete s.waitingFor;
      delete s.statusSince;
    }
  }
  return [...out.values()];
}
