// Finds agent CLIs (claude, codex, gemini). A Finder-launched app hands its children
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a PATH lookup alone misses every usual install location.
// Order: the override variable, PATH, then the fallback directories below. Only stat() is used.
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** Replaces the built-in fallback directories (colon-separated; empty disables them). For tests and odd setups. */
export const BIN_DIRS_ENV = "SIGNALBOX_BIN_DIRS";

export const SYSTEM_BIN_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface FoundBinary {
  path: string;
  /** Where it came from: the override variable's name, "PATH", or the fallback directory. */
  via: string;
}

export interface DiscoveryOptions {
  /** Environment variable whose value is used as-is when set (even if it points nowhere: the user asked for it). */
  envVar?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Default: /opt/homebrew/bin and /usr/local/bin. */
  systemDirs?: readonly string[];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** "v22.11.0" → [22, 11, 0]; anything else → undefined. */
function nodeVersion(name: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** `<nvm>/versions/node/*` bin directories, highest version first. */
export function nvmBinDirs(nvmDir: string): string[] {
  const root = join(nvmDir, "versions", "node");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, v: nodeVersion(n) }))
    .filter((x): x is { n: string; v: number[] } => x.v !== undefined)
    .sort((a, b) => b.v[0]! - a.v[0]! || b.v[1]! - a.v[1]! || b.v[2]! - a.v[2]!)
    .map((x) => join(root, x.n, "bin"));
}

/**
 * The directories searched after PATH, in order: ~/.local/bin, ~/.claude/local, ~/.bun/bin,
 * /opt/homebrew/bin, /usr/local/bin, the nvm node versions (highest first), ~/.volta/bin,
 * ~/.asdf/shims. $SIGNALBOX_BIN_DIRS replaces the list.
 */
export function fallbackDirs(opts: Omit<DiscoveryOptions, "envVar"> = {}): string[] {
  const env = opts.env ?? process.env;
  const override = env[BIN_DIRS_ENV];
  if (override !== undefined) return override.split(delimiter).filter((d) => d !== "" && isAbsolute(d));
  const home = opts.home ?? homedir();
  const homeDirs = (...rel: string[]) => (home ? rel.map((r) => join(home, r)) : []);
  return [
    ...homeDirs(".local/bin", ".claude/local", ".bun/bin"),
    ...(opts.systemDirs ?? SYSTEM_BIN_DIRS),
    ...(home || env.NVM_DIR ? nvmBinDirs(env.NVM_DIR || join(home, ".nvm")) : []),
    ...homeDirs(".volta/bin", ".asdf/shims"),
  ];
}

/** Locates `name`: the override variable, then PATH, then {@link fallbackDirs}. Undefined when nowhere. */
export function findBinary(name: string, opts: DiscoveryOptions = {}): FoundBinary | undefined {
  const env = opts.env ?? process.env;
  const override = opts.envVar ? env[opts.envVar] : undefined;
  if (override) return { path: override, via: opts.envVar! };
  const onPath = env.PATH ? Bun.which(name, { PATH: env.PATH }) : null;
  if (onPath) return { path: onPath, via: "PATH" };
  for (const dir of fallbackDirs(opts)) {
    const p = join(dir, name);
    if (isExecutableFile(p)) return { path: p, via: dir };
  }
  return undefined;
}

/**
 * The environment for running a found binary: when its directory is not on PATH it goes first, so
 * a `#!/usr/bin/env node` script from an nvm or Homebrew bin dir finds the node next to it.
 */
export function envForBinary(path: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!isAbsolute(path)) return env;
  const dir = dirname(path);
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (parts.includes(dir)) return env;
  return { ...env, PATH: [dir, ...parts].join(delimiter) };
}
