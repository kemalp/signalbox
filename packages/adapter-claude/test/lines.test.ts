import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFromEnd, forEachLine } from "../src/lines.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "signalbox-lines-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("forEachLine", () => {
  test("splits across chunk boundaries, keeps multibyte text intact, delivers an unterminated tail", async () => {
    const big = "é😀".repeat(400_000); // multi-MB line made of multibyte characters
    const lines = ["first", big, "", "third ü", "tail-without-newline"];
    const path = join(dir, "a.jsonl");
    writeFileSync(path, lines.join("\n"));
    const got: string[] = [];
    await forEachLine(path, (l) => got.push(l));
    expect(got.length).toBe(lines.length);
    expect(got).toEqual(lines);
  });

  test("empty file", async () => {
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    const got: string[] = [];
    await forEachLine(path, (l) => got.push(l));
    expect(got).toEqual([]);
  });
});

describe("findFromEnd", () => {
  test("finds the newest match, growing the window past huge lines", async () => {
    const path = join(dir, "b.jsonl");
    const huge = "x".repeat(700 * 1024);
    writeFileSync(path, ["target-old", "target-new", huge, huge, "noise", ""].join("\n"));
    expect(await findFromEnd(path, (l) => (l.startsWith("target") ? l : undefined))).toBe("target-new");
    expect(await findFromEnd(path, (l) => (l === "noise" ? 1 : undefined))).toBe(1);
    expect(await findFromEnd(path, (l) => (l === "absent" ? 1 : undefined))).toBeUndefined();
  });

  test("small file and empty file", async () => {
    const path = join(dir, "c.jsonl");
    writeFileSync(path, "only");
    expect(await findFromEnd(path, (l) => l)).toBe("only");
    writeFileSync(path, "");
    expect(await findFromEnd(path, (l) => l)).toBeUndefined();
  });
});
