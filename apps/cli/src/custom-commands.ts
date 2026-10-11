// Custom slash commands, skills and prompts found on disk, for the command guide. Names and descriptions
// only: a Markdown file is read up to the end of its frontmatter block (in 4 KB steps, at most 64 KB), a
// TOML file (Gemini CLI) is parsed whole but only `description` is kept, and nothing over 256 KB is
// opened. Credential files (exact names: auth.json, .credentials*, .env*, *.key, *.pem, …) are never
// opened, and inside Gemini CLI's .gemini folders nothing with "token", "oauth" or "credential" in its name
// is (Gemini keeps its OAuth tokens there). Command, skill and plugin names that merely contain such a word
// elsewhere are listed: only SKILL.md, *.md and *.toml files and plugin manifests are ever opened, and only
// their frontmatter or description is kept. Hidden entries are skipped, and a symlink that leads
// outside the folder being scanned is ignored, with one exception: in the user's own folders (e.g.
// ~/.claude/skills) a symlink may lead anywhere inside the home folder, because linking skills from
// ~/.agents/skills or a dotfiles repo is common (see USER_SYMLINKS_WITHIN_HOME). Project folders (cloned
// repos) and plugin folders get no such exception. Settings files are not read either (they can hold secrets
// in `env`), so plugin enablement and per-skill "disabled" switches are not applied: an installed plugin
// is listed as if it were enabled.
//
// Project scope is only ever the cwds the caller passes (the fleet's live and recent sessions).
import { constants, type Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  cleanCommandName,
  cleanDescription,
  frontmatterOfWhole,
  geminiSegment,
  geminiSkillName,
  isFalse,
  parseFrontmatter,
  splitFrontmatter,
  tomlCommandInfo,
  type AgentId,
  type CustomCommand,
} from "@signalbox/core";
import { tildify } from "./format.ts";

export const DISCOVERY_LIMITS = {
  /** Larger files are never opened for reading. */
  maxFileBytes: 256 * 1024,
  /** A frontmatter block that hasn't closed by then counts as none. */
  frontmatterMaxBytes: 64 * 1024,
  chunkBytes: 4096,
  /** Folder levels below a scan root. */
  maxDepth: 6,
  maxDirsPerRoot: 2000,
  maxFilesPerRoot: 1000,
  maxProjects: 64,
  maxEntries: 5000,
} as const;

export type DiscoveryLimits = { -readonly [K in keyof typeof DISCOVERY_LIMITS]: number };

/**
 * In user-scope folders, follow symlinks whose target is anywhere inside the home folder (not just inside
 * the folder being scanned). Claude Code users often link ~/.claude/skills/<name> to ~/.agents/skills/<name>;
 * without this those skills would be missing from the guide.
 */
export const USER_SYMLINKS_WITHIN_HOME = true;

/**
 * File and folder names never opened or descended into, anywhere: credential stores, keys, certificates, env
 * files, and names that are nothing but a secret word ("secrets.md", "api_key.json"). Exact names and
 * extensions only, so /author-tools, /count-tokens or a plugin called github-auth are still listed.
 */
const CREDENTIAL_FILE =
  /^\.credentials|^\.env|^auth\.json$|^oauth_creds\.json$|^google_accounts\.json$|\.(key|pem|p12|pfx|keychain|keychain-db)$|^id_(rsa|dsa|ecdsa|ed25519)$|^(api[-_]?keys?|secrets?|passwords?|tokens?|credentials?)(\.[A-Za-z0-9]+)?$/i;

/** Inside a .gemini folder the hard rule is wider: any name with one of these words is skipped. */
const GEMINI_CREDENTIAL_WORD = /token|oauth|credential/i;

export function isCredentialFile(name: string): boolean {
  return CREDENTIAL_FILE.test(name);
}

/** A name skipped inside a .gemini folder (a credential file, or any name with token, oauth or credential). */
export function isGeminiCredentialName(name: string): boolean {
  return CREDENTIAL_FILE.test(name) || GEMINI_CREDENTIAL_WORD.test(name);
}

