// How long each Claude Code config dir keeps transcripts (Stability "documented": the settings files and
// `cleanupPeriodDays` are in Claude Code's settings docs; see core retention.ts for the semantics and sources).
//
// Claude Code's settings files can also hold `env` values (API keys), an API key helper, hooks and permissions, so
// the reader is an allow-list:
//   - only <configDir>/settings.json and, in the managed settings folder (/Library/Application Support/ClaudeCode on
//     macOS, /etc/claude-code on Linux), managed-settings.json and managed-settings.d/*.json (never managed-mcp.json);
//   - a regular file only (lstat, then fstat on a descriptor opened with O_NOFOLLOW), at most 1 MiB;
//   - only the top-level `cleanupPeriodDays` member is cut out of the text and parsed; nothing else in the file is;
//   - nothing is ever written.
// Precedence follows https://code.claude.com/docs/en/settings#settings-precedence: managed settings win (the .d files
// merged after managed-settings.json, alphabetically, per https://code.claude.com/docs/en/managed-settings), then
// the user's settings.json. Project files, --settings, MDM profiles and console-served settings aren't read (an MDM
// profile or console-served settings that carry any policy replace the managed files: "first-wins"). Claude Code also
// follows a managed file deployed as a symlink; Signalbox doesn't, so such a file makes the value "unknown". An empty
// managed file counts as `{}`, as in Claude Code; any other file must be strict JSON.
// SIGNALBOX_CLAUDE_CONFIG_TRACE=1 logs every path it lists, stats or opens.
import { join } from "node:path";
import {
  CLAUDE_CODE_DEFAULT_RETENTION_DAYS,
  invalidRetentionText,
  isValidRetentionDays,
  type RetentionInfo,
} from "../../core/src/index.ts";
import { CappedJsonReader, defaultConfigFs, type CappedJsonReaderOptions, type CappedRead } from "./capped-json.ts";
import { errorCode, type ClaudeAppFs } from "./claude-app.ts";
import { topLevelValue } from "./json-scan.ts";

export const SETTINGS_MAX_BYTES = 1024 * 1024;
export const RETENTION_KEY = "cleanupPeriodDays";
/** Overrides the managed settings folder; empty turns the managed check off (tests, synthetic fixtures). */
export const MANAGED_SETTINGS_DIR_ENV = "SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR";

type Setting = { set: false } | { set: true; value: unknown };

/** The `cleanupPeriodDays` member of a settings file's text; throws on a file that isn't strict JSON. */
export function retentionFromSettingsText(text: string): Setting {
  return topLevelValue(text, RETENTION_KEY);
}

/** The same for a managed settings file, where an empty file counts as `{}`. */
export function retentionFromManagedText(text: string): Setting {
  return text.length === 0 ? { set: false } : retentionFromSettingsText(text);
}

/** Claude Code's system folder for managed settings files on this platform, or $SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR. */
export function defaultManagedSettingsDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | false {
  const explicit = env[MANAGED_SETTINGS_DIR_ENV];
  if (explicit !== undefined) return explicit === "" ? false : explicit;
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "linux") return "/etc/claude-code";
  return false;
}

function describe(r: CappedRead<Setting>): string {
  switch (r.state) {
    case "not-a-file":
      return `${r.path} is not a regular file (a symbolic link isn't followed)`;
    case "too-large":
      return `${r.path} is over 1 MiB`;
    case "unparsable":
      return `${r.path} isn't valid JSON`;
    case "changed":
      return `${r.path} changed while it was read`;
    case "unreadable":
      return `${r.path} can't be read (${r.code})`;
    default:
      return `${r.path} is ${r.state}`;
  }
}

export interface RetentionReaderOptions {
  /** The managed settings folder; false skips it. Default: defaultManagedSettingsDir(). */
  managedDir?: string | false;
  fs?: ClaudeAppFs;
  /** The grace period and clock for files caught mid-write (tests). */
  reader?: CappedJsonReaderOptions;
}

export class RetentionReader {
  private readonly files: CappedJsonReader<Setting>;
  private readonly managedFiles: CappedJsonReader<Setting>;
  private readonly fs: ClaudeAppFs;
  private readonly managedDir: string | false;

  constructor(opts: RetentionReaderOptions = {}) {
    this.fs = opts.fs ?? defaultConfigFs();
    this.files = new CappedJsonReader(retentionFromSettingsText, SETTINGS_MAX_BYTES, this.fs, opts.reader);
    this.managedFiles = new CappedJsonReader(retentionFromManagedText, SETTINGS_MAX_BYTES, this.fs, opts.reader);
    this.managedDir = opts.managedDir ?? defaultManagedSettingsDir();
  }

  /** One entry per config dir, in order. `shares`: the other dirs sharing each dir's transcripts folder. */
  async read(configDirs: readonly string[], shares: ReadonlyMap<string, string[]> = new Map()): Promise<RetentionInfo[]> {
    const managed = await this.managed();
    const out: RetentionInfo[] = [];
    for (const dir of configDirs) {
      const info: RetentionInfo = { agent: "claude-code", configDir: dir, source: "default", defaultDays: CLAUDE_CODE_DEFAULT_RETENTION_DAYS };
      const others = shares.get(dir);
      if (others?.length) info.sharesTranscriptsWith = [...others];
      if (managed.problem) {
        info.problem = managed.problem;
      } else if (managed.found) {
        apply(info, "managed", managed.found);
      } else {
        const r = await this.files.read(join(dir, "settings.json"));
        if (r.state === "ok") {
          if (r.value?.set) apply(info, "user", { value: r.value.value, file: r.path });
        } else if (r.state !== "missing") {
          info.problem = describe(r);
        }
      }
      out.push(info);
    }
    return out;
  }

  /**
   * The managed value (the last managed file that sets it), or why it can't be told: a file that can't be read only
   * matters when no later file sets the value, since a later file would override whatever it says.
   */
  private async managed(): Promise<{ found?: { value: unknown; file: string }; problem?: string }> {
    if (!this.managedDir) return {};
    const files = [join(this.managedDir, "managed-settings.json")];
    const dropIns = join(this.managedDir, "managed-settings.d");
    try {
      const names = (await this.fs.readdir(dropIns)).map((e) => e.name).filter((n) => n.endsWith(".json") && !n.startsWith("."));
      for (const name of names.sort()) files.push(join(dropIns, name));
    } catch (err) {
      const code = errorCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") return { problem: `${dropIns} can't be listed (${code})` };
    }
    let found: { value: unknown; file: string } | undefined;
    let problem: string | undefined;
    for (const file of files) {
      const r = await this.managedFiles.read(file);
      if (r.state === "missing") continue;
      if (r.state !== "ok") problem = describe(r);
      else if (r.value?.set) {
        found = { value: r.value.value, file };
        problem = undefined;
      }
    }
    if (problem) return { problem };
    return found ? { found } : {};
  }
}

function apply(info: RetentionInfo, source: "managed" | "user", found: { value: unknown; file: string }): void {
  info.source = source;
  info.file = found.file;
  if (isValidRetentionDays(found.value)) info.days = found.value;
  else info.invalid = invalidRetentionText(found.value);
}
