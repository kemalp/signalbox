import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embeddedModelTables } from "../../core/src/index.ts";
import { createClaudeAdapter, parseSpool } from "../src/index.ts";
import { BIN, makeSandbox, SID_A, SID_D, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

const NOW = new Date("2026-01-10T12:05:00.000Z");
const make = (spoolDir: string) =>
  createClaudeAdapter({ configDir: sb.configDir, spoolDir, claudeBin: join(BIN, "fake-claude"), now: () => NOW });

const validD = JSON.stringify({
  v: 1,
  seq: 1,
  agent: "claude-code",
  sessionId: SID_D,
  writtenAt: "2026-01-10T12:30:00.000Z",
  event: "session.measure",
  usage: { context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: "spend_limit", percentUsed: 50 }] },
});

describe("parseSpool", () => {
  test("accepts v1 with unknown keys, rejects others", () => {
    const ok = parseSpool(validD.replace('"v":1', '"v":1,"later":{"x":1}'));
    expect(ok).toMatchObject({ v: 1, sessionId: SID_D, seq: 1, event: "session.measure" });
    expect(parseSpool(validD.replace('"v":1', '"v":2'))).toBeUndefined();
    expect(parseSpool(validD.replace(`"sessionId":"${SID_D}",`, ""))).toBeUndefined();
    expect(parseSpool(validD.replace('"event":"session.measure"', '"event":"other"'))).toBeUndefined();
    expect(parseSpool(validD.slice(0, 60))).toBeUndefined();
    expect(parseSpool("")).toBeUndefined();
  });
});

describe("readLimits", () => {
  test("freshest reading per kind across sessions; labels; unknown kinds kept verbatim", async () => {
    const limits = await make(sb.spoolDir).readLimits();
    expect(limits).toEqual([
      {
        agent: "claude-code",
        kind: "five_hour",
        label: "5-hour",
        usedPercent: 37,
        resetsAt: "2026-01-10T15:00:00.000Z",
        windowMinutes: 300,
        observedAt: "2026-01-10T12:00:00.000Z",
        sessionId: SID_A,
        source: "spool",
      },
      {
        agent: "claude-code",
        kind: "seven_day",
        label: "Weekly",
        usedPercent: 12,
        windowMinutes: 10080,
        observedAt: "2026-01-10T12:00:00.000Z",
        sessionId: SID_A,
        source: "spool",
      },
      {
        agent: "claude-code",
        kind: "seven_day_fable",
        usedPercent: 5,
        observedAt: "2026-01-10T11:00:00.000Z",
        sessionId: "33333333-3333-4333-8333-333333333333",
        source: "spool",
      },
    ]);
  });

  test("no spool dir means no readings", async () => {
    expect(await make(join(sb.root, "no-spool")).readLimits()).toEqual([]);
  });
});

