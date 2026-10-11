// Runs under `bun test` (named .spec.ts so `claude plugin test`, which collects *.test.ts, leaves it alone).
// Drives the hooks module with a recording fake `$`. Every value here is synthetic.
import { describe, expect, test } from "bun:test";
import type { TapSpool } from "../../../packages/core/src/types.ts";
import { register } from "../hooks/register.ts";

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

const HOME = "/Users/synthetic";
const SPOOL = `${HOME}/Library/Application Support/signalbox/spool`;
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ALLOWED = new Set(["env.get", "session.id", "session.usage", "fs.read", "fs.write", "clock.now", "ui.log"]);

const USAGE = {
  startedAt: NOW - 60_000,
  context: { tokens: 48_000, window: 1_000_000, percent: 5 },
  rateLimits: [
    { kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-10-09T15:00:00.000Z" },
    { kind: "seven_day", percentUsed: 41 },
  ],
  cost: { usd: 1.25 },
};

interface World {
  home?: string;
  sessionId: string;
  usage?: unknown;
  usageThrows?: boolean;
  writeThrows?: boolean;
  files: Map<string, string>;
  touched: string[];
  order: string[];
  logs: Array<{ text: string; to?: string }>;
}

// The module's seq map lives as long as the import, so every world gets a session id of its own.
let worlds = 0;
function world(over: Partial<World> = {}): World {
  return { home: HOME, sessionId: `sess-${++worlds}`, usage: USAGE, files: new Map(), touched: [], order: [], logs: [], ...over };
}

/** A `$` that answers the allowed calls from `w` and records every member touched, allowed or not. */
function engine(w: World): unknown {
  const nouns: Record<string, Record<string, (...args: never[]) => unknown>> = {
    env: { get: async (name: string) => (name === "HOME" ? w.home : undefined) },
    session: {
      id: async () => w.sessionId,
      usage: async () => {
        if (w.usageThrows) throw new Error("usage unavailable");
        return w.usage;
      },
    },
    fs: {
      read: async (path: string) => {
        const text = w.files.get(path);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      write: async (path: string, text: string) => {
        if (w.writeThrows) throw new Error("EACCES");
        w.order.push(`write ${path}`);
        w.files.set(path, text);
      },
    },
    clock: { now: async () => NOW },
    ui: { log: (text: string, options?: { to?: string }) => void w.logs.push({ text, to: options?.to }) },
  };
  return new Proxy({}, {
    get: (_, noun) =>
      new Proxy({}, {
        get: (__, method) => {
          const name = `${String(noun)}.${String(method)}`;
          w.touched.push(name);
          const fn = nouns[String(noun)]?.[String(method)];
          if (!fn) throw new Error(`unexpected $.${name}`);
          return fn;
        },
      }),
  });
}

function load(): Map<string, Hook> {
  const hooks = new Map<string, Hook>();
  const on = (event: string, a: unknown, b?: unknown) => {
    if (b !== undefined) throw new Error(`unexpected matcher on ${event}`);
    hooks.set(event, a as Hook);
    return { catch: () => undefined };
  };
  (register as unknown as (on: unknown, options: unknown) => void)(on, {});
  return hooks;
}

async function fire(w: World, event: string, e: unknown): Promise<unknown> {
  const hook = load().get(event);
  if (!hook) throw new Error(`no hook on ${event}`);
  return hook(engine(w), e, async (passed) => {
    w.order.push(`next ${event}`);
    return { echoed: passed };
  });
}

function spoolAt(w: World, sessionId: string): unknown {
  const text = w.files.get(`${SPOOL}/${sessionId}.json`);
  return text === undefined ? undefined : JSON.parse(text);
}

const START = { cwd: "/tmp/scratch", surface: "desktop", isInteractive: true };

describe("signalbox-tap", () => {
  test("hooks exactly session.start, session.measure and session.end", () => {
    expect([...load().keys()].sort()).toEqual(["session.end", "session.measure", "session.start"]);
  });

  test("session.start writes a v1 spool file after the engine's own start", async () => {
    const w = world();
    const result = await fire(w, "session.start", START);
    expect(result).toEqual({ echoed: START });
    expect(w.order).toEqual(["next session.start", `write ${SPOOL}/${w.sessionId}.json`]);
    const expected = {
      v: 1,
      seq: 1,
      agent: "claude-code",
      sessionId: w.sessionId,
      writtenAt: "2026-10-09T12:00:00.000Z",
      event: "session.start",
      usage: { context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost },
    } satisfies TapSpool;
    expect(spoolAt(w, w.sessionId)).toEqual(expected);
  });

  test("session.measure writes the pushed figures and increments seq", async () => {
    const w = world({ usage: { ...USAGE, cost: { usd: 999 } } });
    const hooks = load();
    const $ = engine(w);
    const next = async (e: unknown) => e;
    await hooks.get("session.start")!($, START, next);
    const measure = {
      context: { tokens: 120_000, window: 1_000_000, percent: 12 },
      rateLimits: [{ kind: "five_hour", percentUsed: 24, resetsAt: "2026-10-09T15:00:00.000Z" }],
      cost: { usd: 2.5 },
      changed: ["context", "rateLimits", "cost"],
    };
    expect(await hooks.get("session.measure")!($, measure, next)).toEqual(measure);
    const spool = spoolAt(w, w.sessionId) as TapSpool;
    expect(spool.seq).toBe(2);
    expect(spool.event).toBe("session.measure");
    expect(spool.usage).toEqual({ context: measure.context, rateLimits: measure.rateLimits, cost: { usd: 2.5 } });
    expect(w.touched.filter((t) => t === "session.usage")).toHaveLength(1); // start only; measure uses its input
  });

  test("session.end writes under the ending session's id, not the current one", async () => {
    const w = world({ sessionId: "sess-after-clear" });
    await fire(w, "session.end", { reason: "clear", sessionId: "sess-before-clear", resume: {} });
    expect((spoolAt(w, "sess-before-clear") as TapSpool).event).toBe("session.end");
    expect(spoolAt(w, "sess-after-clear")).toBeUndefined();
    expect(w.touched).not.toContain("session.id");
  });

  test("unknown figures stay unknown: no zeros, no empty arrays", async () => {
    const w = world({ usage: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } });
    await fire(w, "session.start", START);
    const spool = spoolAt(w, w.sessionId) as Record<string, unknown>;
    expect("usage" in spool).toBe(false);
  });

  test("keeps unknown rate-limit kinds verbatim and drops malformed rows", async () => {
    const w = world();
    const measure = {
      context: { window: 1_000_000 },
      rateLimits: [
        { kind: "seven_day_fable", percentUsed: 7 },
        { kind: "five_hour", percentUsed: "12" },
        { kind: "seven_day", percentUsed: Number.NaN },
        { percentUsed: 3 },
        null,
      ],
      changed: ["rateLimits"],
    };
    await fire(w, "session.measure", measure);
    expect((spoolAt(w, w.sessionId) as TapSpool).usage).toEqual({ rateLimits: [{ kind: "seven_day_fable", percentUsed: 7 }] });
  });

  test("seq continues from the existing file after a reload, and restarts at 1 over a torn file", async () => {
    const w = world();
    const torn = world({ files: w.files });
    w.files.set(`${SPOOL}/${w.sessionId}.json`, JSON.stringify({ v: 1, seq: 41 }));
    w.files.set(`${SPOOL}/${torn.sessionId}.json`, '{"v":1,"se');
    await fire(w, "session.start", START);
    expect((spoolAt(w, w.sessionId) as TapSpool).seq).toBe(42);
    await fire(torn, "session.start", START);
    expect((spoolAt(w, torn.sessionId) as TapSpool).seq).toBe(1);
  });

  test("never throws: a failed write still returns the engine's result and logs to debug only", async () => {
    const w = world({ writeThrows: true });
    for (const [event, e] of [
      ["session.start", START],
      ["session.measure", { context: { window: 1 }, rateLimits: [], changed: ["context"] }],
      ["session.end", { reason: "other", sessionId: w.sessionId, resume: {} }],
    ] as const) {
      expect(await fire(w, event, e)).toEqual({ echoed: e });
    }
    expect(w.logs).toHaveLength(3);
    expect(w.logs.every((l) => l.to === "debug" && l.text.includes("(Error)"))).toBe(true);
  });

  test("a failed usage read still records the event", async () => {
    const w = world({ usageThrows: true });
    await fire(w, "session.end", { reason: "prompt_input_exit", sessionId: w.sessionId, resume: {} });
    const spool = spoolAt(w, w.sessionId) as Record<string, unknown>;
    expect(spool.event).toBe("session.end");
    expect("usage" in spool).toBe(false);
  });

  test("writes nothing without an absolute HOME or a safe session id", async () => {
    for (const over of [{ home: undefined }, { home: "relative/home" }, { sessionId: "../escape" }, { sessionId: "" }]) {
      const w = world(over);
      expect(await fire(w, "session.start", START)).toEqual({ echoed: START });
      expect(w.files.size).toBe(0);
    }
  });

  test("touches only env, session, fs, clock and the debug log", async () => {
    const w = world();
    await fire(w, "session.start", START);
    await fire(w, "session.measure", { context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ["cost"] });
    await fire(w, "session.end", { reason: "other", sessionId: w.sessionId, resume: {} });
    const bad = world({ writeThrows: true });
    await fire(bad, "session.start", START);
    expect([...w.touched, ...bad.touched].filter((t) => !ALLOWED.has(t))).toEqual([]);
  });
});
