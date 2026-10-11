// The command guide's pure half: the embedded command catalogs and their validator, and the parsers
// custom-command discovery runs on what it reads (YAML frontmatter blocks, TOML text). No I/O.
import { fileURLToPath } from "node:url";
import claudeCodeCommands from "../../../catalog/commands/claude-code.json" with { type: "json" };
import codexCommands from "../../../catalog/commands/codex.json" with { type: "json" };
import geminiCliCommands from "../../../catalog/commands/gemini-cli.json" with { type: "json" };
import type { CommandCatalog } from "./types.ts";

/** The repo's `catalog/commands/` directory, resolved relative to this source file. It does not exist inside a compiled binary. */
export const DEFAULT_COMMAND_CATALOG_DIR: string = fileURLToPath(new URL("../../../catalog/commands/", import.meta.url));

/** Bundled at build time, like the price files. A new `catalog/commands/*.json` file must be added here too (a test checks). */
const EMBEDDED_CATALOGS: Readonly<Record<string, unknown>> = {
  "claude-code.json": claudeCodeCommands,
  "codex.json": codexCommands,
  "gemini-cli.json": geminiCliCommands,
};

export const EMBEDDED_COMMAND_CATALOG_FILES: readonly string[] = Object.keys(EMBEDDED_CATALOGS).sort();

/** The embedded copies of `catalog/commands/*.json`, validated, sorted by file name. Each call returns fresh objects. */
export function embeddedCommandCatalogs(): CommandCatalog[] {
  return EMBEDDED_COMMAND_CATALOG_FILES.map((name) =>
    parseCommandCatalog(structuredClone(EMBEDDED_CATALOGS[name]), `catalog/commands/${name} (embedded)`),
  );
}

// ---------- Catalog validation ----------

export const MAX_SUMMARY_CHARS = 90;

const CATEGORIES = new Set(["session", "context", "model", "info", "config", "account", "tools", "navigation", "integrations", "debug", "other"]);
const STATUSES = new Set(["view", "planned", "no", "never"]);
const VIEWS = new Set(["sessions", "usage", "limits", "health"]);
const METHODS = new Set(["binary", "help", "docs", "observed"]);
const SURFACE_VALUES: Record<string, ReadonlyArray<unknown>> = {
  terminal: [true, false, "unknown"],
  desktop: [true, false, "partial", "unknown"],
  headless: [true, false, "partial", "unknown"],
  remoteControl: [true, false, "unknown"],
};
const TOP_KEYS = new Set(["agent", "displayName", "verifiedVersion", "asOf", "sources", "commands", "cliCommands"]);
const ENTRY_KEYS = new Set(["name", "aliases", "args", "summary", "details", "category", "surfaces", "sideEffects", "signalbox", "verified", "sourceUrl"]);
const SIGNALBOX_KEYS = new Set(["status", "view", "note"]);
const VERIFIED_KEYS = new Set(["method", "version"]);

export interface CatalogCheckOptions {
  /** Also reject keys the contract doesn't define (tests use this to catch typos; the runtime keeps them). */
  strict?: boolean;
}

