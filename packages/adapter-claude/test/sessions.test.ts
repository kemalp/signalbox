import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/index.ts";
import {
  isPidAlive,
  isRegistryFileName,
  mapStatus,
  mergeSessions,
  parseAgentsJson,
  parseRegistryEntry,
  readRegistry,
  runAgentsJson,
  type RegistryEntry,
} from "../src/sessions.ts";
import { label } from "../src/util.ts";
import { A_MTIME, A_REGISTRY_STATUS_AT, BIN, makeSandbox, SID_A, SID_B, SID_E, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

const DEAD_PID = 4194305; // above pid_max on macOS and Linux

describe("registry", () => {
  test("only <digits>.json names are registry files", () => {
    expect(isRegistryFileName("4194305.json")).toBe(true);
    expect(isRegistryFileName("123.abc.key")).toBe(false);
    expect(isRegistryFileName("123.json.key")).toBe(false);
    expect(isRegistryFileName("abc.json")).toBe(false);
    expect(isRegistryFileName("12.json.tmp")).toBe(false);
  });

  test("parses registry files and never opens the decoy .key file", async () => {
    const reg = await readRegistry(join(sb.configDir, "sessions"));
    expect(reg.dirExists).toBe(true);
    expect(reg.errors).toBe(0);
    expect(reg.entries.map((e) => e.file).sort()).toEqual([`${DEAD_PID}.json`, `${process.pid}.json`].sort());
    expect(reg.entries.some((e) => e.sessionId?.startsWith("decoy"))).toBe(false);
    const b = reg.entries.find((e) => e.sessionId === SID_B)!;
    expect(b).toMatchObject({
      pid: DEAD_PID,
      entrypoint: "claude-desktop",
      version: "2.1.290",
      status: "idle",
      startedAt: "2026-01-05T00:00:00.000Z",
      statusUpdatedAt: "2026-01-05T00:01:40.000Z",
    });
  });

  test("missing registry dir", async () => {
    expect(await readRegistry(join(sb.root, "nope"))).toEqual({ dirExists: false, entries: [], errors: 0 });
  });

  test("pid liveness", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(process.pid, "some-other-domain")).toBeUndefined();
    expect(isPidAlive(process.pid, process.platform)).toBe(true);
  });
});