/** Folders a symlinked command or skill must never lead into (keys, cloud and cluster credentials, keychains). */
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "Keychains"]);

/**
 * Whether a path is refused: a credential file, anything inside a secret folder, and inside any .gemini
 * folder the wider rule.
 */
function refusedPath(path: string): boolean {
  const name = basename(path);
  if (isCredentialFile(name)) return true;
  const segments = path.split(sep);
  if (segments.some((s) => SECRET_DIRS.has(s))) return true;
  return segments.includes(".gemini") && GEMINI_CREDENTIAL_WORD.test(name);
}

export interface DiscoveryOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Session cwds (absolute). Anything else is ignored. */
  projects?: readonly string[];
  limits?: Partial<DiscoveryLimits>;
}

/** Every custom command of every agent, sorted by agent and name. Never throws. */
export async function discoverCustomCommands(opts: DiscoveryOptions = {}): Promise<CustomCommand[]> {
  const env = opts.env ?? process.env;
  const home = resolve(opts.home ?? homedir());
  const ctx = new Ctx(home, { ...DISCOVERY_LIMITS, ...opts.limits });
  const projects = await existingDirs(projectList(opts.projects ?? [], ctx.limits.maxProjects));
  const parts = await Promise.all([
    quiet(discoverClaude(ctx, env.CLAUDE_CONFIG_DIR || join(home, ".claude"), projects)),
    quiet(discoverCodex(ctx, env.CODEX_HOME?.trim() ? expandHome(env.CODEX_HOME.trim(), home) : join(home, ".codex"), projects)),
    quiet(discoverGemini(ctx, env.GEMINI_CLI_HOME || home, projects)),
  ]);
  return finish(parts.flat(), ctx.limits.maxEntries);
}

/** `~` and `~/x` against `home` (like the agents read $CODEX_HOME); anything else as given. */
function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  return raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
}

/** Distinct absolute cwds, at most `max`. */
export function projectList(cwds: readonly string[], max: number): string[] {
  const out = new Set<string>();
  for (const c of cwds) {
    if (typeof c !== "string" || !isAbsolute(c)) continue;
    out.add(resolve(c));
    if (out.size >= max) break;
  }
  return [...out].sort();
}

/** The cwds that still exist (a finished session's folder may be gone; its parents are then not walked). */
async function existingDirs(dirs: string[]): Promise<string[]> {
  const ok = await Promise.all(dirs.map((d) => stat(d).then((s) => s.isDirectory(), () => false)));
  return dirs.filter((_, i) => ok[i]);
}