describe("half-written spool files", () => {
  test("a truncated file is skipped, and the last good copy is reused", async () => {
    const dir = join(sb.root, "spool-rw");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${SID_D}.json`);
    const a = make(dir);

    writeFileSync(path, validD.slice(0, 80)); // truncated before any good read
    expect(await a.readLimits()).toEqual([]);

    writeFileSync(path, validD);
    expect((await a.readLimits()).map((l) => l.kind)).toEqual(["spend_limit"]);

    writeFileSync(path, validD.slice(0, 80)); // mid-write again
    expect((await a.readLimits()).map((l) => l.kind)).toEqual(["spend_limit"]);
    const h = (await a.health()).find((x) => x.name === "claude-code:spool")!;
    expect(h.detail).toContain("1 unparsable this round (1 served from last good copy)");

    // A fresh reader has no last good copy.
    expect(await make(dir).readLimits()).toEqual([]);
  });
});

describe("readContext", () => {
  test("spool overrides the transcript estimate with an official reading", async () => {
    const ctx = await make(sb.spoolDir).readContext();
    // A is live (busy) and has a spool; C is spool-only but carries no context and has no transcript;
    // D's spool is truncated and was never read; B and E have ended.
    expect(ctx).toEqual([
      {
        agent: "claude-code",
        sessionId: SID_A,
        tokens: 420000,
        window: 1000000,
        windowSource: "agent",
        percent: 42,
        // Claude Code's observed default on a 1M window (models/anthropic.json, agents.claude-code).
        autoCompactAtPercent: 96.7,
        observedAt: "2026-01-10T12:00:00.000Z",
        quality: "official",
        source: "spool",
      },
    ]);
  });

  test("without a spool, estimates from the last main-thread response", async () => {
    const ctx = await make(join(sb.root, "no-spool")).readContext();
    expect(ctx).toEqual([
      {
        agent: "claude-code",
        sessionId: SID_A,
        // msg_A8: input 11 + cacheRead 7000 + cacheWrite 25 (5m) + 50 (1h); the later sidechain row is ignored.
        tokens: 7086,
        // The last main-thread response ran claude-opus-5-5: a documented 1M window.
        window: 1000000,
        windowSource: "model-table",
        percent: 0.7,
        autoCompactAtPercent: 96.7,
        observedAt: "2026-01-10T11:40:00.000Z",
        quality: "estimated",
        source: "transcript",
      },
    ]);
  });

  test("an official reading without a window gets the model's documented window", async () => {
    const dir = join(sb.root, "spool-no-window");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SID_A}.json`),
      JSON.stringify({ v: 1, seq: 1, agent: "claude-code", sessionId: SID_A, writtenAt: "2026-01-10T12:00:00.000Z", event: "session.measure", usage: { context: { tokens: 250000 } } }),
    );
    const ctx = await make(dir).readContext();
    expect(ctx).toEqual([
      {
        agent: "claude-code",
        sessionId: SID_A,
        tokens: 250000,
        window: 1000000,
        windowSource: "model-table",
        percent: 25,
        autoCompactAtPercent: 96.7,
        observedAt: "2026-01-10T12:00:00.000Z",
        quality: "official",
        source: "spool",
      },
    ]);
  });

  test("an unknown model leaves the window, percent and auto-compact point unknown", async () => {
    const tables = embeddedModelTables().map((t) => ({ ...t, models: {} }));
    const a = createClaudeAdapter({ configDir: sb.configDir, spoolDir: join(sb.root, "no-spool"), claudeBin: join(BIN, "fake-claude"), now: () => NOW, modelTables: tables });
    const [c] = await a.readContext();
    expect(c).toMatchObject({ sessionId: SID_A, tokens: 7086, quality: "estimated" });
    expect(c?.window).toBeUndefined();
    expect(c?.windowSource).toBeUndefined();
    expect(c?.percent).toBeUndefined();
    expect(c?.autoCompactAtPercent).toBeUndefined();
  });

  test("a fresh spool-only session counts as live; percent is derived when missing", async () => {
    const dir = join(sb.root, "spool-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID_D}.json`), validD);
    const ctx = await make(dir).readContext();
    const d = ctx.find((c) => c.sessionId === SID_D);
    expect(d).toMatchObject({ tokens: 1000, window: 200000, windowSource: "agent", percent: 0.5, quality: "official" });
    // No auto-compact point has been observed for a 200k window, so none is shown.
    expect(d?.autoCompactAtPercent).toBeUndefined();
  });
});

describe("health", () => {
  test("one entry per source with its stability", async () => {
    const h = await make(sb.spoolDir).health();
    expect(h.map((x) => [x.name, x.stability, x.ok])).toEqual([
      ["claude-code:transcripts", "internal", true],
      ["claude-code:cost-state", "internal", true],
      ["claude-code:titles", "internal", true],
      ["claude-code:agents-json", "preview", true],
      ["claude-code:registry", "internal", true],
      ["claude-code:spool", "preview", true],
    ]);
    const none = await createClaudeAdapter({ configDir: join(sb.root, "x"), spoolDir: join(sb.root, "y"), claudeBin: join(BIN, "fake-claude-fail") }).health();
    expect(none.filter((x) => x.ok).map((x) => x.name)).toEqual(["claude-code:agents-json"]);
    // No global config file: agents --json is not run at all (it would create the file).
    expect(none.find((x) => x.name === "claude-code:agents-json")!.detail).toContain("not run");
  });

  test("agents --json is skipped without a global config file, and failures are not retried on every call", async () => {
    const dir = join(sb.root, "fresh-config");
    mkdirSync(join(dir, "projects"), { recursive: true });
    const marker = join(sb.root, "agents-calls.log");
    const bin = join(sb.root, "counting-claude");
    writeFileSync(bin, `#!/bin/sh\necho x >> "${marker}"\nexit 3\n`, { mode: 0o755 });
    const a = createClaudeAdapter({ configDir: dir, spoolDir: join(sb.root, "y"), claudeBin: bin });
    await a.listSessions();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    writeFileSync(join(dir, ".claude.json"), "{}\n");
    const b = createClaudeAdapter({ configDir: dir, spoolDir: join(sb.root, "y"), claudeBin: bin });
    await Promise.all([b.listSessions(), b.health()]);
    await b.listSessions();
    // One run for two concurrent callers, and the failure is cached instead of re-run.
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
