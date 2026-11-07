// The settings reader for cleanupPeriodDays: only settings.json and the managed settings files are opened, only that
// one member is parsed, and the rest (env secrets, hooks, MCP settings) never comes out. Everything here is SYNTHETIC.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeClaudeAppFs, type ClaudeAppFs } from "../src/claude-app.ts";
import { createClaudeAdapter } from "../src/index.ts";
import { topLevelValue } from "../src/json-scan.ts";
import { defaultManagedSettingsDir, RetentionReader, retentionFromSettingsText } from "../src/retention.ts";

const CANARY = "CANARY_SECRET";
let root: string;

function settings(extra: Record<string, unknown>): string {
  return JSON.stringify({ env: { ANTHROPIC_API_KEY: CANARY }, apiKeyHelper: `echo ${CANARY}`, hooks: { Stop: [{ command: CANARY }] }, ...extra }, null, 2);
}

function dir(name: string, body?: string): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  if (body !== undefined) writeFileSync(join(d, "settings.json"), body);
  return d;
}

function traced(log: string[]): ClaudeAppFs {
  return {
    readdir: (p) => (log.push(p), nodeClaudeAppFs.readdir(p)),
    lstat: (p) => (log.push(p), nodeClaudeAppFs.lstat(p)),
    readFile: (p, max) => (log.push(p), nodeClaudeAppFs.readFile(p, max)),
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-retention-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("cutting out one member", () => {
  test("numbers, strings and objects; decoys in nested objects and strings are skipped", () => {
    const text = JSON.stringify({ projects: { cleanupPeriodDays: 1 }, note: '"cleanupPeriodDays": 2', cleanupPeriodDays: 365, after: [3] });
    expect(topLevelValue(text, "cleanupPeriodDays")).toEqual({ set: true, value: 365 });
    expect(retentionFromSettingsText('{ "cleanupPeriodDays" : "30" }')).toEqual({ set: true, value: "30" });
    expect(retentionFromSettingsText('{"cleanupPeriodDays":{"x":1}}')).toEqual({ set: true, value: { x: 1 } });
    expect(retentionFromSettingsText('{"model":"x"}')).toEqual({ set: false });
  });

  test("a file cut off mid-write throws instead of reading as not set", () => {
    for (const cut of ['{"env":{"A":"}', '{"cleanupPeriodDays": 36', '{"hooks":{"a":{}', '{"a":1}x']) {
      expect(() => retentionFromSettingsText(cut)).toThrow();
    }
  });
});

describe("RetentionReader", () => {
  test("each dir's own value, the default when unset, and invalid values kept as written", async () => {
    const year = dir("year", settings({ cleanupPeriodDays: 365 }));
    const unset = dir("unset", settings({}));
    const none = dir("none");
    const zero = dir("zero", settings({ cleanupPeriodDays: 0 }));
    const text = dir("text", settings({ cleanupPeriodDays: "90" }));
    const out = await new RetentionReader({ managedDir: false }).read([year, unset, none, zero, text], new Map([[year, [none]]]));
    expect(out).toEqual([
      { agent: "claude-code", configDir: year, source: "user", file: join(year, "settings.json"), days: 365, defaultDays: 30, sharesTranscriptsWith: [none] },
      { agent: "claude-code", configDir: unset, source: "default", defaultDays: 30 },
      { agent: "claude-code", configDir: none, source: "default", defaultDays: 30 },
      { agent: "claude-code", configDir: zero, source: "user", file: join(zero, "settings.json"), invalid: "0", defaultDays: 30 },
      { agent: "claude-code", configDir: text, source: "user", file: join(text, "settings.json"), invalid: '"90"', defaultDays: 30 },
    ]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  test("managed settings win, the .d files after the base file in name order; managed-mcp.json is never opened", async () => {
    const managed = join(root, "managed");
    mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
    writeFileSync(join(managed, "managed-settings.json"), settings({ cleanupPeriodDays: 14 }));
    writeFileSync(join(managed, "managed-settings.d", "20-retention.json"), settings({ cleanupPeriodDays: 120 }));
    writeFileSync(join(managed, "managed-settings.d", "10-other.json"), settings({ cleanupPeriodDays: 7 }));
    writeFileSync(join(managed, "managed-settings.d", "30-unrelated.json"), settings({ model: "x" }));
    writeFileSync(join(managed, "managed-settings.d", "notes.txt"), CANARY);
    writeFileSync(join(managed, "managed-mcp.json"), JSON.stringify({ cleanupPeriodDays: 1, secret: CANARY }));
    const user = dir("user-under-managed", settings({ cleanupPeriodDays: 3650 }));
    const touched: string[] = [];
    const [r] = await new RetentionReader({ managedDir: managed, fs: traced(touched) }).read([user]);
    expect(r).toMatchObject({ source: "managed", days: 120, file: join(managed, "managed-settings.d", "20-retention.json") });
    expect(touched.some((p) => p.endsWith("managed-mcp.json") || p.endsWith("notes.txt"))).toBe(false);
    // The managed value is final, so the user's file isn't even opened.
    expect(touched).not.toContain(join(user, "settings.json"));
    for (const p of touched) expect(p.startsWith(managed)).toBe(true);
  });

  test("a file that can't be read makes the value unknown, never the default", async () => {
    const broken = dir("broken", "{ not json");
    const real = dir("real", settings({ cleanupPeriodDays: 365 }));
    const linked = dir("linked");
    symlinkSync(join(real, "settings.json"), join(linked, "settings.json"));
    const out = await new RetentionReader({ managedDir: false }).read([broken, linked]);
    expect(out[0]).toMatchObject({ source: "default", problem: `${join(broken, "settings.json")} isn't valid JSON` });
    expect(out[0]!.days).toBeUndefined();
    expect(out[1]!.problem).toContain("symbolic link");
    // An unreadable managed file hides every dir's value.
    const managed = join(root, "managed-broken");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed-settings.json"), '{"cleanupPeriodDays": ');
    const [m] = await new RetentionReader({ managedDir: managed }).read([real]);
    expect(m!.problem).toContain("managed-settings.json isn't valid JSON");
  });

  test("a file caught mid-write keeps its last good value", async () => {
    const d = dir("midwrite", settings({ cleanupPeriodDays: 200 }));
    const reader = new RetentionReader({ managedDir: false });
    expect((await reader.read([d]))[0]!.days).toBe(200);
    writeFileSync(join(d, "settings.json"), '{"cleanupPeriodDays": 2');
    expect((await reader.read([d]))[0]!.days).toBe(200);
  });

  test("the managed folder: the platform's, or the env override (empty turns it off)", () => {
    expect(defaultManagedSettingsDir({}, "darwin")).toBe("/Library/Application Support/ClaudeCode");
    expect(defaultManagedSettingsDir({}, "linux")).toBe("/etc/claude-code");
    expect(defaultManagedSettingsDir({}, "win32")).toBe(false);
    expect(defaultManagedSettingsDir({ SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR: "" }, "darwin")).toBe(false);
    expect(defaultManagedSettingsDir({ SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR: "/x" }, "darwin")).toBe("/x");
  });
});

describe("the adapter", () => {
  test("readRetention per config dir, a shared transcripts folder noted, and the health row", async () => {
    const a = dir("cfg-a", settings({ cleanupPeriodDays: 365 }));
    const b = dir("cfg-b");
    mkdirSync(join(a, "projects"), { recursive: true });
    symlinkSync(join(a, "projects"), join(b, "projects"));
    const ad = createClaudeAdapter({ configDir: a, extraConfigDirs: [b], spoolDir: join(root, "spool"), claudeBin: "/nonexistent", managedSettingsDir: false });
    const out = await ad.readRetention();
    expect(out.map((r) => [r.configDir, r.days ?? r.defaultDays, r.source, r.sharesTranscriptsWith])).toEqual([
      [a, 365, "user", [b]],
      [b, 30, "default", [a]],
    ]);
    const row = (await ad.health()).find((h) => h.name === "claude-code:retention")!;
    expect(row).toMatchObject({ stability: "documented", ok: true });
    expect(row.detail).toContain(`${a}: 365 days (settings.json); ${b}: 30 days (not set: the default)`);
    expect(row.detail).not.toContain(CANARY);
  });
});