async function quiet(p: Promise<CustomCommand[]>): Promise<CustomCommand[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

const SCOPE_ORDER = { project: 0, user: 1, plugin: 2 } as const;

/** Drops exact repeats (a plugin installed twice, a folder reached from two cwds) and sorts. */
function finish(list: CustomCommand[], max: number): CustomCommand[] {
  const seen = new Set<string>();
  const out: CustomCommand[] = [];
  for (const c of list) {
    const key = [c.agent, c.name, c.scope, c.project ?? "", c.source].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  out.sort(
    (a, b) =>
      cmp(a.agent, b.agent) || cmp(a.name, b.name) || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || cmp(a.project ?? "", b.project ?? "") || cmp(a.source, b.source),
  );
  return out.slice(0, max);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- Safe reads ----------

interface Entry {
  /** The name in its folder (a symlink's own name). */
  name: string;
  /** Resolved path: no symlinks, inside the scan root. */
  real: string;
  /** Path as reached (through symlinks), for display. */
  path: string;
  kind: "file" | "dir";
}

function isInside(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Per-scan-root budget (folders listed, files read) and the folders its symlinks may lead into. */
class Root {
  dirs = 0;
  files = 0;
  private readonly visited = new Set<string>();
  constructor(
    readonly real: string,
    readonly limits: DiscoveryLimits,
    /** A second folder symlink targets may lie in (the real home folder, for user scope). */
    private readonly also?: string,
    /** A Gemini CLI folder: names with token, oauth or credential in them are skipped too. */
    private readonly gemini = false,
  ) {}

  /** Names never listed in this root. */
  skips(name: string): boolean {
    return this.gemini ? isGeminiCredentialName(name) : isCredentialFile(name);
  }

  contains(p: string): boolean {
    return isInside(p, this.real) || (this.also !== undefined && isInside(p, this.also));
  }

  /** May one more file be read? Counts it. */
  takeFile(): boolean {
    if (this.files >= this.limits.maxFilesPerRoot) return false;
    this.files++;
    return true;
  }

  /** The entries of a folder inside the root: hidden, credential, escaping and special entries left out. */
  async list(dir: Entry | { real: string; path: string }): Promise<Entry[]> {
    if (this.dirs >= this.limits.maxDirsPerRoot || this.visited.has(dir.real) || !this.contains(dir.real)) return [];
    this.dirs++;
    this.visited.add(dir.real);
    let ents: Dirent[];
    try {
      ents = await readdir(dir.real, { withFileTypes: true });
    } catch {
      return [];
    }
    ents.sort((a, b) => cmp(a.name, b.name));
    const out: Entry[] = [];
    for (const d of ents) {
      if (d.name.startsWith(".") || this.skips(d.name)) continue;
      const real = join(dir.real, d.name);
      const path = join(dir.path, d.name);
      if (d.isFile()) out.push({ name: d.name, real, path, kind: "file" });
      else if (d.isDirectory()) out.push({ name: d.name, real, path, kind: "dir" });
      else if (d.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(real);
        } catch {
          continue;
        }
        if (!this.contains(target) || this.skips(basename(target)) || refusedPath(target)) continue;
        try {
          const st = await stat(target);
          if (st.isFile()) out.push({ name: d.name, real: target, path, kind: "file" });
          else if (st.isDirectory()) out.push({ name: d.name, real: target, path, kind: "dir" });
        } catch {
          // dangling or unreadable
        }
      }
    }
    return out;
  }
}

class Ctx {
  private realHome?: Promise<string | undefined>;
  constructor(
    readonly home: string,
    readonly limits: DiscoveryLimits,
  ) {}

  /**
   * A scan root (an existing folder, symlinks resolved) with its own budget, or undefined. With `within`,
   * the resolved folder must also lie inside that folder (project and plugin roots: a symlinked
   * `.claude/commands` in a repo can't point the scan elsewhere). User roots may be symlinks, e.g. into a
   * dotfiles repo; symlinks inside any root must stay inside it.
   */
  async root(dir: string, within?: string, userScope = false, gemini = false): Promise<{ root: Root; top: { real: string; path: string } } | undefined> {
    if ((gemini ? isGeminiCredentialName(basename(dir)) : isCredentialFile(basename(dir))) || refusedPath(dir)) return undefined;
    try {
      const real = await realpath(dir);
      if (within !== undefined && !isInside(real, await realpath(within))) return undefined;
      if (!(await stat(real)).isDirectory()) return undefined;
      this.realHome ??= realpath(this.home).catch(() => undefined);
      const also = userScope && USER_SYMLINKS_WITHIN_HOME ? await this.realHome : undefined;
      return { root: new Root(real, this.limits, also, gemini), top: { real, path: dir } };
    } catch {
      return undefined;
    }
  }

  display(path: string): string {
    return tildify(path, this.home);
  }

  /** The home folder as given and with symlinks resolved: a project walk stops at either. */
  async homes(): Promise<string[]> {
    this.realHome ??= realpath(this.home).catch(() => undefined);
    const real = await this.realHome;
    return real && real !== this.home ? [this.home, real] : [this.home];
  }
}

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The frontmatter keys of a Markdown file, read only as far as the block's closing line. `{}` when the
 * file has no (or an over-long) frontmatter block; undefined when it is unreadable or over the size cap.
 */
export async function readFrontmatterFile(path: string, limits: DiscoveryLimits = DISCOVERY_LIMITS): Promise<Record<string, string> | undefined> {
  if (refusedPath(path)) return undefined;
  let fh;
  try {
    fh = await open(path, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > limits.maxFileBytes) return undefined;
    const end = Math.min(st.size, limits.frontmatterMaxBytes);
    const buf = new Uint8Array(limits.chunkBytes);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    let pos = 0;
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      text += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      const split = splitFrontmatter(text);
      if (split.state === "none") return {};
      if (split.state === "complete") return parseFrontmatter(split.block);
    }
    // The whole file was read and the block closes on its last line, or it never closed.
    const block = pos >= st.size ? frontmatterOfWhole(text) : undefined;
    return block === undefined ? {} : parseFrontmatter(block);
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** A whole small file as text (JSON manifests, TOML commands), or undefined when unreadable or over the cap. */
export async function readSmallText(path: string, limits: DiscoveryLimits = DISCOVERY_LIMITS): Promise<string | undefined> {
  if (refusedPath(path)) return undefined;
  let fh;
  try {
    fh = await open(path, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > limits.maxFileBytes) return undefined;
    const buf = new Uint8Array(st.size);
    let pos = 0;
    while (pos < buf.length) {
      const { bytesRead } = await fh.read(buf, pos, buf.length - pos, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, pos));
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readJson(path: string, limits: DiscoveryLimits): Promise<Record<string, unknown> | undefined> {
  const text = await readSmallText(path, limits);
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `dir` and its parents up to (not including) the home folder, stopping after the first that holds `.git`. */
async function upToGitRoot(dir: string, ctx: Ctx): Promise<string[]> {
  const homes = await ctx.homes();
  const out: string[] = [];
  for (let h = resolve(dir); ; ) {
    if (homes.includes(h)) break;
    out.push(h);
    if (await exists(join(h, ".git"))) break;
    const parent = dirname(h);
    if (parent === h) break;
    h = parent;
  }
  return out;
}

interface Emit {
  agent: AgentId;
  kind: CustomCommand["kind"];
  scope: CustomCommand["scope"];
  project?: string;
  /** For plugins: the plugin name; otherwise the file is shown. */
  plugin?: string;
  /** Scan roots must resolve inside this folder (see Ctx.root). */
  within?: string;
  /** A Gemini CLI .gemini folder (see Root.skips). */
  gemini?: boolean;
}

function make(base: Emit, name: string, description: string | undefined, file: string, ctx: Ctx): CustomCommand | undefined {
  const clean = cleanCommandName(name);
  if (!clean) return undefined;
  const c: CustomCommand = { agent: base.agent, name: clean, kind: base.kind, scope: base.scope, source: base.plugin ?? ctx.display(file) };
  if (description !== undefined) c.description = description;
  if (base.project !== undefined) c.project = base.project;
  return c;
}

// ---------- Claude Code ----------
// <config>/commands/**/*.md (/a:b for a/b.md; a folder holding SKILL.md is one command named after it),
// <config>/skills/<name>/SKILL.md, the same under <dir>/.claude/ for each cwd and its parents up to the
// git root (never home), and installed plugins' commands/ and skills/ as /<plugin>:<name>.

async function discoverClaude(ctx: Ctx, configDir: string, projects: string[]): Promise<CustomCommand[]> {
  const out: CustomCommand[] = [];
  const agent = "claude-code";
  await claudeCommands(ctx, join(configDir, "commands"), { agent, kind: "command", scope: "user" }, "", out);
  await claudeSkills(ctx, join(configDir, "skills"), { agent, kind: "skill", scope: "user" }, "", out);
  const dirs = new Set<string>();
  for (const cwd of projects) for (const d of await upToGitRoot(cwd, ctx)) dirs.add(d);
  for (const dir of [...dirs].sort()) {
    await claudeCommands(ctx, join(dir, ".claude", "commands"), { agent, kind: "command", scope: "project", project: dir, within: dir }, "", out);
    await claudeSkills(ctx, join(dir, ".claude", "skills"), { agent, kind: "skill", scope: "project", project: dir, within: dir }, "", out);
  }
  await claudePlugins(ctx, configDir, projects, out);
  return out;
}

/** Markdown commands under `dir`, named `/<prefix><a>:<b>`. A `.md` file given as `dir` is one command. */
async function claudeCommands(ctx: Ctx, dir: string, base: Emit, prefix: string, out: CustomCommand[]): Promise<void> {
  if (dir.toLowerCase().endsWith(".md")) {
    const parent = await ctx.root(dirname(dir), base.within, base.scope === "user");
    if (!parent) return;
    const file = (await parent.root.list(parent.top)).find((e) => e.kind === "file" && e.name === basename(dir));
    if (file) await claudeEmit(ctx, parent.root, base, `/${prefix}${file.name.slice(0, -3)}`, file, out);
    return;
  }
  const r = await ctx.root(dir, base.within, base.scope === "user");
  if (!r) return;
  const walk = async (entries: Entry[], rel: string[]): Promise<void> => {
    for (const e of entries) {
      if (e.kind === "file") {
        if (e.name.toLowerCase().endsWith(".md")) await claudeEmit(ctx, r.root, base, `/${prefix}${[...rel, e.name.slice(0, -3)].join(":")}`, e, out);
        continue;
      }
      if (rel.length + 1 > ctx.limits.maxDepth) continue;
      const sub = await r.root.list(e);
      const skill = sub.find((s) => s.kind === "file" && s.name === "SKILL.md");
      if (skill) await claudeEmit(ctx, r.root, base, `/${prefix}${[...rel, e.name].join(":")}`, skill, out);
      else await walk(sub, [...rel, e.name]);
    }
  };
  await walk(await r.root.list(r.top), []);
}

/** `<dir>/<name>/SKILL.md` skills named `/<prefix><name>`; a folder that is a skills-dir plugin is loaded as a plugin. */
async function claudeSkills(ctx: Ctx, dir: string, base: Emit, prefix: string, out: CustomCommand[]): Promise<void> {
  const r = await ctx.root(dir, base.within, base.scope === "user");
  if (!r) return;
  for (const e of await r.root.list(r.top)) {
    if (e.kind !== "dir") continue;
    if (!prefix && base.kind === "skill" && (await exists(join(e.real, ".claude-plugin", "plugin.json")))) {
      await claudePluginDir(ctx, e.real, `${e.name}@skills-dir`, base.project, out, r.root.real);
      continue;
    }
    const skill = (await r.root.list(e)).find((s) => s.kind === "file" && s.name === "SKILL.md");
    if (skill) await claudeEmit(ctx, r.root, base, `/${prefix}${e.name}`, skill, out);
  }
}

async function claudeEmit(ctx: Ctx, root: Root, base: Emit, name: string, file: Entry, out: CustomCommand[]): Promise<void> {
  if (!root.takeFile()) return;
  const fm = await readFrontmatterFile(file.real, ctx.limits);
  if (fm === undefined || isFalse(fm["user-invocable"])) return;
  const c = make(base, name, cleanDescription(fm.description), file.path, ctx);
  if (c) out.push(c);
}

/** installed_plugins.json (schema version 2): user and managed installs, and project/local ones for a session's project. */
async function claudePlugins(ctx: Ctx, configDir: string, projects: string[], out: CustomCommand[]): Promise<void> {
  const doc = await readJson(join(configDir, "plugins", "installed_plugins.json"), ctx.limits);
  if (!doc || doc.version !== 2 || !isObject(doc.plugins)) return;
  for (const [id, installs] of Object.entries(doc.plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const inst of installs) {
      if (!isObject(inst) || typeof inst.installPath !== "string" || !isAbsolute(inst.installPath)) continue;
      let project: string | undefined;
      if (inst.scope === "project" || inst.scope === "local") {
        const pp = typeof inst.projectPath === "string" && isAbsolute(inst.projectPath) ? resolve(inst.projectPath) : undefined;
        if (!pp || !projects.some((cwd) => cwd === pp || cwd.startsWith(pp + sep))) continue;
        project = pp;
      }
      await claudePluginDir(ctx, inst.installPath, id, project, out);
    }
  }
}

/** One plugin folder: commands/ and skills/ plus any extra paths its manifest names, as /<plugin>:<name>. */
async function claudePluginDir(ctx: Ctx, dir: string, id: string, project: string | undefined, out: CustomCommand[], within?: string): Promise<void> {
  const r = await ctx.root(dir, within);
  if (!r) return;
  const manifest = await readJson(join(r.top.real, ".claude-plugin", "plugin.json"), ctx.limits);
  const fallback = id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id;
  const name = (typeof manifest?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.name) ? manifest.name : fallback).trim();
  if (!name) return;
  const extra = (key: string): string[] => {
    const v = manifest?.[key];
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return list.map((p) => resolve(r.top.real, p));
  };
  const commandDirs = [...new Set([join(r.top.real, "commands"), ...extra("commands")])];
  const skillDirs = [...new Set([join(r.top.real, "skills"), ...extra("skills")])];
  // Every path, the manifest's extra ones too, must resolve inside the plugin folder.
  const base = { agent: "claude-code", scope: "plugin" as const, plugin: name, within: r.top.real, ...(project !== undefined ? { project } : {}) };
  for (const d of commandDirs) await claudeCommands(ctx, d, { ...base, kind: "plugin-command" }, `${name}:`, out);
  for (const d of skillDirs) await claudeSkills(ctx, d, { ...base, kind: "plugin-skill" }, `${name}:`, out);
}

// ---------- Codex ----------
// Skills (typed as $name): ~/.agents/skills and $CODEX_HOME/skills (the bundled .system folder is hidden,
// so skipped), <dir>/.agents/skills for each cwd and its parents up to the git root, and plugin skills in
// $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/skills as $<plugin>:<name>. Legacy prompts:
// $CODEX_HOME/prompts/*.md as /prompts:<name> (Codex CLI 0.161 no longer loads them; the desktop app's docs
// still mention them). Project .codex/skills folders need a trusted-project setting in config.toml, which
// Signalbox doesn't read, so they are not listed.

async function discoverCodex(ctx: Ctx, codexHome: string, projects: string[]): Promise<CustomCommand[]> {
  const out: CustomCommand[] = [];
  const agent = "codex";
  await codexSkills(ctx, join(ctx.home, ".agents", "skills"), { agent, kind: "skill", scope: "user" }, "", out);
  await codexSkills(ctx, join(codexHome, "skills"), { agent, kind: "skill", scope: "user" }, "", out);
  const dirs = new Set<string>();
  for (const cwd of projects) {
    const chain = await upToGitRoot(cwd, ctx);
    // Codex reads project skills only inside a project (a .git marker); otherwise just the cwd.
    const rooted = chain.length > 0 && (await exists(join(chain[chain.length - 1]!, ".git")));
    for (const d of rooted ? chain : chain.slice(0, 1)) dirs.add(d);
  }
  for (const dir of [...dirs].sort()) {
    await codexSkills(ctx, join(dir, ".agents", "skills"), { agent, kind: "skill", scope: "project", project: dir, within: dir }, "", out);
  }
  const prompts = await ctx.root(join(codexHome, "prompts"), undefined, true);
  if (prompts) {
    for (const e of await prompts.root.list(prompts.top)) {
      if (e.kind !== "file" || !e.name.toLowerCase().endsWith(".md") || !prompts.root.takeFile()) continue;
      const fm = await readFrontmatterFile(e.real, ctx.limits);
      if (fm === undefined) continue;
      const c = make({ agent, kind: "prompt", scope: "user" }, `/prompts:${e.name.slice(0, -3)}`, cleanDescription(fm.description), e.path, ctx);
      if (c) out.push(c);
    }
  }
  await codexPlugins(ctx, join(codexHome, "plugins", "cache"), out);
  return out;
}

/** SKILL.md files anywhere under `dir` (a skill's own folder is not searched further), named by frontmatter `name`. */
async function codexSkills(ctx: Ctx, dir: string, base: Emit, prefix: string, out: CustomCommand[]): Promise<void> {
  const r = await ctx.root(dir, base.within, base.scope === "user");
  if (!r) return;
  const walk = async (entries: Entry[], depth: number): Promise<void> => {
    const skill = entries.find((e) => e.kind === "file" && e.name === "SKILL.md");
    if (skill) {
      if (!r.root.takeFile()) return;
      const fm = await readFrontmatterFile(skill.real, ctx.limits);
      const name = fm?.name?.trim();
      // Codex skips a skill without a valid name.
      if (!fm || !name || name.length > 64) return;
      const c = make(base, `$${prefix}${name}`, cleanDescription(fm.description), skill.path, ctx);
      if (c) out.push(c);
      return;
    }
    if (depth >= ctx.limits.maxDepth) return;
    for (const e of entries) if (e.kind === "dir") await walk(await r.root.list(e), depth + 1);
  };
  await walk(await r.root.list(r.top), 0);
}

/** The newest version folder of each cached plugin. */
async function codexPlugins(ctx: Ctx, cacheDir: string, out: CustomCommand[]): Promise<void> {
  const cache = await ctx.root(cacheDir);
  if (!cache) return;
  for (const market of await cache.root.list(cache.top)) {
    if (market.kind !== "dir") continue;
    for (const plugin of await cache.root.list(market)) {
      if (plugin.kind !== "dir") continue;
      let newest: { e: Entry; mtime: number } | undefined;
      for (const v of await cache.root.list(plugin)) {
        if (v.kind !== "dir") continue;
        const mtime = (await stat(v.real).catch(() => undefined))?.mtimeMs ?? 0;
        if (!newest || mtime > newest.mtime) newest = { e: v, mtime };
      }
      if (!newest) continue;
      let manifest: Record<string, unknown> | undefined;
      for (const m of [".codex-plugin", ".claude-plugin", ".cursor-plugin"]) {
        manifest = await readJson(join(newest.e.real, m, "plugin.json"), ctx.limits);
        if (manifest) break;
      }
      const name = typeof manifest?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.name) ? manifest.name : plugin.name;
      const base = { agent: "codex", kind: "plugin-skill" as const, scope: "plugin" as const, plugin: name, within: newest.e.real };
      await codexSkills(ctx, join(newest.e.real, "skills"), base, `${name}:`, out);
    }
  }
}

// ---------- Gemini CLI ----------
// TOML commands: <home>/.gemini/commands/**/*.toml (/a:b for a/b.toml, each part cleaned like Gemini does),
// <cwd>/.gemini/commands for each cwd that isn't home, and each extension's commands/. Skills (SKILL.md or
// */SKILL.md, with frontmatter name and description) in <home>/.gemini/skills, <home>/.agents/skills, the
// same under each cwd, and each extension's skills/ as /<extension>:<name>. Folder trust, the disabled-skill
// list and extension enablement live in settings Signalbox doesn't read; same-name renames aren't applied.

async function discoverGemini(ctx: Ctx, geminiHome: string, projects: string[]): Promise<CustomCommand[]> {
  const out: CustomCommand[] = [];
  const agent = "gemini-cli";
  const gem = join(geminiHome, ".gemini");
  await geminiCommands(ctx, join(gem, "commands"), { agent, kind: "command", scope: "user", gemini: true }, out);
  await geminiSkills(ctx, join(gem, "skills"), { agent, kind: "skill", scope: "user", gemini: true }, "", out);
  await geminiSkills(ctx, join(geminiHome, ".agents", "skills"), { agent, kind: "skill", scope: "user" }, "", out);
  for (const cwd of projects) {
    if (cwd === resolve(geminiHome)) continue;
    const base = { agent, scope: "project" as const, project: cwd, within: cwd };
    await geminiCommands(ctx, join(cwd, ".gemini", "commands"), { ...base, kind: "command", gemini: true }, out);
    await geminiSkills(ctx, join(cwd, ".gemini", "skills"), { ...base, kind: "skill", gemini: true }, "", out);
    await geminiSkills(ctx, join(cwd, ".agents", "skills"), { ...base, kind: "skill" }, "", out);
  }
  const exts = await ctx.root(join(gem, "extensions"), undefined, false, true);
  if (exts) {
    for (const e of await exts.root.list(exts.top)) {
      if (e.kind !== "dir") continue;
      // A linked extension lives where its install record points.
      const link = await readJson(join(e.real, ".gemini-extension-install.json"), ctx.limits);
      const extRoot = link?.type === "link" && typeof link.source === "string" && isAbsolute(link.source) ? link.source : e.real;
      const manifest = await readJson(join(extRoot, "gemini-extension.json"), ctx.limits);
      const name = typeof manifest?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.name) ? manifest.name : undefined;
      if (!name) continue;
      // An extension inside ~/.gemini gets the .gemini rule; a linked one elsewhere gets the general one.
      const base = { agent, scope: "plugin" as const, plugin: name, within: extRoot, gemini: extRoot === e.real };
      await geminiCommands(ctx, join(extRoot, "commands"), { ...base, kind: "plugin-command" }, out);
      await geminiSkills(ctx, join(extRoot, "skills"), { ...base, kind: "plugin-skill" }, `${name}:`, out);
    }
  }
  return out;
}

async function geminiCommands(ctx: Ctx, dir: string, base: Emit, out: CustomCommand[]): Promise<void> {
  const r = await ctx.root(dir, base.within, base.scope === "user", base.gemini === true);
  if (!r) return;
  const walk = async (entries: Entry[], rel: string[]): Promise<void> => {
    for (const e of entries) {
      if (e.kind === "dir") {
        if (rel.length + 1 <= ctx.limits.maxDepth) await walk(await r.root.list(e), [...rel, e.name]);
        continue;
      }
      if (!e.name.toLowerCase().endsWith(".toml") || !r.root.takeFile()) continue;
      const text = await readSmallText(e.real, ctx.limits);
      if (text === undefined) continue;
      const info = tomlCommandInfo(text);
      if (!info.valid) continue;
      const name = `/${[...rel, e.name.slice(0, -5)].map(geminiSegment).join(":")}`;
      const c = make(base, name, info.description, e.path, ctx);
      if (c) out.push(c);
    }
  };
  await walk(await r.root.list(r.top), []);
}

/** `<dir>/SKILL.md` and `<dir>/*\/SKILL.md`; Gemini needs both `name` and `description` in the frontmatter. */
async function geminiSkills(ctx: Ctx, dir: string, base: Emit, prefix: string, out: CustomCommand[]): Promise<void> {
  const r = await ctx.root(dir, base.within, base.scope === "user", base.gemini === true);
  if (!r) return;
  const top = await r.root.list(r.top);
  const files = top.filter((e) => e.kind === "file" && e.name === "SKILL.md");
  for (const d of top) {
    if (d.kind !== "dir") continue;
    const skill = (await r.root.list(d)).find((e) => e.kind === "file" && e.name === "SKILL.md");
    if (skill) files.push(skill);
  }
  for (const f of files) {
    if (!r.root.takeFile()) return;
    const fm = await readFrontmatterFile(f.real, ctx.limits);
    const name = fm?.name?.trim();
    const description = cleanDescription(fm?.description);
    if (!name || description === undefined) continue;
    const c = make(base, `/${prefix}${geminiSkillName(name)}`, description, f.path, ctx);
    if (c) out.push(c);
  }
}
