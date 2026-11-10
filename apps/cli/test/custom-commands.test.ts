// Custom command discovery against a synthetic tree: fake HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and
// GEMINI_CLI_HOME under a temp dir. Every file here is written by the test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CustomCommand } from "@signalbox/core";
import {
  DISCOVERY_LIMITS,
  discoverCustomCommands,
  isCredentialFile,
  isGeminiCredentialName,
  projectList,
  readFrontmatterFile,
  readSmallText,
} from "../src/custom-commands.ts";

let root: string;
let home: string;
let env: Record<string, string>;
let found: CustomCommand[];

function w(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const md = (fields: Record<string, string>, body = "Body text that must never be read.\n") =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n${body}`;

const work = () => join(root, "work");
const by = (agent: string, name: string, list = found) => list.filter((c) => c.agent === agent && c.name === name);
const one = (agent: string, name: string, list = found) => {
  const hits = by(agent, name, list);
  expect(hits, `${agent} ${name}`).toHaveLength(1);
  return hits[0]!;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "signalbox-custom-"));
  home = join(root, "home");
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const gemini = join(home, ".gemini");

  // ---- Claude Code, user scope
  const cmds = join(claude, "commands");
  w(join(cmds, "review.md"), md({ description: "Review the current diff", "argument-hint": "[file]" }));
  w(join(cmds, "git", "fix.md"), md({ description: '"Fix: the build"' }));
  w(join(cmds, "nofm.md"), "# Just a body\n\ndescription: not frontmatter\n");
  w(join(cmds, "hidden.md"), md({ description: "Model-only", "user-invocable": "false" }));
  w(join(cmds, "big.md"), md({ description: "too big" }, "x".repeat(DISCOVERY_LIMITS.maxFileBytes + 1)));
  // Names that only contain a credential word are ordinary commands; files named like a secret store are not.
  w(join(cmds, "token-helper.md"), md({ description: "Count tokens in a file" }));
  w(join(cmds, "author-tools.md"), md({ description: "Tools for authors" }));
  w(join(cmds, "secrets.md"), md({ description: "named like a secret store" }));
  w(join(cmds, "signing.key"), md({ description: "a key file" }));
  w(join(cmds, "unclosed.md"), `---\ndescription: never closes\n${"filler: line\n".repeat(7000)}`);
  w(join(cmds, "long.md"), md({ description: "word ".repeat(120) }));
  w(join(cmds, "ctrl.md"), md({ description: '"Bell\\u0007 and\\ttab"' }));
  w(join(cmds, "deploy", "SKILL.md"), md({ name: "deploy", description: "Deploy the app" }));
  w(join(cmds, "deploy", "notes.md"), md({ description: "part of the skill, not a command" }));
  w(join(cmds, ".secret.md"), md({ description: "hidden file" }));
  w(join(home, "shared", "cmd.md"), md({ description: "Linked from inside home" }));
  w(join(root, "outside", "x.md"), md({ description: "Outside every allowed folder" }));
  symlinkSync(join(home, "shared", "cmd.md"), join(cmds, "linked-ok.md"));
  symlinkSync(join(root, "outside", "x.md"), join(cmds, "linked-out.md"));
  symlinkSync(".", join(cmds, "loop"));
  // A skill linked into ~/.ssh is inside home but in a secret folder: never read.
  w(join(home, ".ssh", "config"), md({ description: "SSH config must never be read" }));
  mkdirSync(join(claude, "skills", "ssh"), { recursive: true });
  symlinkSync(join(home, ".ssh", "config"), join(claude, "skills", "ssh", "SKILL.md"));
  w(join(claude, "skills", "pdf", "SKILL.md"), md({ name: "pdf-tools", description: "Work with PDFs" }));
  w(join(claude, "skills", "noskill", "README.md"), "not a skill");
  w(join(claude, "skills", "count-tokens", "SKILL.md"), md({ name: "count-tokens", description: "Count tokens" }));
  // A skills-dir plugin (claude plugin init): loaded as a plugin, not as a skill.
  w(join(claude, "skills", "sdplug", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sdplug" }));
  w(join(claude, "skills", "sdplug", "skills", "s1", "SKILL.md"), md({ description: "Skills-dir plugin skill" }));

  // ---- Claude Code plugins
  const cache = join(claude, "plugins", "cache", "market");
  const tools = join(cache, "tools", "1.0.0");
  w(join(tools, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools", commands: ["./extra/more.md", "../../../../../../outside"] }));
  w(join(tools, "commands", "lint.md"), md({ description: "Lint everything" }));
  w(join(tools, "commands", "sub", "deep.md"), md({ description: "Nested plugin command" }));
  w(join(tools, "skills", "fmt", "SKILL.md"), md({ description: "Format code" }));
  w(join(tools, "extra", "more.md"), md({ description: "From the manifest's extra path" }));
  symlinkSync(join(root, "outside", "x.md"), join(tools, "commands", "escape.md"));
  const proj = join(cache, "proj", "2.0.0");
  w(join(proj, "commands", "p.md"), md({ description: "Project-installed plugin" }));
  const other = join(cache, "other", "1.0.0");
  w(join(other, "commands", "o.md"), md({ description: "Installed for another project" }));
  w(
    join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "tools@market": [{ scope: "user", installPath: tools, version: "1.0.0" }],
        "proj@market": [{ scope: "project", projectPath: join(work(), "app"), installPath: proj }],
        "other@market": [{ scope: "local", projectPath: join(root, "elsewhere"), installPath: other }],
        "broken@market": [{ scope: "user", installPath: "relative/path" }],
      },
    }),
  );

  // ---- shared ~/.agents/skills (Codex and Gemini CLI)
  const agents = join(home, ".agents", "skills");
  w(join(agents, "browse", "SKILL.md"), md({ name: "browse", description: "Drive a browser" }));
  w(join(agents, "group", "deep", "SKILL.md"), md({ name: "deep-one", description: "Nested two levels" }));
  w(join(agents, "noname", "SKILL.md"), md({ description: "No name: Codex and Gemini skip it" }));
  // Outside .gemini a word like "oauth" in a skill's folder name doesn't hide it, for Codex or Gemini.
  w(join(agents, "oauth-flow", "SKILL.md"), md({ name: "oauth-flow", description: "Walk through an OAuth flow" }));

  // ---- Codex
  w(join(codex, "auth.json"), '{"synthetic":"decoy"}');
  w(join(codex, "skills", ".system", "sys", "SKILL.md"), md({ name: "bundled", description: "System skill" }));
  w(join(codex, "skills", "mine", "SKILL.md"), md({ name: "mine", description: "My Codex skill" }));
  w(join(codex, "prompts", "draft.md"), md({ description: "Draft a PR body", "argument-hint": "[topic]" }));
  const plugOld = join(codex, "plugins", "cache", "mk", "plug", "0.1.0");
  const plugNew = join(codex, "plugins", "cache", "mk", "plug", "0.2.0");
  w(join(plugOld, "skills", "s", "SKILL.md"), md({ name: "old", description: "Old version" }));
  w(join(plugNew, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plug" }));
  w(join(plugNew, "skills", "s", "SKILL.md"), md({ name: "s", description: "Plugin skill" }));
  const past = new Date(Date.now() - 86_400_000);
  utimesSync(plugOld, past, past);

  // ---- DeepSeek Harness (it also reads the shared ~/.agents/skills above, top level only)
  const dsh = join(home, ".dsh");
  w(join(dsh, ".credentials.yaml"), "synthetic: decoy\n");
  w(join(dsh, "skills", ".system", "sys", "SKILL.md"), md({ name: "bundled-dsh", description: "System skill" }));
  w(join(dsh, "skills", "release-check", "SKILL.md"), md({ name: "release-check", description: "Check a release branch" }));
  w(join(dsh, "skills", "flat-one.md"), md({ name: "flat-one", description: "A flat skill file" }));
  w(join(dsh, "skills", "group", "deep", "SKILL.md"), md({ name: "too-deep", description: "Nested: the harness does not look here" }));
  w(join(dsh, "skills", "nodesc", "SKILL.md"), md({ name: "nodesc" }));
  w(join(dsh, "skills", "badname", "SKILL.md"), md({ name: "Bad_Name", description: "Not kebab-case" }));
  w(join(dsh, "skills", "model-only", "SKILL.md"), md({ name: "model-only", description: "Kept out of the menu", "user-invocable": "no" }));
  w(join(dsh, "skills", "zero", "SKILL.md"), md({ name: "zero", description: "Kept out of the menu too", "user-invocable": "0" }));
  w(join(dsh, "skills", "menu-on", "SKILL.md"), md({ name: "menu-on", description: "Switched on in so many words", "user-invocable": "Yes" }));
  // Only the model is kept from calling it: the menu still has it.
  w(join(dsh, "skills", "by-hand", "SKILL.md"), md({ name: "by-hand", description: "Typed, never model-picked", "disable-model-invocation": "true" }));
  // The harness drops a skill whose switch isn't a boolean, or is spelled in camel case.
  w(join(dsh, "skills", "maybe", "SKILL.md"), md({ name: "maybe", description: "A switch that is no boolean", "user-invocable": "maybe" }));
  w(join(dsh, "skills", "sometimes", "SKILL.md"), md({ name: "sometimes", description: "Another one", "disable-model-invocation": "sometimes" }));
  w(join(dsh, "skills", "camel", "SKILL.md"), md({ name: "camel", description: "A rejected spelling", userInvocable: "true" }));
  // A skill named like a built-in command never runs: the command wins.
  w(join(dsh, "skills", "plan", "SKILL.md"), md({ name: "plan", description: "Shadowed by /plan" }));
  // A skill named like one the harness ships replaces the shipped one.
  w(join(dsh, "skills", "office-docx", "SKILL.md"), md({ name: "office-docx", description: "My own Word workflow" }));
  w(join(dsh, "skills", "README.md"), "# Notes about my skills\n");

  // ---- Gemini CLI
  w(join(gemini, "oauth_creds.json"), '{"synthetic":"decoy"}');
  w(join(gemini, "commands", "commit.toml"), 'prompt = """\nWrite the commit. BODY-MARKER\n"""\ndescription = "Commit staged changes"\n');
  w(join(gemini, "commands", "git", "push it.toml"), 'prompt = "push"\n');
  w(join(gemini, "commands", "bad.toml"), 'description = "no prompt"\n');
  // Inside ~/.gemini any name with token, oauth or credential is never opened (the hard rule).
  w(join(gemini, "commands", "oauth-login.toml"), 'prompt = "x"\ndescription = "never read"\n');
  w(join(gemini, "skills", "token-count", "SKILL.md"), md({ name: "token-count", description: "never read" }));
  w(join(gemini, "skills", "g1", "SKILL.md"), md({ name: "g one", description: "Gemini skill" }));
  w(join(gemini, "extensions", "ext1", "gemini-extension.json"), JSON.stringify({ name: "ext1" }));
  w(join(gemini, "extensions", "ext1", ".env"), "SECRET=synthetic");
  w(join(gemini, "extensions", "ext1", "commands", "e.toml"), 'prompt = "e"\ndescription = "Extension command"\n');
  w(join(gemini, "extensions", "ext1", "skills", "es", "SKILL.md"), md({ name: "es", description: "Extension skill" }));
  w(join(gemini, "extensions", "linked", ".gemini-extension-install.json"), JSON.stringify({ type: "link", source: join(root, "extsrc") }));
  w(join(root, "extsrc", "gemini-extension.json"), JSON.stringify({ name: "lnk" }));
  w(join(root, "extsrc", "commands", "l.toml"), 'prompt = "l"\ndescription = "Linked extension command"\n');

  // ---- Projects
  const app = join(work(), "app");
  mkdirSync(join(app, ".git"), { recursive: true });
  w(join(app, ".claude", "commands", "proj.md"), md({ description: "Project command" }));
  w(join(app, ".claude", "skills", "ps", "SKILL.md"), md({ description: "Project skill" }));
  w(join(app, ".agents", "skills", "ps", "SKILL.md"), md({ name: "ps", description: "Codex project skill" }));
  w(join(app, ".dsh", "skills", "deploy-notes", "SKILL.md"), md({ name: "deploy-notes", description: "Harness project skill" }));
  // The harness reads a project's skills at its git root only, not in a subfolder between the root and the cwd.
  w(join(app, "sub", ".dsh", "skills", "inner", "SKILL.md"), md({ name: "inner-skill", description: "Below the project root" }));
  w(join(app, ".gemini", "commands", "g.toml"), 'prompt = "g"\ndescription = "Gemini project command"\n');
  w(join(app, "sub", ".claude", "commands", "inner.md"), md({ description: "Subfolder command" }));
  w(join(work(), ".claude", "commands", "above-git.md"), md({ description: "Above the git root: not loaded" }));
  const evil = join(work(), "evil");
  mkdirSync(join(evil, ".git"), { recursive: true });
  mkdirSync(join(evil, ".claude"), { recursive: true });
  symlinkSync(join(root, "outside"), join(evil, ".claude", "commands"));
  w(join(work(), "notscanned", ".claude", "commands", "x.md"), md({ description: "No session here" }));

  env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, DSH_HOME: dsh, GEMINI_CLI_HOME: home };
  found = await discoverCustomCommands({ env, home, projects: [join(app, "sub"), app, evil, "relative/ignored"] });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Claude Code", () => {
  test("user commands: frontmatter description, namespaces from folders, a SKILL.md folder is one command", () => {
    expect(one("claude-code", "/review")).toEqual({
      agent: "claude-code",
      name: "/review",
      description: "Review the current diff",
      kind: "command",
      scope: "user",
      source: "~/.claude/commands/review.md",
    });
    expect(one("claude-code", "/git:fix").description).toBe("Fix: the build");
    expect(one("claude-code", "/deploy")).toMatchObject({ description: "Deploy the app", source: "~/.claude/commands/deploy/SKILL.md" });
    expect(by("claude-code", "/deploy:notes")).toEqual([]);
  });

  test("no frontmatter means no description (the body is never used)", () => {
    const c = one("claude-code", "/nofm");
    expect(c.description).toBeUndefined();
    expect(one("claude-code", "/unclosed").description).toBeUndefined();
  });

  test("descriptions are one printable line of at most 200 characters", () => {
    const long = one("claude-code", "/long").description!;
    expect([...long].length).toBe(200);
    expect(one("claude-code", "/ctrl").description).toBe("Bell and tab");
  });

  test("skipped: user-invocable false, over 256 KB, files named like a secret store, hidden files", () => {
    for (const n of ["/hidden", "/big", "/secrets", "/signing", "/.secret", "/secret"]) expect(by("claude-code", n), n).toEqual([]);
  });

  test("names that merely contain a credential word are listed", () => {
    expect(one("claude-code", "/token-helper").description).toBe("Count tokens in a file");
    expect(one("claude-code", "/author-tools").description).toBe("Tools for authors");
    expect(one("claude-code", "/count-tokens")).toMatchObject({ kind: "skill", description: "Count tokens" });
  });

  test("symlinks: inside home followed in user folders, outside ignored, loops harmless", () => {
    expect(one("claude-code", "/linked-ok")).toMatchObject({ description: "Linked from inside home", source: "~/.claude/commands/linked-ok.md" });
    expect(by("claude-code", "/linked-out")).toEqual([]);
    expect(found.some((c) => c.name.startsWith("/loop"))).toBe(false);
    expect(found.some((c) => c.description === "Outside every allowed folder")).toBe(false);
    expect(by("claude-code", "/ssh")).toEqual([]);
    expect(found.some((c) => c.description === "SSH config must never be read")).toBe(false);
  });

  test("user skills are named after their folder", () => {
    expect(one("claude-code", "/pdf")).toMatchObject({ kind: "skill", scope: "user", description: "Work with PDFs", source: "~/.claude/skills/pdf/SKILL.md" });
    expect(by("claude-code", "/noskill")).toEqual([]);
  });

  test("plugins: /<plugin>:<name> for commands, nested commands, skills and manifest paths inside the plugin", () => {
    expect(one("claude-code", "/tools:lint")).toEqual({
      agent: "claude-code",
      name: "/tools:lint",
      description: "Lint everything",
      kind: "plugin-command",
      scope: "plugin",
      source: "tools",
    });
    expect(one("claude-code", "/tools:sub:deep").kind).toBe("plugin-command");
    expect(one("claude-code", "/tools:fmt")).toMatchObject({ kind: "plugin-skill", description: "Format code" });
    expect(one("claude-code", "/tools:more").description).toBe("From the manifest's extra path");
    // A manifest path or a symlink leading out of the plugin folder is ignored.
    expect(by("claude-code", "/tools:escape")).toEqual([]);
    expect(by("claude-code", "/tools:x")).toEqual([]);
    expect(one("claude-code", "/sdplug:s1")).toMatchObject({ kind: "plugin-skill", scope: "plugin", source: "sdplug" });
    expect(by("claude-code", "/sdplug")).toEqual([]);
  });

  test("project-scoped plugin installs only for a session's project", () => {
    expect(one("claude-code", "/proj:p")).toMatchObject({ scope: "plugin", project: join(work(), "app") });
    expect(by("claude-code", "/other:o")).toEqual([]);
  });

  test("project commands: each cwd up to its git root, never above it, never other folders", () => {
    expect(one("claude-code", "/proj")).toMatchObject({ scope: "project", project: join(work(), "app"), source: join(work(), "app", ".claude", "commands", "proj.md") });
    expect(one("claude-code", "/ps")).toMatchObject({ kind: "skill", scope: "project", project: join(work(), "app") });
    expect(one("claude-code", "/inner")).toMatchObject({ project: join(work(), "app", "sub") });
    expect(by("claude-code", "/above-git")).toEqual([]);
    expect(by("claude-code", "/x")).toEqual([]);
  });

  test("a project's .claude/commands symlinked outside the project is not scanned", () => {
    expect(found.some((c) => c.project === join(work(), "evil"))).toBe(false);
  });
});

describe("Codex", () => {
  test("skills by frontmatter name, typed as $name; nested folders searched; .system and nameless skipped", () => {
    expect(one("codex", "$browse")).toEqual({
      agent: "codex",
      name: "$browse",
      description: "Drive a browser",
      kind: "skill",
      scope: "user",
      source: "~/.agents/skills/browse/SKILL.md",
    });
    expect(one("codex", "$deep-one").source).toBe("~/.agents/skills/group/deep/SKILL.md");
    expect(one("codex", "$mine").source).toBe("~/.codex/skills/mine/SKILL.md");
    expect(by("codex", "$bundled")).toEqual([]);
    expect(found.some((c) => c.agent === "codex" && c.description?.startsWith("No name"))).toBe(false);
  });

  test("project skills from .agents/skills between the git root and the cwd", () => {
    expect(one("codex", "$ps")).toMatchObject({ scope: "project", project: join(work(), "app"), description: "Codex project skill" });
  });

  test("legacy prompts as /prompts:<name>", () => {
    expect(one("codex", "/prompts:draft")).toMatchObject({ kind: "prompt", scope: "user", description: "Draft a PR body" });
  });

  test("plugin skills from the newest cached version, as $<plugin>:<name>", () => {
    expect(one("codex", "$plug:s")).toMatchObject({ kind: "plugin-skill", scope: "plugin", source: "plug" });
    expect(by("codex", "$plug:old")).toEqual([]);
  });
});

describe("DeepSeek Harness", () => {
  const mine = () => found.filter((c) => c.agent === "deepseek-harness");

  test("skills by frontmatter name, typed as /name: a SKILL.md folder or a flat file, top level only", () => {
    expect(one("deepseek-harness", "/release-check")).toEqual({
      agent: "deepseek-harness",
      name: "/release-check",
      description: "Check a release branch",
      kind: "skill",
      scope: "user",
      source: "~/.dsh/skills/release-check/SKILL.md",
    });
    expect(one("deepseek-harness", "/flat-one")).toMatchObject({ kind: "skill", scope: "user", source: "~/.dsh/skills/flat-one.md" });
    // The shared agents folder, which Codex reads too (and searches deeper than the harness does).
    expect(one("deepseek-harness", "/browse").source).toBe("~/.agents/skills/browse/SKILL.md");
    expect(one("deepseek-harness", "/oauth-flow").description).toBe("Walk through an OAuth flow");
    expect(by("deepseek-harness", "/deep-one")).toEqual([]);
    expect(by("deepseek-harness", "/too-deep")).toEqual([]);
    expect(by("deepseek-harness", "/bundled-dsh")).toEqual([]);
  });

  test("a skill needs a kebab-case name and a description, and can be kept out of the menu", () => {
    for (const name of ["/nodesc", "/Bad_Name", "/badname", "/model-only", "/zero", "/README"]) expect(by("deepseek-harness", name), name).toEqual([]);
    expect(mine().some((c) => c.description?.startsWith("No name"))).toBe(false);
    expect(one("deepseek-harness", "/menu-on").description).toBe("Switched on in so many words");
    expect(one("deepseek-harness", "/by-hand").description).toBe("Typed, never model-picked");
  });

  test("a switch that is no boolean, or a camel-case spelling of one, drops the skill as the harness does", () => {
    for (const name of ["/maybe", "/sometimes", "/camel"]) expect(by("deepseek-harness", name), name).toEqual([]);
  });

  test("a skill named like a built-in command is not listed: the command wins", () => {
    expect(by("deepseek-harness", "/plan")).toEqual([]);
  });

  test("a skill named like one the harness ships is listed: it replaces the shipped one", () => {
    expect(one("deepseek-harness", "/office-docx")).toMatchObject({ description: "My own Word workflow", scope: "user", source: "~/.dsh/skills/office-docx/SKILL.md" });
  });

  test("project skills from .dsh/skills and .agents/skills at the project's git root", () => {
    const app = join(work(), "app");
    expect(one("deepseek-harness", "/deploy-notes")).toEqual({
      agent: "deepseek-harness",
      name: "/deploy-notes",
      description: "Harness project skill",
      kind: "skill",
      scope: "project",
      source: join(app, ".dsh", "skills", "deploy-notes", "SKILL.md"),
      project: app,
    });
    expect(one("deepseek-harness", "/ps")).toMatchObject({ scope: "project", project: app, description: "Codex project skill" });
    expect(by("deepseek-harness", "/inner-skill")).toEqual([]);
  });

  test("DSH_HOME and DSH_AGENTS_HOME move the folders; a blank value means the default", async () => {
    const elsewhere = join(root, "elsewhere-dsh");
    const shared = join(root, "elsewhere-agents");
    w(join(elsewhere, "skills", "moved", "SKILL.md"), md({ name: "moved", description: "In a moved harness home" }));
    w(join(shared, "skills", "shared-one", "SKILL.md"), md({ name: "shared-one", description: "In a moved agents folder" }));
    const moved = await discoverCustomCommands({ env: { ...env, DSH_HOME: elsewhere, DSH_AGENTS_HOME: shared }, home, projects: [] });
    expect(moved.filter((c) => c.agent === "deepseek-harness").map((c) => c.name)).toEqual(["/moved", "/shared-one"]);
    const blank = await discoverCustomCommands({ env: { ...env, DSH_HOME: "  ", DSH_AGENTS_HOME: "" }, home, projects: [] });
    expect(blank.filter((c) => c.agent === "deepseek-harness").map((c) => c.name)).toEqual(["/browse", "/by-hand", "/flat-one", "/menu-on", "/oauth-flow", "/office-docx", "/release-check"]);
  });

  test("nothing but skill frontmatter is read in the harness home", () => {
    expect(JSON.stringify(mine())).not.toContain("decoy");
    expect(JSON.stringify(mine())).not.toContain("Body text");
  });
});

describe("Gemini CLI", () => {
  test("TOML commands: description only, cleaned names, files without a prompt skipped", () => {
    expect(one("gemini-cli", "/commit")).toEqual({
      agent: "gemini-cli",
      name: "/commit",
      description: "Commit staged changes",
      kind: "command",
      scope: "user",
      source: "~/.gemini/commands/commit.toml",
    });
    expect(one("gemini-cli", "/git:push_it").description).toBeUndefined();
    expect(by("gemini-cli", "/bad")).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("BODY-MARKER");
  });

  test("skills need a name and a description; one level deep only", () => {
    expect(one("gemini-cli", "/g-one")).toMatchObject({ kind: "skill", description: "Gemini skill" });
    expect(one("gemini-cli", "/browse").source).toBe("~/.agents/skills/browse/SKILL.md");
    expect(by("gemini-cli", "/deep-one")).toEqual([]);
  });

  test("extensions: commands as plugin commands, skills as /<ext>:<name>, linked extensions followed", () => {
    expect(one("gemini-cli", "/e")).toMatchObject({ kind: "plugin-command", scope: "plugin", source: "ext1", description: "Extension command" });
    expect(one("gemini-cli", "/ext1:es")).toMatchObject({ kind: "plugin-skill", source: "ext1" });
    expect(one("gemini-cli", "/l")).toMatchObject({ source: "lnk", description: "Linked extension command" });
  });

  test("project commands from each cwd's .gemini/commands", () => {
    expect(one("gemini-cli", "/g")).toMatchObject({ scope: "project", project: join(work(), "app") });
  });
});

describe("safety and limits", () => {
  test("credential files are recognised by exact name or extension", () => {
    for (const n of ["auth.json", "oauth_creds.json", ".credentials.json", "control.key", "server.pem", ".env", ".env.local", "secrets.md", "api_key.md", "id_ed25519"]) {
      expect(isCredentialFile(n), n).toBe(true);
    }
    for (const n of ["review.md", "SKILL.md", "plugin.json", "commit.toml", "author-tools.md", "count-tokens", "secrets-audit", "oauth-flow", "password-gen", "github-auth"]) {
      expect(isCredentialFile(n), n).toBe(false);
    }
    // Inside .gemini the rule is wider.
    for (const n of ["mcp-oauth-tokens.json", "oauth-login.toml", "token-count", "credential-helper", "auth.json"]) expect(isGeminiCredentialName(n), n).toBe(true);
    for (const n of ["commit.toml", "SKILL.md", "author-tools"]) expect(isGeminiCredentialName(n), n).toBe(false);
  });

  test("Gemini: names with token, oauth or credential inside .gemini are never read; outside they are listed", () => {
    expect(by("gemini-cli", "/oauth-login")).toEqual([]);
    expect(by("gemini-cli", "/token-count")).toEqual([]);
    expect(found.some((c) => c.description === "never read")).toBe(false);
    expect(one("gemini-cli", "/oauth-flow").source).toBe("~/.agents/skills/oauth-flow/SKILL.md");
    expect(one("codex", "$oauth-flow").description).toBe("Walk through an OAuth flow");
  });

  test("the readers refuse credential files and .gemini credential names even when called directly", async () => {
    expect(await readFrontmatterFile(join(home, ".claude", "commands", "signing.key"))).toBeUndefined();
    expect(await readFrontmatterFile(join(home, ".claude", "commands", "secrets.md"))).toBeUndefined();
    expect(await readSmallText(join(home, ".gemini", "commands", "oauth-login.toml"))).toBeUndefined();
    expect(await readSmallText(join(home, ".gemini", "oauth_creds.json"))).toBeUndefined();
    expect(await readFrontmatterFile(join(home, ".claude", "commands", "token-helper.md"))).toMatchObject({ description: "Count tokens in a file" });
    expect(await readFrontmatterFile(join(home, ".claude", "commands", "review.md"))).toMatchObject({ description: "Review the current diff" });
  });

  test("output is sorted by agent and name and has no repeats", () => {
    const keys = found.map((c) => `${c.agent} ${c.name} ${c.scope} ${c.project ?? ""} ${c.source}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...found].sort((a, b) => (a.agent === b.agent ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.agent < b.agent ? -1 : 1));
    expect(found.map((c) => `${c.agent} ${c.name}`)).toEqual(sorted.map((c) => `${c.agent} ${c.name}`));
  });

  test("files read per scan root are capped", async () => {
    const few = await discoverCustomCommands({ env, home, projects: [], limits: { maxFilesPerRoot: 2 } });
    const userCommands = few.filter((c) => c.agent === "claude-code" && c.scope === "user" && c.kind === "command");
    expect(userCommands.length).toBeLessThanOrEqual(2);
  });

  test("no projects: no project entries; missing homes: nothing, no throw", async () => {
    const userOnly = await discoverCustomCommands({ env, home, projects: [] });
    expect(userOnly.some((c) => c.scope === "project")).toBe(false);
    const empty = join(root, "empty-home");
    mkdirSync(empty);
    expect(await discoverCustomCommands({ env: {}, home: empty, projects: [join(root, "missing")] })).toEqual([]);
  });

  test("projectList keeps distinct absolute paths only, up to the cap", () => {
    expect(projectList(["/a/b", "/a/b/", "rel", "/c"], 10)).toEqual(["/a/b", "/c"]);
    expect(projectList(["/1", "/2", "/3"], 2)).toHaveLength(2);
  });
});