describe("agents --json", () => {
  test("status mapping", () => {
    expect(mapStatus("busy")).toBe("busy");
    expect(mapStatus("running")).toBe("busy");
    expect(mapStatus("waiting")).toBe("waiting");
    expect(mapStatus("idle")).toBe("idle");
    expect(mapStatus("failed")).toBe("ended");
    expect(mapStatus("something-new")).toBe("unknown");
    expect(mapStatus(undefined)).toBe("unknown");
  });

  test("parses interactive and background shapes, skips junk", () => {
    const parsed = parseAgentsJson([
      { pid: 1, sessionId: "s1", status: "idle", startedAt: 1768039200000, extra: true },
      { id: "bg", sessionId: "s2", state: "failed" },
      "junk",
      {},
    ]);
    expect(parsed).toEqual([
      { pid: 1, sessionId: "s1", status: "idle", startedAt: "2026-01-10T10:00:00.000Z" },
      { id: "bg", sessionId: "s2", status: "failed" },
    ]);
    expect(parseAgentsJson({ not: "an array" })).toBeUndefined();
  });

  test("runs the fake binary with an argv array", async () => {
    const run = await runAgentsJson(join(BIN, "fake-claude"), { timeoutMs: 5000 });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.entries.map((e) => e.sessionId)).toEqual([SID_A, SID_E]);
  });

  test("failure modes", async () => {
    const fail = await runAgentsJson(join(BIN, "fake-claude-fail"), { timeoutMs: 5000 });
    expect(fail).toMatchObject({ ok: false, reason: "exited with code 3" });
    const garbage = await runAgentsJson(join(BIN, "fake-claude-garbage"), { timeoutMs: 5000 });
    expect(garbage).toMatchObject({ ok: false, reason: "output was not valid JSON" });
    const missing = await runAgentsJson(join(sb.root, "no-such-claude"), { timeoutMs: 5000 });
    expect(missing.ok).toBe(false);
    const none = await runAgentsJson(undefined, { timeoutMs: 5000 });
    expect(none.ok).toBe(false);
  });

  test("times out", async () => {
    const t = performance.now();
    const slow = await runAgentsJson(join(BIN, "fake-claude-slow"), { timeoutMs: 150 });
    expect(slow).toMatchObject({ ok: false, reason: "timed out after 150 ms" });
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("listSessions", () => {
  test("merges agents --json with the registry and the transcript", async () => {
    const a = createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: join(BIN, "fake-claude") });
    const sessions = await a.listSessions();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([SID_A, SID_B, SID_E].sort());
    expect(sessions.some((s) => s.sessionId.startsWith("decoy"))).toBe(false);

    const sa = sessions.find((s) => s.sessionId === SID_A)!;
    expect(sa).toEqual({
      agent: "claude-code",
      sessionId: SID_A,
      pid: 4242,
      cwd: "/Users/test/alpha",
      name: "alpha work",
      kind: "interactive",
      status: "busy",
      statusSince: new Date(A_REGISTRY_STATUS_AT).toISOString(),
      entrypoint: "cli",
      version: "2.1.293",
      model: "claude-opus-5-5",
      effort: "high",
      startedAt: "2026-01-10T10:00:00.000Z",
      lastActivity: A_MTIME.toISOString(),
      source: "agents --json+registry",
    });
    expect(sessions.find((s) => s.sessionId === SID_E)).toMatchObject({ status: "ended", source: "agents --json", name: "bg job" });
    // Registry-only, dead pid.
    const sbx = sessions.find((s) => s.sessionId === SID_B)!;
    expect(sbx).toMatchObject({ status: "ended", source: "registry", entrypoint: "claude-desktop", version: "2.1.290" });
    expect(sbx.statusSince).toBeUndefined();
  });

  test("falls back to the registry alone and says so in health()", async () => {
    const a = createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: join(BIN, "fake-claude-fail") });
    const sessions = await a.listSessions();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([SID_A, SID_B].sort());
    expect(sessions.find((s) => s.sessionId === SID_A)).toMatchObject({
      status: "busy",
      source: "registry",
      pid: process.pid,
      statusSince: new Date(A_REGISTRY_STATUS_AT).toISOString(),
    });
    const h = (await a.health()).find((x) => x.name === "claude-code:agents-json")!;
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("exited with code 3");
    expect(h.detail).toContain("registry only");
  });

  test("passes an explicit configDir to the child as CLAUDE_CONFIG_DIR", async () => {
    const a = createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: join(BIN, "fake-claude-env") });
    const env = (await a.listSessions()).find((s) => s.sessionId === "env-check");
    expect(env?.name).toBe(sb.configDir);
  });

  test("mergeSessions marks registry rows that agents --json did not list", () => {
    const merged = mergeSessions([], [{ file: "1.json", pid: 1, sessionId: "x", status: "busy" }], () => true);
    expect(merged).toEqual([{ agent: "claude-code", sessionId: "x", pid: 1, status: "unknown", source: "registry" }]);
  });
});

describe("waitingFor", () => {
  test("label keeps short machine labels and drops anything that could be text", () => {
    for (const ok of ["permission prompt", "input needed", "dialog open", "sandbox request", "goal proposal", "plan_approval", "tool:Bash"]) {
      expect(label(ok)).toBe(ok);
    }
    expect(label("  input needed ")).toBe("input needed");
    for (const bad of ["", "   ", "x".repeat(49), "Allow rm -rf /tmp/foo?", "line\nbreak", "quote\"d", "émoji ✨", 5, null, undefined, {}]) {
      expect(label(bad)).toBeUndefined();
    }
  });

  test("parsed from the registry and from agents --json", () => {
    expect(parseRegistryEntry({ pid: 1, status: "waiting", waitingFor: "permission prompt" }, "1.json")?.waitingFor).toBe("permission prompt");
    expect(parseRegistryEntry({ pid: 1, status: "waiting", waitingFor: "Do you want to run: cat secrets.txt?" }, "1.json")?.waitingFor).toBeUndefined();
    expect(parseAgentsJson([{ pid: 1, sessionId: "s", status: "waiting", waitingFor: "input needed" }])?.[0]?.waitingFor).toBe("input needed");
  });

  test("set only while the merged status is waiting", () => {
    const reg = (status: string, waitingFor?: string): RegistryEntry => ({ file: "1.json", pid: 1, sessionId: "s", status, waitingFor });
    expect(mergeSessions(undefined, [reg("waiting", "permission prompt")], () => true)[0]).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });
    expect(mergeSessions(undefined, [reg("busy", "permission prompt")], () => true)[0]!.waitingFor).toBeUndefined();
    // agents --json says waiting (with its own copy of the label), registry agrees: the registry's label.
    const both = mergeSessions([{ sessionId: "s", pid: 1, status: "waiting", waitingFor: "dialog open" }], [reg("waiting", "input needed")], () => true);
    expect(both[0]).toMatchObject({ status: "waiting", waitingFor: "input needed" });
    // agents --json alone.
    expect(mergeSessions([{ sessionId: "s", status: "waiting", waitingFor: "dialog open" }], [], () => true)[0]!.waitingFor).toBe("dialog open");
  });
});

