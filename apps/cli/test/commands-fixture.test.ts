// Guards the command guide's CLI ↔ macOS app contract from the CLI side, like stream-fixture.test.ts does for
// the stream. The app's tests and snapshot renders read apps/macos/Fixtures/commands.json; its Swift contract
// test fails when decoding loses a field of that file. This test runs the real `signalbox commands --json` on
// synthetic homes holding every kind and scope of custom command, and fails when the CLI sends a key path, a
// custom kind or a scope the fixture doesn't have, or when the fixture's catalogs are older than the embedded ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embeddedCommandCatalogs, type CommandsSnapshot } from "@signalbox/core";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
/** SIGNALBOX_COMMANDS_FIXTURE checks a candidate fixture (e.g. a regenerated copy) before it is committed. */
const FIXTURE = process.env.SIGNALBOX_COMMANDS_FIXTURE || join(import.meta.dir, "..", "..", "macos", "Fixtures", "commands.json");
const REGENERATE = "bun apps/macos/scripts/make-commands-fixture.ts > apps/macos/Fixtures/commands.json, then `swift test` in apps/macos";

let root: string;
let fresh: CommandsSnapshot;

function w(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}
const md = (description: string, name?: string) => `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\nsynthetic body\n`;

/** Every key path, arrays as `[]` and the agent keys of `installed` as `<agent>`: "custom[].project". */
function keyPaths(value: unknown, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keyPaths(v, `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const p = path === "installed" ? `${path}.<agent>` : path ? `${path}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "signalbox-commands-fixture-"));
  const home = join(root, "home");
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const gemini = join(home, ".gemini");
  const proj = join(root, "work", "app");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(claude, "projects"), { recursive: true });
  mkdirSync(join(root, "tmp"));
  // A live Claude Code session in `proj` (the registry row points at this test's pid): its folder is project scope.
  w(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "88888888-8888-4888-8888-888888888888", cwd: proj, status: "busy", kind: "interactive", entrypoint: "cli" }));

  // Claude Code: user and project commands and skills, a plugin with a command and a skill.
  w(join(claude, "commands", "release-notes.md"), md("Draft release notes"));
  w(join(claude, "commands", "bare.md"), "no frontmatter, so no description\n");
  w(join(claude, "skills", "pdf-tools", "SKILL.md"), md("Work with PDFs", "pdf-tools"));
  w(join(proj, ".claude", "commands", "ship.md"), md("Ship it"));
  w(join(proj, ".claude", "skills", "probe", "SKILL.md"), md("Project skill"));
  const plugin = join(claude, "plugins", "cache", "market", "acme", "1.0.0");
  w(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
  w(join(plugin, "commands", "lint.md"), md("Lint everything"));
  w(join(plugin, "skills", "triage", "SKILL.md"), md("Triage issues"));
  w(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "acme@market": [{ scope: "user", installPath: plugin }] } }));

  // Codex: user and project skills, a legacy prompt, a plugin skill.
  w(join(home, ".agents", "skills", "changelog", "SKILL.md"), md("Keep the changelog", "changelog"));
  w(join(proj, ".agents", "skills", "api-docs", "SKILL.md"), md("Regenerate API docs", "api-docs"));
  w(join(codex, "prompts", "draft.md"), md("Draft a PR body"));
  const cplugin = join(codex, "plugins", "cache", "mk", "plug", "0.2.0");
  w(join(cplugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plug" }));
  w(join(cplugin, "skills", "s", "SKILL.md"), md("Plugin skill", "s"));

  // Gemini CLI: user and project TOML commands, a skill, an extension with a command and a skill.
  w(join(gemini, "commands", "commit.toml"), 'prompt = "synthetic"\ndescription = "Commit staged changes"\n');
  w(join(proj, ".gemini", "commands", "g.toml"), 'prompt = "synthetic"\ndescription = "Project command"\n');
  w(join(gemini, "skills", "g1", "SKILL.md"), md("Gemini skill", "g1"));
  w(join(gemini, "extensions", "ext1", "gemini-extension.json"), JSON.stringify({ name: "ext1" }));
  w(join(gemini, "extensions", "ext1", "commands", "e.toml"), 'prompt = "synthetic"\ndescription = "Extension command"\n');
  w(join(gemini, "extensions", "ext1", "skills", "es", "SKILL.md"), md("Extension skill", "es"));

  // Fake agent CLIs that answer --version (shell builtins only).
  const bin = join(root, "bin");
  const fake = (name: string, version: string) => w(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nexit 3\n`, 0o755);
  fake("claude", "2.1.293 (Claude Code)");
  fake("codex", "codex-cli 0.161.0");
  fake("gemini", "0.63.0");

  const proc = Bun.spawn([process.execPath, MAIN, "commands", "--json"], {
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      GEMINI_CLI_HOME: home,
      SIGNALBOX_CLAUDE_BIN: join(bin, "claude"),
      SIGNALBOX_BIN_DIRS: "",
      PATH: bin,
      TMPDIR: join(root, "tmp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`signalbox commands --json exited ${code}: ${err}`);
  fresh = JSON.parse(out) as CommandsSnapshot;
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("apps/macos/Fixtures/commands.json", () => {
  test("the synthetic run covers every agent, kind and scope (so the checks below mean something)", () => {
    expect(Object.keys(fresh.installed).sort()).toEqual(["claude-code", "codex", "gemini-cli"]);
    const combos = new Set(fresh.custom.map((c) => `${c.agent} ${c.kind} ${c.scope}`));
    for (const combo of [
      "claude-code command user",
      "claude-code command project",
      "claude-code skill user",
      "claude-code skill project",
      "claude-code plugin-command plugin",
      "claude-code plugin-skill plugin",
      "codex skill user",
      "codex skill project",
      "codex prompt user",
      "codex plugin-skill plugin",
      "gemini-cli command user",
      "gemini-cli command project",
      "gemini-cli skill user",
      "gemini-cli plugin-command plugin",
      "gemini-cli plugin-skill plugin",
    ]) {
      expect(combos.has(combo), combo).toBe(true);
    }
  });

  test("has every key path `signalbox commands --json` sends", () => {
    const committed = keyPaths(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const missing = [...keyPaths(fresh)].filter((p) => !committed.has(p)).sort();
    // If this fails: add the field to make-commands-fixture.ts and the Swift models, then REGENERATE.
    expect(missing).toEqual([]);
  });

  test("has every custom command kind and scope the CLI sends", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as CommandsSnapshot;
    for (const field of ["kind", "scope"] as const) {
      const known = new Set(fixture.custom.map((c) => c[field]));
      const missing = [...new Set(fresh.custom.map((c) => c[field]))].filter((v) => !known.has(v)).sort();
      expect(missing, `custom[].${field}`).toEqual([]);
    }
  });

  test("carries the embedded catalogs as they are now", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as CommandsSnapshot;
    expect(fresh.catalogs).toEqual(embeddedCommandCatalogs());
    // If this fails, a catalog changed after the fixture was made: REGENERATE.
    expect(fixture.catalogs, REGENERATE).toEqual(embeddedCommandCatalogs());
  });
});
