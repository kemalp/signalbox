import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCommandCatalog,
  cleanCommandName,
  cleanDescription,
  DEFAULT_COMMAND_CATALOG_DIR,
  EMBEDDED_COMMAND_CATALOG_FILES,
  embeddedCommandCatalogs,
  frontmatterOfWhole,
  geminiSegment,
  geminiSkillName,
  isFalse,
  MAX_SUMMARY_CHARS,
  parseCommandCatalog,
  parseFrontmatter,
  splitFrontmatter,
  tomlCommandInfo,
  type CommandEntry,
} from "../src/index.ts";

const catalogs = embeddedCommandCatalogs();

/** Rough sentence count: abbreviations and version numbers don't end a sentence. */
function sentences(s: string): number {
  return s
    .replace(/\b(e\.g|i\.e|etc|vs)\./g, "$1")
    .replace(/\d\.\d/g, "0")
    .split(/[.!?](?:\s+|$)(?=[A-Z0-9/`"(]|$)/)
    .filter((x) => x.trim()).length;
}

describe("embedded command catalogs", () => {
  test("are exactly the repo's catalog/commands/*.json files", () => {
    // A catalog added to catalog/commands/ but not to EMBEDDED_CATALOGS would silently go missing from the compiled binary.
    expect([...EMBEDDED_COMMAND_CATALOG_FILES]).toEqual(readdirSync(DEFAULT_COMMAND_CATALOG_DIR).filter((n) => n.endsWith(".json")).sort());
  });

  test("every file passes the strict contract check (no unknown keys)", () => {
    for (const name of EMBEDDED_COMMAND_CATALOG_FILES) {
      const json = JSON.parse(readFileSync(join(DEFAULT_COMMAND_CATALOG_DIR, name), "utf8"));
      expect(checkCommandCatalog(json, { strict: true }), name).toEqual([]);
      expect(`${json.agent}.json`, name).toBe(name);
    }
  });

  test("one catalog per agent, each verified on a version and dated", () => {
    expect(catalogs.map((c) => c.agent)).toEqual(["claude-code", "codex", "gemini-cli"]);
    for (const c of catalogs) {
      expect(c.verifiedVersion, c.agent).toMatch(/^\d+\.\d+\.\d+/);
      expect(c.commands.length, c.agent).toBeGreaterThan(20);
      expect(c.cliCommands.length, c.agent).toBeGreaterThan(10);
      // Checked against the installed binary: that version. From docs only (desktop-app commands): the docs named.
      for (const e of [...c.commands, ...c.cliCommands]) {
        if (e.verified.method !== "docs") expect(e.verified.version, `${c.agent} ${e.name}`).toBe(c.verifiedVersion);
      }
    }
  });

  test("summaries are short and details a few sentences", () => {
    for (const c of catalogs) {
      for (const e of [...c.commands, ...c.cliCommands]) {
        expect(e.summary.length, e.name).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
        if (e.details) {
          expect(sentences(e.details), `${c.agent} ${e.name}: ${e.details}`).toBeLessThanOrEqual(4);
          expect(e.details.length, e.name).toBeLessThanOrEqual(600);
        }
      }
    }
  });

  test('"planned" only where the opt-in session mod exists (Claude Code), and only for slash commands', () => {
    for (const c of catalogs) {
      const planned = [...c.commands, ...c.cliCommands].filter((e) => e.signalbox.status === "planned");
      if (c.agent !== "claude-code") expect(planned.map((e) => e.name), c.agent).toEqual([]);
      for (const e of planned) expect(e.name, e.name).toStartWith("/");
    }
    const claude = catalogs.find((c) => c.agent === "claude-code")!;
    const names = claude.commands.filter((e) => e.signalbox.status === "planned").map((e) => e.name);
    for (const n of ["/compact", "/model", "/rename"]) expect(names).toContain(n);
  });

  test("destructive and credential commands are never offered", () => {
    const status = (agent: string, name: string) => catalogs.find((c) => c.agent === agent)!.commands.find((e) => e.name === name)?.signalbox.status;
    expect(status("claude-code", "/logout")).toBe("never");
    expect(status("claude-code", "/heapdump")).toBe("never");
    expect(status("codex", "/logout")).toBe("never");
  });

  test("each call returns fresh objects", () => {
    const a = embeddedCommandCatalogs();
    a[0]!.commands.length = 0;
    expect(embeddedCommandCatalogs()[0]!.commands.length).toBeGreaterThan(0);
  });
});

describe("catalog validation", () => {
  const entry = (over: Partial<CommandEntry> & Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "/x",
    summary: "Does x.",
    category: "session",
    surfaces: { terminal: true, desktop: "partial", headless: false, remoteControl: "unknown" },
    signalbox: { status: "no", note: "Run it in the session." },
    verified: { method: "binary", version: "1.0.0" },
    ...over,
  });
  const catalog = (over: Record<string, unknown> = {}) => ({
    agent: "claude-code",
    displayName: "Claude Code",
    verifiedVersion: "1.0.0",
    asOf: "2026-10-10",
    sources: ["https://example.com/docs"],
    commands: [entry()],
    cliCommands: [entry({ name: "claude --version" })],
    ...over,
  });

  test("a minimal catalog is valid", () => {
    expect(checkCommandCatalog(catalog(), { strict: true })).toEqual([]);
    expect(parseCommandCatalog(catalog()).agent).toBe("claude-code");
  });

  test("each contract rule has a message", () => {
    const problems = (c: unknown, strict = false) => checkCommandCatalog(c, { strict }).join("\n");
    expect(problems(null)).toContain("not an object");
    expect(problems(catalog({ asOf: "10/10/2026" }))).toContain("asOf");
    expect(problems(catalog({ sources: ["http://insecure"] }))).toContain("sources");
    expect(problems(catalog({ commands: [entry({ name: "compact" })] }))).toContain("must start with /");
    expect(problems(catalog({ commands: [entry({ summary: "x".repeat(91) })] }))).toContain("91 characters");
    expect(problems(catalog({ commands: [entry({ summary: "two\nlines" })] }))).toContain("summary");
    expect(problems(catalog({ commands: [entry({ category: "misc" as never })] }))).toContain("category");
    expect(problems(catalog({ commands: [entry({ surfaces: { terminal: "partial", desktop: true, headless: true, remoteControl: true } as never })] }))).toContain(
      "surfaces.terminal",
    );
    expect(problems(catalog({ commands: [entry({ signalbox: { status: "maybe", note: "n" } as never })] }))).toContain("signalbox.status");
    expect(problems(catalog({ commands: [entry({ signalbox: { status: "no", view: "sessions", note: "n" } })] }))).toContain('only for status "view"');
    expect(problems(catalog({ commands: [entry({ signalbox: { status: "view", view: "fleet" as never, note: "n" } })] }))).toContain("signalbox.view");
    expect(problems(catalog({ commands: [entry({ verified: { method: "guess" as never, version: "1" } })] }))).toContain("verified.method");
    expect(problems(catalog({ commands: [entry({ sourceUrl: "ftp://x" })] }))).toContain("sourceUrl");
    expect(problems(catalog({ commands: [entry(), entry({ name: "/y", aliases: ["/x"] })] }))).toContain('"/x" is already used by /x');
    expect(problems(catalog({ commands: [entry({ aliases: ["/a", "/a"] })] }))).toContain("repeats");
    expect(problems(catalog({ commands: [entry({ extra: 1 })] }), true)).toContain('unknown key "extra"');
    expect(problems(catalog({ commands: [entry({ extra: 1 })] }), false)).toBe("");
  });

  test("a view status may omit the view (Signalbox shows it outside the four screens)", () => {
    expect(checkCommandCatalog(catalog({ commands: [entry({ signalbox: { status: "view", note: "The command guide lists these." } })] }), { strict: true })).toEqual([]);
  });

  test("parseCommandCatalog throws naming the source and the first problems", () => {
    expect(() => parseCommandCatalog(catalog({ asOf: "" }), "catalog/commands/x.json")).toThrow("catalog/commands/x.json: asOf: must be YYYY-MM-DD");
  });
});

describe("frontmatter", () => {
  test("splitFrontmatter: none, incomplete until the closing line, complete", () => {
    expect(splitFrontmatter("# Title\n---\n")).toEqual({ state: "none" });
    expect(splitFrontmatter("")).toEqual({ state: "incomplete" });
    expect(splitFrontmatter("--")).toEqual({ state: "incomplete" });
    expect(splitFrontmatter("---\ndescription: a")).toEqual({ state: "incomplete" });
    expect(splitFrontmatter("---\ndescription: a\n---\nBODY")).toEqual({ state: "complete", block: "description: a\n" });
    expect(splitFrontmatter("\ufeff---\r\nname: x\r\n---\r\n")).toEqual({ state: "complete", block: "name: x\r\n" });
    expect(splitFrontmatter("----\nx: 1\n---\n")).toEqual({ state: "none" });
  });

  test("frontmatterOfWhole: a closing line at end of file without a newline counts", () => {
    expect(frontmatterOfWhole("---\nname: x\n---")).toBe("name: x\n");
    expect(frontmatterOfWhole("---\nname: x\n")).toBeUndefined();
  });

  test("plain, quoted, multi-line and block scalars; nested values skipped; keys normalized", () => {
    const fm = parseFrontmatter(
      [
        "name: my-skill",
        "description: Reviews a diff # trailing comment",
        "Argument_Hint: '[file]'",
        "user-invocable: false",
        "allowed-tools:",
        "  - Bash",
        "  - Read",
        "metadata:",
        "  owner: me",
        "long: first line",
        "  continues here",
        "folded: >-",
        "  one",
        "  two",
        "",
        "  three",
        'dq: "say \\"hi\\"\\n now"',
        "sq: 'it''s'",
        "multi: \"starts",
        "  and ends\"",
        "flow: [a, b]",
        "# a comment: not a key",
        "  stray: indented",
      ].join("\n"),
    );
    expect(fm).toEqual({
      name: "my-skill",
      description: "Reviews a diff",
      "argument-hint": "[file]",
      "user-invocable": "false",
      long: "first line continues here",
      folded: "one two three",
      dq: 'say "hi" now',
      sq: "it's",
      multi: "starts and ends",
      flow: "[a, b]",
    });
  });

  test("aliases and anchors are not expanded (a hostile file can't blow up)", () => {
    const fm = parseFrontmatter(`a: &a ["x","x","x"]\nb: [*a,*a,*a]\ndescription: *a\n`);
    expect(fm.description).toBe("*a");
  });

  test("isFalse reads false, no and off", () => {
    expect(["false", "No", " off "].every(isFalse)).toBe(true);
    expect([undefined, "true", "", "0"].some(isFalse)).toBe(false);
  });
});

describe("descriptions and names", () => {
  test("one printable line of at most 200 characters", () => {
    expect(cleanDescription("  Fix\tthe\r\nbuild  ")).toBe("Fix the build");
    expect(cleanDescription(`a\u0000b\u001bc\u202ed\u200be`)).toBe("a b c d e");
    expect(cleanDescription("")).toBeUndefined();
    expect(cleanDescription("   ")).toBeUndefined();
    expect(cleanDescription(42)).toBeUndefined();
    const long = cleanDescription("x".repeat(500))!;
    expect([...long].length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
    // Characters, not UTF-16 units: an emoji is never cut in half.
    const emoji = cleanDescription("\u{1f600}".repeat(300))!;
    expect([...emoji].length).toBe(200);
    expect(emoji).not.toContain("\ud83d…");
  });

  test("command names with control characters are rejected", () => {
    expect(cleanCommandName("/git:fix")).toBe("/git:fix");
    expect(cleanCommandName("/bad\nname")).toBeUndefined();
    expect(cleanCommandName("/")).toBeUndefined();
    expect(cleanCommandName(`/${"x".repeat(250)}`)).toBeUndefined();
  });

  test("Gemini CLI name cleaning", () => {
    expect(geminiSegment("my cmd!")).toBe("my_cmd_");
    expect(geminiSegment("a".repeat(60))).toBe(`${"a".repeat(47)}...`);
    expect(geminiSkillName('a:b/c d"e')).toBe("a-b-c-d-e");
  });
});

describe("TOML command files", () => {
  test("description kept, prompt required but never returned", () => {
    const info = tomlCommandInfo('prompt = """\nSecret body text\n"""\ndescription = "Commit with a message"\n');
    expect(info).toEqual({ valid: true, description: "Commit with a message" });
    expect(JSON.stringify(info)).not.toContain("Secret body");
  });

  test("no prompt, a broken file or a non-string description", () => {
    expect(tomlCommandInfo('description = "x"')).toEqual({ valid: false });
    expect(tomlCommandInfo("prompt = ")).toEqual({ valid: false });
    expect(tomlCommandInfo('prompt = "p"\ndescription = 3')).toEqual({ valid: true });
    // A description inside a table is not the top-level one.
    expect(tomlCommandInfo('prompt = "p"\n[meta]\ndescription = "nested"')).toEqual({ valid: true });
  });
});
