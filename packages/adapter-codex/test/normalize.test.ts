import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ForbiddenFileError, guardIO, isForbiddenName, nodeIO, resolveCodexHome, type CodexIO } from "../src/io.ts";
import { kindFromSource, limitKind, normalizeUsage, parseRolloutName, resetToIso, speedFromTier, windowLabel } from "../src/normalize.ts";

describe("normalizeUsage", () => {
  test("cached and cache-write tokens are subsets of input_tokens; reasoning is inside output", () => {
    const t = normalizeUsage({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 });
    expect(t).toEqual({ input: 300, output: 200, cacheRead: 600, cacheWrite5m: 100, cacheWrite1h: 0, reasoning: 50 });
  });

  test("accepts the raw Responses API usage shape", () => {
    const t = normalizeUsage({
      input_tokens: 75,
      input_tokens_details: { cached_tokens: 64, cache_write_tokens: 3 },
      output_tokens: 1186,
      output_tokens_details: { reasoning_tokens: 1024 },
      total_tokens: 1261,
    });
    expect(t).toEqual({ input: 8, output: 1186, cacheRead: 64, cacheWrite5m: 3, cacheWrite1h: 0, reasoning: 1024 });
  });

  test("missing reasoning stays undefined, not 0", () => {
    const t = normalizeUsage({ input_tokens: 10, output_tokens: 2 });
    expect(t?.reasoning).toBeUndefined();
    expect(t).toMatchObject({ input: 10, output: 2, cacheRead: 0, cacheWrite5m: 0 });
  });

  test("rejects non-usage values and clamps inconsistent counts", () => {
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage({ foo: 1 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: "12", output_tokens: -1 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: 10, cached_input_tokens: 50, output_tokens: 1 })?.input).toBe(0);
  });
});

describe("kindFromSource", () => {
  test("maps Codex SessionSource values", () => {
    expect(kindFromSource("cli")).toBe("main");
    expect(kindFromSource("vscode")).toBe("main");
    expect(kindFromSource("exec")).toBe("main");
    expect(kindFromSource({ subagent: { other: "guardian" } }, "guardian_review", "p")).toBe("auxiliary");
    expect(kindFromSource({ subagent: "compact" })).toBe("auxiliary");
    expect(kindFromSource({ subagent: "review" })).toBe("subagent");
    expect(kindFromSource({ subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } })).toBe("subagent");
    expect(kindFromSource({ subagent: { other: "something-new" } })).toBe("other");
    expect(kindFromSource({ brand_new: true })).toBe("other");
    expect(kindFromSource(undefined, undefined, "parent")).toBe("subagent");
    expect(kindFromSource(undefined)).toBe("main");
  });
});

describe("rate-limit helpers", () => {
  test("canonical windows keep the slot name; other windows get their own kind", () => {
    expect(limitKind("codex", "primary", 300)).toEqual({ kind: "codex.primary", canonical: true });
    expect(limitKind("codex", "secondary", 10080)).toEqual({ kind: "codex.secondary", canonical: true });
    expect(limitKind("codex", "primary", 10080)).toEqual({ kind: "codex.primary.10080m", canonical: false });
    expect(limitKind(undefined, "secondary", undefined)).toEqual({ kind: "codex.secondary", canonical: true });
    expect(limitKind("premium", "primary", 300).kind).toBe("codex.premium.primary");
  });

  test("window labels", () => {
    expect(windowLabel(300)).toBe("5-hour");
    expect(windowLabel(10080)).toBe("Weekly");
    expect(windowLabel(1440)).toBe("1-day");
    expect(windowLabel(120)).toBe("2-hour");
    expect(windowLabel(45)).toBe("45-minute");
    expect(windowLabel(undefined)).toBeUndefined();
  });

  test("resets_at epoch seconds become ISO", () => {
    expect(resetToIso(1791554400)).toBe("2026-10-09T14:00:00.000Z");
    expect(resetToIso(1791554400000)).toBe("2026-10-09T14:00:00.000Z");
    expect(resetToIso("2026-10-09T14:00:00Z")).toBe("2026-10-09T14:00:00Z");
    expect(resetToIso(null)).toBeUndefined();
  });

  test("service tier → speed", () => {
    expect(speedFromTier("fast")).toBe("fast");
    expect(speedFromTier("priority")).toBe("fast");
    expect(speedFromTier("default")).toBe("standard");
    expect(speedFromTier("flex")).toBeUndefined();
    expect(speedFromTier(undefined)).toBeUndefined();
  });
});

describe("file names and paths", () => {
  test("rollout names carry a local start time and the thread id", () => {
    const r = parseRolloutName("rollout-2026-09-16T21-14-22-01a10000-0000-7000-8000-0000000000bb.jsonl");
    expect(r.threadId).toBe("01a10000-0000-7000-8000-0000000000bb");
    expect(r.startMs).toBe(new Date(2026, 8, 16, 21, 14, 22).getTime());
    expect(parseRolloutName("rollout-2026-09-16T21-14-22-x.jsonl.zst").threadId).toBe("x");
    expect(parseRolloutName("notes.txt")).toEqual({});
  });

  test("codexHome resolution: option, then CODEX_HOME, then ~/.codex", () => {
    expect(resolveCodexHome("/opt/codex", { CODEX_HOME: "/env/codex" })).toBe("/opt/codex");
    expect(resolveCodexHome(undefined, { CODEX_HOME: "/env/codex" })).toBe("/env/codex");
    expect(resolveCodexHome(undefined, { CODEX_HOME: "  " })).toBe(join(homedir(), ".codex"));
    expect(resolveCodexHome(undefined, {})).toBe(join(homedir(), ".codex"));
    expect(resolveCodexHome("~/alt-codex", {})).toBe(join(homedir(), "alt-codex"));
  });

  test("credential-like names are forbidden (basename only)", () => {
    for (const n of ["auth.json", "AUTH.JSON", "oauth_creds.json", "id_token", "credentials.json", "/x/y/refresh-token.txt"]) expect(isForbiddenName(n)).toBe(true);
    for (const n of ["rollout-2026-10-09T11-00-00-01a10000-0000-7000-8000-00000000000a.jsonl", "session_index.jsonl", "/tokenizer/home/.codex/sessions/rollout-x.jsonl"]) {
      expect(isForbiddenName(n)).toBe(false);
    }
  });

  test("the guard rejects forbidden paths before the underlying reader is called", async () => {
    let calls = 0;
    const inner: CodexIO = {
      readFile: async () => {
        calls++;
        return new Uint8Array();
      },
      stat: async () => undefined,
      readdir: async () => [],
    };
    await expect(guardIO(inner).readFile("/home/me/.codex/auth.json")).rejects.toBeInstanceOf(ForbiddenFileError);
    await expect(nodeIO.readFile("/definitely/not/here/auth.json")).rejects.toBeInstanceOf(ForbiddenFileError);
    expect(calls).toBe(0);
  });
});