describe("mergeSessions with a cached agents --json run", () => {
  const RUN_AT = Date.parse("2026-10-10T12:00:00.000Z");
  const iso = (msFromRun: number) => new Date(RUN_AT + msFromRun).toISOString();
  const agentsBusy = [{ sessionId: "s", pid: 1, status: "busy" }];

  test("a registry status written after the run wins, with its time and label", () => {
    const merged = mergeSessions(agentsBusy, [{ file: "1.json", pid: 1, sessionId: "s", status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: iso(5000) }], () => true, { agentsAt: RUN_AT });
    expect(merged).toEqual([
      { agent: "claude-code", sessionId: "s", pid: 1, status: "waiting", statusSince: iso(5000), waitingFor: "permission prompt", source: "agents --json+registry" },
    ]);
  });

  test("a registry status from before the run doesn't override it", () => {
    const merged = mergeSessions(agentsBusy, [{ file: "1.json", pid: 1, sessionId: "s", status: "idle", statusUpdatedAt: iso(-5000) }], () => true, { agentsAt: RUN_AT });
    expect(merged[0]).toMatchObject({ status: "busy" });
    expect(merged[0]!.statusSince).toBeUndefined();
  });

  test("a registry-only row written after the run is a new session, not a suspect pid", () => {
    const fresh: RegistryEntry = { file: "2.json", pid: 2, sessionId: "new", status: "busy", startedAt: iso(2000), statusUpdatedAt: iso(2000) };
    const stale: RegistryEntry = { file: "3.json", pid: 3, sessionId: "old", status: "busy", startedAt: iso(-9e6), statusUpdatedAt: iso(-9e6) };
    const merged = mergeSessions([], [fresh, stale], () => true, { agentsAt: RUN_AT });
    expect(merged.find((s) => s.sessionId === "new")).toMatchObject({ status: "busy", statusSince: iso(2000) });
    expect(merged.find((s) => s.sessionId === "old")).toMatchObject({ status: "unknown" });
  });

  test("a listed session whose registry file is gone and whose pid exited has ended", () => {
    const merged = mergeSessions(
      [
        { sessionId: "gone", pid: 7, status: "busy" },
        { sessionId: "alive", pid: 8, status: "busy" },
        { id: "bg", sessionId: "bg", status: "running" },
      ],
      [],
      (pid) => pid !== 7,
      { agentsAt: RUN_AT },
    );
    expect(Object.fromEntries(merged.map((s) => [s.sessionId, s.status]))).toEqual({ gone: "ended", alive: "busy", bg: "busy" });
  });
});

describe("listSessions({ quick: true })", () => {
  test("never spawns claude: registry status plus the last agents --json result", async () => {
    // A counting stand-in for `claude agents --json --all` that always says "busy".
    const runs = join(sb.root, "quick-runs");
    const fake = join(sb.root, "fake-claude-counting");
    writeFileSync(
      fake,
      `#!/bin/sh\necho run >> '${runs}'\nprintf '%s\\n' '[{"pid":${process.pid},"sessionId":"${SID_A}","status":"busy","kind":"interactive"}]'\n`,
    );
    chmodSync(fake, 0o755);
    const count = () => {
      try {
        return readFileSync(runs, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    const a = createClaudeAdapter({ configDir: sb.configDir, spoolDir: sb.spoolDir, claudeBin: fake });
    // No run yet: the registry alone.
    const before = await a.listSessions({ quick: true });
    expect(count()).toBe(0);
    expect(before.find((s) => s.sessionId === SID_A)).toMatchObject({ status: "busy", source: "registry" });

    await a.listSessions();
    expect(count()).toBe(1);

    // The session starts waiting after that run.
    const regFile = join(sb.configDir, "sessions", `${process.pid}.json`);
    const original = readFileSync(regFile, "utf8");
    try {
      const now = Date.now() + 1000;
      writeFileSync(regFile, JSON.stringify({ ...JSON.parse(original), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: now, updatedAt: now }));
      for (let i = 0; i < 3; i++) {
        const quick = await a.listSessions({ quick: true });
        expect(quick.find((s) => s.sessionId === SID_A)).toMatchObject({
          status: "waiting",
          waitingFor: "permission prompt",
          statusSince: new Date(now).toISOString(),
          source: "agents --json+registry",
        });
      }
      await a.readContext();
      expect(count()).toBe(1);
    } finally {
      writeFileSync(regFile, original);
    }
  });
});