/** Every problem with an already-parsed catalog, as "where: what" strings. Empty when it is valid. */
export function checkCommandCatalog(json: unknown, opts: CatalogCheckOptions = {}): string[] {
  const problems: string[] = [];
  const bad = (where: string, what: string) => problems.push(`${where}: ${what}`);
  if (!isObject(json)) return ["catalog: not an object"];
  const extra = (obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string) => {
    if (!opts.strict) return;
    for (const k of Object.keys(obj)) if (!allowed.has(k)) bad(where, `unknown key "${k}"`);
  };
  extra(json, TOP_KEYS, "catalog");
  for (const field of ["agent", "displayName", "verifiedVersion"] as const) if (!isLine(json[field])) bad(field, "must be a non-empty single-line string");
  if (typeof json.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(json.asOf)) bad("asOf", "must be YYYY-MM-DD");
  if (!Array.isArray(json.sources) || json.sources.length === 0 || !json.sources.every(isHttpsUrl)) bad("sources", "must be a non-empty array of https URLs");
  for (const list of ["commands", "cliCommands"] as const) {
    const entries = json[list];
    if (!Array.isArray(entries)) {
      bad(list, "must be an array");
      continue;
    }
    const seen = new Map<string, string>();
    entries.forEach((e, i) => {
      const where = `${list}[${i}]${isObject(e) && typeof e.name === "string" ? ` ${e.name}` : ""}`;
      checkEntry(e, where, list === "commands", bad, extra);
      if (!isObject(e)) return;
      for (const n of [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
        if (typeof n !== "string") continue;
        const prev = seen.get(n);
        if (prev !== undefined) bad(where, `"${n}" is already used by ${prev}`);
        else seen.set(n, String(e.name));
      }
    });
  }
  return problems;
}

function checkEntry(
  e: unknown,
  where: string,
  slash: boolean,
  bad: (where: string, what: string) => void,
  extra: (obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string) => void,
): void {
  if (!isObject(e)) {
    bad(where, "must be an object");
    return;
  }
  extra(e, ENTRY_KEYS, where);
  if (!isLine(e.name)) bad(where, '"name" must be a non-empty single-line string');
  // Slash commands, plus Gemini's "@<path>" and "!<command>" syntax and Codex's "$skill" form.
  else if (slash && !/^[/@!$]\S/.test(e.name)) bad(where, '"name" must start with /, @, ! or $');
  if (e.aliases !== undefined) {
    if (!Array.isArray(e.aliases) || !e.aliases.every(isLine)) bad(where, '"aliases" must be an array of single-line strings');
    else if (new Set(e.aliases).size !== e.aliases.length || (e.aliases as unknown[]).includes(e.name)) bad(where, '"aliases" repeats a name');
  }
  if (e.args !== undefined && !isLine(e.args)) bad(where, '"args" must be a single-line string');
  if (!isLine(e.summary)) bad(where, '"summary" must be a non-empty single-line string');
  else if (e.summary.length > MAX_SUMMARY_CHARS) bad(where, `"summary" is ${e.summary.length} characters (at most ${MAX_SUMMARY_CHARS})`);
  if (e.details !== undefined && !isLine(e.details)) bad(where, '"details" must be a non-empty single-line string');
  if (typeof e.category !== "string" || !CATEGORIES.has(e.category)) bad(where, `"category" must be one of ${[...CATEGORIES].join(", ")}`);
  if (!isObject(e.surfaces)) bad(where, '"surfaces" must be an object');
  else {
    extra(e.surfaces, new Set(Object.keys(SURFACE_VALUES)), `${where}.surfaces`);
    for (const [k, allowed] of Object.entries(SURFACE_VALUES)) {
      if (!allowed.includes(e.surfaces[k])) bad(where, `surfaces.${k} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }
  if (e.sideEffects !== undefined && !isLine(e.sideEffects)) bad(where, '"sideEffects" must be a non-empty single-line string');
  const sb = e.signalbox;
  if (!isObject(sb)) bad(where, '"signalbox" must be an object');
  else {
    extra(sb, SIGNALBOX_KEYS, `${where}.signalbox`);
    if (typeof sb.status !== "string" || !STATUSES.has(sb.status)) bad(where, "signalbox.status must be view, planned, no or never");
    if (sb.view !== undefined) {
      if (typeof sb.view !== "string" || !VIEWS.has(sb.view)) bad(where, "signalbox.view must be sessions, usage, limits or health");
      else if (sb.status !== "view") bad(where, 'signalbox.view is only for status "view"');
    }
    if (!isLine(sb.note)) bad(where, "signalbox.note must be a non-empty single-line string");
  }
  const v = e.verified;
  if (!isObject(v)) bad(where, '"verified" must be an object');
  else {
    extra(v, VERIFIED_KEYS, `${where}.verified`);
    if (typeof v.method !== "string" || !METHODS.has(v.method)) bad(where, "verified.method must be binary, help, docs or observed");
    if (!isLine(v.version)) bad(where, "verified.version must be a non-empty string");
  }
  if (e.sourceUrl !== undefined && !isHttpsUrl(e.sourceUrl)) bad(where, '"sourceUrl" must be an https URL');
}

/** Validates an already-parsed catalog and returns it typed; throws listing the first problems. */
export function parseCommandCatalog(json: unknown, source = "command catalog", opts: CatalogCheckOptions = {}): CommandCatalog {
  const problems = checkCommandCatalog(json, opts);
  if (problems.length) {
    const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : "";
    throw new Error(`${source}: ${problems.slice(0, 5).join("; ")}${more}`);
  }
  return json as CommandCatalog;
}

// ---------- Custom command text: frontmatter, TOML, names ----------

export const MAX_CUSTOM_DESCRIPTION_CHARS = 200;

/** Control and invisible formatting characters (C0, C1, zero-width, line/paragraph separators, bidi controls, BOM). */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
const HAS_UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;

/** One printable line of at most 200 characters, or undefined for a non-string or blank value. */
export function cleanDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const chars = [...s];
  return chars.length > MAX_CUSTOM_DESCRIPTION_CHARS ? `${chars.slice(0, MAX_CUSTOM_DESCRIPTION_CHARS - 1).join("").trimEnd()}…` : s;
}

/** A command name made from file or folder names: undefined when it has control characters or is implausibly long. */
export function cleanCommandName(name: string): string | undefined {
  if (name.length < 2 || name.length > 200) return undefined;
  return HAS_UNPRINTABLE.test(name) ? undefined : name;
}

export type FrontmatterSplit = { state: "none" } | { state: "incomplete" } | { state: "complete"; block: string };

/**
 * Finds a leading YAML frontmatter block (`---` line, body, `---` line) in the first bytes of a file.
 * "incomplete" means the text read so far starts a block that hasn't closed yet: read more, or give up.
 */
export function splitFrontmatter(head: string): FrontmatterSplit {
  const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return "---".startsWith(text.trimEnd()) ? { state: "incomplete" } : { state: "none" };
  if (!/^---[ \t]*\r?$/.test(text.slice(0, firstNl))) return { state: "none" };
  let start = firstNl + 1;
  for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
    if (/^---[ \t]*\r?$/.test(text.slice(start, nl))) return { state: "complete", block: text.slice(firstNl + 1, start) };
    start = nl + 1;
  }
  // A closing line with nothing after it (end of file) is only known to be complete by the caller.
  return { state: "incomplete" };
}

/** Like splitFrontmatter, for a whole file's text: a closing `---` on the last line (no newline) also counts. */
export function frontmatterOfWhole(text: string): string | undefined {
  const split = splitFrontmatter(text.endsWith("\n") ? text : `${text}\n`);
  return split.state === "complete" ? split.block : undefined;
}

/**
 * The top-level scalar keys of a frontmatter block, keys lowercased with `_` read as `-`. A small,
 * deliberately limited YAML reader (no anchors or aliases, so a hostile file can't blow up): plain,
 * quoted, multi-line plain and block (`|`, `>`) scalars. Nested maps and lists are skipped. Every
 * value comes back as a string, newlines folded to spaces.
 */
export function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  const indented = (l: string) => /^[ \t]/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line.trimEnd());
    if (!m) continue;
    const key = m[1]!.toLowerCase().replaceAll("_", "-");
    const rest = (m[2] ?? "").trim();
    // Lines that belong to this key: indented ones, and blank ones between them.
    const body: string[] = [];
    while (i < lines.length && (indented(lines[i]!) || lines[i]!.trim() === "")) body.push(lines[i++]!);
    while (body.length && body[body.length - 1]!.trim() === "") body.pop();
    const value = scalar(rest, body);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function scalar(rest: string, body: string[]): string | undefined {
  if (/^[|>][0-9+-]*(\s+#.*)?$/.test(rest)) return fold(body.map((l) => l.trim()));
  if (rest.startsWith('"') || rest.startsWith("'")) return quoted([rest, ...body.map((l) => l.trim())].join("\n"), rest[0]!);
  if (rest === "") {
    const first = body.find((l) => l.trim() !== "")?.trim();
    // A nested list or map, not a scalar.
    if (first === undefined || first.startsWith("- ") || first === "-" || /^[^\s:]+[ \t]*:(\s|$)/.test(first)) return undefined;
    return fold(body.map((l) => l.trim()));
  }
  if (rest.startsWith("[") || rest.startsWith("{")) return rest;
  const plain = rest.replace(/\s+#.*$/, "");
  return fold([plain, ...body.map((l) => l.trim())]);
}

function fold(parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ").trim();
}

/** A quoted scalar that may span lines; text after the closing quote is ignored. */
function quoted(text: string, q: string): string {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (q === "'" && c === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    if (q === '"' && c === '"') break;
    if (q === '"' && c === "\\" && i + 1 < text.length) {
      const n = text[++i]!;
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += ({ n: " ", t: " ", r: "", "0": "", "\n": "" } as Record<string, string>)[n] ?? n;
      continue;
    }
    out += c === "\n" ? " " : c;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A frontmatter flag that is explicitly off (`false`, `no`, `off`). */
export function isFalse(value: string | undefined): boolean {
  return value !== undefined && ["false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * The top-level `description` of a TOML command file and whether it has a top-level string `prompt`
 * (Gemini CLI skips files without one). The prompt itself is never returned.
 */
export function tomlCommandInfo(text: string): { valid: boolean; description?: string } {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch {
    return { valid: false };
  }
  if (!isObject(doc) || typeof doc.prompt !== "string") return { valid: false };
  const description = cleanDescription(doc.description);
  return description === undefined ? { valid: true } : { valid: true, description };
}

/** Gemini CLI's file-name cleaning for one command path segment: [A-Za-z0-9_.-] only, at most 50 characters. */
export function geminiSegment(segment: string): string {
  const s = segment.replace(/[^A-Za-z0-9_.-]/g, "_");
  return s.length > 50 ? `${s.slice(0, 47)}...` : s;
}

/** Gemini CLI's skill-name cleaning: path and shell metacharacters and spaces become "-". */
export function geminiSkillName(name: string): string {
  return name.replace(/[:\\/<>*?"|]/g, "-").replace(/\s/g, "-");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string with no line breaks. */
function isLine(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
}

function isHttpsUrl(v: unknown): boolean {
  if (typeof v !== "string" || !v.startsWith("https://")) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
