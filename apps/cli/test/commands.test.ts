// The command guide: CommandGuide in-process with fake agent binaries, the text format, and the real
// `signalbox commands` in a sandbox (temp HOME, empty PATH, no fallback binary dirs).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embeddedCommandCatalogs, type CommandsSnapshot, type SessionInfo } from "@signalbox/core";
import { parseArgs, UsageError } from "../src/args.ts";
import { agentBinaries, CATALOG_AGENTS, CommandGuide, filterSnapshot, formatCommands, parseVersion } from "../src/commands.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
let root: string;

function w(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/** A fake agent CLI that answers --version and counts its runs. Shell builtins only. */
function fakeBin(path: string, version: string, runs: string): void {
  w(path, `#!/bin/sh\necho run >> '${runs}'\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nexit 3\n`, 0o755);
}
const count = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-commands-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseVersion", () => {
  test("finds the version in each agent's --version output", () => {
    expect(parseVersion("2.1.293 (Claude Code)")).toBe("2.1.293");
    expect(parseVersion("codex-cli 0.161.0")).toBe("0.161.0");
    expect(parseVersion("0.63.0")).toBe("0.63.0");
    expect(parseVersion("1.2.3-beta.1 build")).toBe("1.2.3-beta.1");
    expect(parseVersion("no version here")).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
  });
});

describe("args", () => {
  test("commands [--agent ID] [--verbose | --json]", () => {
    expect(parseArgs(["commands"], ["claude-code"], CATALOG_AGENTS)).toEqual({ command: "commands", json: false, verbose: false });
    expect(parseArgs(["commands", "--json", "--agent", "gemini-cli"], ["claude-code"], CATALOG_AGENTS)).toEqual({ command: "commands", json: true, verbose: false, agent: "gemini-cli" });
    expect(() => parseArgs(["commands", "--agent", "cursor"], ["claude-code"], CATALOG_AGENTS)).toThrow(UsageError);
    expect(() => parseArgs(["commands", "--json", "--verbose"], ["claude-code"], CATALOG_AGENTS)).toThrow(UsageError);
  });

  test("every agent with a catalog has a binary to ask for its version", () => {
    expect([...CATALOG_AGENTS]).toEqual(["claude-code", "codex", "gemini-cli"]);
    expect(agentBinaries().map((b) => b.agent).sort()).toEqual([...CATALOG_AGENTS]);
  });
});

