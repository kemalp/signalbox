#!/usr/bin/env bun
// Prints a SYNTHETIC `signalbox commands --json` object for the app's tests and snapshot renders: the real
// catalogs from catalog/commands/*.json, made-up installed versions, and made-up custom commands. Nothing here
// comes from a real machine: the custom command names, descriptions, paths and projects below are invented.
//   bun apps/macos/scripts/make-commands-fixture.ts > apps/macos/Fixtures/commands.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const CATALOG_DIR = join(REPO, "catalog", "commands");
const ORDER = ["claude-code", "codex", "gemini-cli"];

const catalogs = readdirSync(CATALOG_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")))
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.agent);
    const ib = ORDER.indexOf(b.agent);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.agent).localeCompare(String(b.agent));
  });

// Claude Code matches its catalog, Codex is a newer release than the one its catalog was checked against
// (the app says so), and Gemini CLI is not installed (absent), so every version state shows up in renders.
const installed: Record<string, string> = { "claude-code": "2.1.293", codex: "0.162.1" };

const PROJECT = "/Users/you/code/storefront";
const custom = [
  { agent: "claude-code", name: "/release-notes", description: "Draft release notes from the merged pull requests since the last tag", kind: "command", scope: "user", source: "~/.claude/commands/release-notes.md" },
  { agent: "claude-code", name: "/db:migrate-check", description: "Check pending database migrations against the staging schema", kind: "command", scope: "project", source: ".claude/commands/db/migrate-check.md", project: PROJECT },
  { agent: "claude-code", name: "/pdf-tools", description: "Fill, merge and split PDF files", kind: "skill", scope: "user", source: "~/.claude/skills/pdf-tools/SKILL.md" },
  { agent: "claude-code", name: "/acme-dev:lint-fix", description: "Run the linters and fix what they can", kind: "plugin-command", scope: "plugin", source: "acme-dev" },
  { agent: "claude-code", name: "/acme-dev:triage", kind: "plugin-skill", scope: "plugin", source: "acme-dev" },
  { agent: "codex", name: "$changelog", description: "Keep CHANGELOG.md in the house style", kind: "skill", scope: "user", source: "~/.agents/skills/changelog/SKILL.md" },
  { agent: "codex", name: "$api-docs", description: "Regenerate the API reference from the OpenAPI file", kind: "skill", scope: "project", source: ".agents/skills/api-docs/SKILL.md", project: PROJECT },
  // A legacy Codex prompt (~/.codex/prompts): the CLI still lists them, the app marks them as legacy.
  { agent: "codex", name: "/prompts:draft-pr", description: "Draft a pull request body from the staged changes", kind: "prompt", scope: "user", source: "~/.codex/prompts/draft-pr.md" },
];

const out = { v: 1, generatedAt: "2026-10-09T14:30:00.000Z", installed, catalogs, custom };
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
