// Guards the CLI ↔ macOS app contract from the CLI side. The app's Swift tests decode
// apps/macos/Fixtures/stream-v1.ndjson and Fixtures/history.json and fail if a field is lost; this test fails
// when the CLI starts sending a key path a committed fixture doesn't have, so the fixture (and the Swift models)
// get updated.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureSyntheticStream } from "../../macos/scripts/make-stream-fixture.ts";
import { makeAppHome, runCli } from "./claude-app-home.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "macos", "Fixtures");
/** SIGNALBOX_STREAM_FIXTURE checks a candidate fixture (e.g. a regenerated copy) before it is committed. */
const FIXTURE = process.env.SIGNALBOX_STREAM_FIXTURE || join(FIXTURES, "stream-v1.ndjson");
/** The app's synthetic `signalbox history --json` (scripts/make-history-fixture.ts); SIGNALBOX_HISTORY_FIXTURE for a candidate. */
const HISTORY_FIXTURE = process.env.SIGNALBOX_HISTORY_FIXTURE || join(FIXTURES, "history.json");

/** Every key path in a JSON value, arrays written as `[]`: "data.sessions[].context.window". */
function keyPaths(value: unknown, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keyPaths(v, `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const p = path ? `${path}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

/** Key paths per line type ("report" lines merged), from NDJSON text. */
function pathsByType(ndjson: string): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as { type: string };
    let set = byType.get(obj.type);
    if (!set) byType.set(obj.type, (set = new Set()));
    keyPaths(obj, "", set);
  }
  return byType;
}

describe("the macOS app's fixtures", () => {
  let fresh: Map<string, Set<string>>;
  let historyLine: { data?: unknown } | undefined;

  test("stream-v1.ndjson has every key path the CLI sends today", async () => {
    const text = await captureSyntheticStream();
    fresh = pathsByType(text);
    historyLine = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string; data?: unknown })
      .find((l) => l.type === "history");
    const committed = pathsByType(readFileSync(FIXTURE, "utf8"));
    expect([...fresh.keys()].sort()).toEqual(["commands", "error", "fleet", "health", "hello", "history", "report"]);
    const missing: string[] = [];
    for (const [type, paths] of fresh) for (const p of paths) if (!committed.get(type)?.has(p)) missing.push(`${type}: ${p}`);
    // If this fails: bun apps/macos/scripts/make-stream-fixture.ts > apps/macos/Fixtures/stream-v1.ndjson,
    // then `swift test` in apps/macos to see which Swift model needs the new field.
    expect(missing).toEqual([]);
  }, 30_000);

  test("history.json has every key path of the CLI's history", () => {
    // The synthetic stream's history line, from the real CLI (the test above captured it).
    expect(historyLine?.data).toBeDefined();
    const sent = keyPaths(historyLine!.data);
    const committed = keyPaths(JSON.parse(readFileSync(HISTORY_FIXTURE, "utf8")));
    // If this fails: give the entries in apps/macos/scripts/make-history-fixture.ts the new field, run
    // bun apps/macos/scripts/make-history-fixture.ts > apps/macos/Fixtures/history.json, then `swift test`.
    expect([...sent].filter((p) => !committed.has(p)).sort()).toEqual([]);
  });

  test("history.json has every key path of a history with the Claude app's list", async () => {
    // The synthetic stream's home has a small Claude app list (three records); this home has more kinds of record
    // (merged and app-only sessions, archived ones, the app's title label and effort, a record without a cli id).
    const home = makeAppHome();
    try {
      const { out, code } = await runCli(["history", "--json"], home.env);
      expect(code).toBe(0);
      const sent = keyPaths(JSON.parse(out));
      const committed = keyPaths(JSON.parse(readFileSync(HISTORY_FIXTURE, "utf8")));
      // If this fails: give apps/macos/scripts/make-history-fixture.ts entries with these fields, regenerate
      // apps/macos/Fixtures/history.json, then `swift test`.
      expect([...sent].filter((p) => !committed.has(p)).sort()).toEqual([]);
    } finally {
      home.cleanup();
    }
  }, 20_000);
});