describe("CommandGuide", () => {
  test("snapshot shape: v, generatedAt, installed, catalogs, custom", async () => {
    const home = join(root, "shape-home");
    mkdirSync(home, { recursive: true });
    const guide = new CommandGuide({ sessions: async () => [], env: { SIGNALBOX_BIN_DIRS: "", PATH: "" }, home, now: () => new Date("2026-10-10T12:00:00Z") });
    const snap = await guide.snapshot();
    expect(Object.keys(snap)).toEqual(["v", "generatedAt", "installed", "catalogs", "custom"]);
    expect(snap).toMatchObject({ v: 1, generatedAt: "2026-10-10T12:00:00.000Z", installed: {}, custom: [] });
    expect(snap.catalogs).toEqual(embeddedCommandCatalogs());
  });

  test("installed versions: --version runs once per binary, again after the binary changes", async () => {
    const home = join(root, "ver-home");
    const bin = join(root, "ver-bin");
    const runs = join(root, "ver-runs");
    fakeBin(join(bin, "claude"), "2.1.293 (Claude Code)", runs);
    fakeBin(join(bin, "codex"), "codex-cli 0.161.0", runs);
    mkdirSync(home, { recursive: true });
    const guide = new CommandGuide({ sessions: async () => [], env: { PATH: bin, SIGNALBOX_BIN_DIRS: "" }, home });
    expect(await guide.installed()).toEqual({ "claude-code": "2.1.293", codex: "0.161.0" });
    expect(count(runs)).toBe(2);
    await guide.snapshot();
    await guide.snapshot();
    expect(count(runs)).toBe(2);
    // An update: different contents and mtime.
    fakeBin(join(bin, "claude"), "2.1.300 (Claude Code)", runs);
    const later = new Date(Date.now() + 5000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(bin, "claude"), later, later);
    expect((await guide.snapshot()).installed).toEqual({ "claude-code": "2.1.300", codex: "0.161.0" });
    expect(count(runs)).toBe(3);
  });

  test("a binary that fails --version is left out (unknown), not guessed", async () => {
    const bin = join(root, "bad-bin");
    w(join(bin, "codex"), "#!/bin/sh\nexit 1\n", 0o755);
    const guide = new CommandGuide({ sessions: async () => [], env: { PATH: bin, SIGNALBOX_BIN_DIRS: "", SIGNALBOX_CLAUDE_BIN: "/nonexistent" }, home: root });
    expect(await guide.installed()).toEqual({});
  });

  test("custom commands: project scope comes from the sessions' cwds only; a failing session list means none", async () => {
    const home = join(root, "proj-home");
    const proj = join(root, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    w(join(proj, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\nbody\n");
    w(join(home, ".claude", "commands", "mine.md"), "---\ndescription: Mine\n---\n");
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), GEMINI_CLI_HOME: home, PATH: "", SIGNALBOX_BIN_DIRS: "" };
    const session = { agent: "claude-code", sessionId: "s1", cwd: proj, status: "busy", source: "test" } satisfies SessionInfo;
    const withProject = await new CommandGuide({ sessions: async () => [session], env, home }).snapshot();
    expect(withProject.custom.map((c) => `${c.name} ${c.scope}`)).toEqual(["/mine user", "/ship project"]);
    expect(withProject.custom[1]).toMatchObject({ project: proj, description: "Ship it" });
    const failing = await new CommandGuide({ sessions: () => Promise.reject(new Error("no fleet")), env, home }).snapshot();
    expect(failing.custom.map((c) => c.name)).toEqual(["/mine"]);
  });

  test("concurrent snapshots share one build", async () => {
    let calls = 0;
    const guide = new CommandGuide({
      sessions: async () => {
        calls++;
        return [];
      },
      env: { PATH: "", SIGNALBOX_BIN_DIRS: "" },
      home: root,
    });
    const [a, b] = await Promise.all([guide.snapshot(), guide.snapshot()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});

describe("filterSnapshot and formatCommands", () => {
  const snap: CommandsSnapshot = {
    v: 1,
    generatedAt: "2026-10-10T12:00:00.000Z",
    installed: { "claude-code": "2.1.300", codex: "0.161.0" },
    catalogs: embeddedCommandCatalogs(),
    custom: [
      { agent: "claude-code", name: "/ship", description: "Ship it", kind: "command", scope: "project", source: "/w/app/.claude/commands/ship.md", project: "/w/app" },
      { agent: "codex", name: "$browse", kind: "skill", scope: "user", source: "~/.agents/skills/browse/SKILL.md" },
      { agent: "codex", name: "/prompts:draft", description: "Draft a PR body", kind: "prompt", scope: "user", source: "~/.codex/prompts/draft.md" },
    ],
  };

  test("--agent keeps one agent's catalog, version and custom commands", () => {
    const f = filterSnapshot(snap, "codex");
    expect(f.catalogs.map((c) => c.agent)).toEqual(["codex"]);
    expect(f.installed).toEqual({ codex: "0.161.0" });
    expect(f.custom.map((c) => c.name)).toEqual(["$browse", "/prompts:draft"]);
    expect(filterSnapshot(snap, undefined)).toBe(snap);
  });

  test("text: per agent, version drift noted, Signalbox tags, custom commands, lines fit the width", () => {
    const text = formatCommands(snap, { width: 100 });
    expect(text).toContain("Claude Code: 2.1.300 installed (this guide was checked on 2.1.293; some commands may differ)");
    expect(text).toContain("Codex CLI: 0.161.0 installed. Guide as of");
    expect(text).toContain("Gemini CLI: not found on this machine");
    expect(text).toMatch(/\/compact \[instructions\] +Summarize .*\[planned\]/);
    expect(text).toMatch(/\/usage .*\[Signalbox: Usage\]/);
    expect(text).toMatch(/\/logout .*\[not offered\]/);
    expect(text).toMatch(/\/ship +Ship it \[project \/w\/app\]/);
    expect(text).toMatch(/\$browse +\(no description\) \[user\]/);
    expect(text).toMatch(/\/prompts:draft +Draft a PR body \[user, legacy prompt\]/);
    for (const line of text.split("\n").slice(0, -2)) expect(line.length, line).toBeLessThanOrEqual(100);
  });

  test("--verbose adds details, side effects and the Signalbox note", () => {
    const text = formatCommands(filterSnapshot(snap, "claude-code"), { width: 120, verbose: true });
    expect(text).toContain("Side effects:");
    expect(text).toContain("Signalbox: ");
  });
});

describe("signalbox commands (spawned)", () => {
  let env: Record<string, string>;
  const SID = "99999999-9999-4999-8999-999999999999";

  beforeAll(() => {
    const sandbox = join(root, "cli");
    const home = join(sandbox, "home");
    const claude = join(home, ".claude");
    const proj = join(sandbox, "work", "app");
    mkdirSync(join(claude, "projects"), { recursive: true });
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(sandbox, "tmp"));
    // A live session in `proj` (the registry row points at this test's pid): its folder is project scope.
    w(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SID, cwd: proj, status: "busy", kind: "interactive", entrypoint: "cli" }));
    w(join(claude, "commands", "review.md"), "---\ndescription: Review the diff\n---\nNever shown.\n");
    w(join(proj, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\n");
    fakeBin(join(sandbox, "bin", "codex"), "codex-cli 0.161.0", join(sandbox, "runs"));
    fakeBin(join(sandbox, "fake-claude"), "2.1.293 (Claude Code)", join(sandbox, "runs"));
    env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(home, ".codex"),
      SIGNALBOX_CLAUDE_BIN: join(sandbox, "fake-claude"),
      SIGNALBOX_BIN_DIRS: "",
      PATH: join(sandbox, "bin"),
      TMPDIR: join(sandbox, "tmp"),
    };
  });

  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath, MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  }

  test("--json is the contract object: installed versions, all catalogs, user and project commands", async () => {
    const { out, code } = await run(["commands", "--json"]);
    expect(code).toBe(0);
    const snap = JSON.parse(out) as CommandsSnapshot;
    expect(Object.keys(snap)).toEqual(["v", "generatedAt", "installed", "catalogs", "custom"]);
    expect(snap.v).toBe(1);
    expect(snap.installed).toEqual({ "claude-code": "2.1.293", codex: "0.161.0" });
    expect(snap.catalogs.map((c) => c.agent)).toEqual(["claude-code", "codex", "gemini-cli"]);
    expect(snap.custom).toEqual([
      { agent: "claude-code", name: "/review", description: "Review the diff", kind: "command", scope: "user", source: "~/.claude/commands/review.md" },
      {
        agent: "claude-code",
        name: "/ship",
        description: "Ship it",
        kind: "command",
        scope: "project",
        source: join(root, "cli", "work", "app", ".claude", "commands", "ship.md"),
        project: join(root, "cli", "work", "app"),
      },
    ]);
    expect(out).not.toContain("Never shown");
  }, 20_000);

  test("text guide for one agent; unknown agent is a usage error", async () => {
    const { out, code } = await run(["commands", "--agent", "codex"]);
    expect(code).toBe(0);
    expect(out).toContain("Codex CLI: 0.161.0 installed");
    expect(out).not.toContain("Claude Code:");
    const bad = await run(["commands", "--agent", "cursor"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("no command guide");
  }, 20_000);

  test("snapshot --json carries the command guide too", async () => {
    const { out, code } = await run(["snapshot", "--json", "--days", "1"]);
    expect(code).toBe(0);
    const snap = JSON.parse(out);
    expect(Object.keys(snap.commands)).toEqual(["v", "generatedAt", "installed", "catalogs", "custom"]);
    expect(snap.commands.custom.map((c: { name: string }) => c.name)).toEqual(["/review", "/ship"]);
  }, 20_000);
});
