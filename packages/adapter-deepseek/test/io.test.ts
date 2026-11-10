import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ForbiddenFileError, guardIO, isSessionLogPath, nodeIO, parseLogName, resolveDshHome } from "../src/io.ts";
import { completeFrameEnds, inflateFrames } from "../src/zstd.ts";
import { concat, frame } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "signalbox-dsh-io-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("resolveDshHome", () => {
  test("option, then DSH_HOME (unless blank), then ~/.dsh", () => {
    expect(resolveDshHome("/opt/dsh", { DSH_HOME: "/env/dsh" })).toBe("/opt/dsh");
    expect(resolveDshHome(undefined, { DSH_HOME: "/env/dsh" })).toBe("/env/dsh");
    expect(resolveDshHome(undefined, { DSH_HOME: "   " })).toBe(join(homedir(), ".dsh"));
    expect(resolveDshHome(undefined, {})).toBe(join(homedir(), ".dsh"));
    expect(resolveDshHome("~/elsewhere", {})).toBe(join(homedir(), "elsewhere"));
    expect(resolveDshHome(undefined, { DSH_HOME: "~" })).toBe(homedir());
    expect(resolveDshHome("/opt/dsh/", {})).toBe("/opt/dsh");
  });
});

describe("session log names", () => {
  test("parseLogName: the generation and whether it is compressed", () => {
    expect(parseLogName("session.jsonl.zstd")).toEqual({ generation: 0, compressed: true });
    expect(parseLogName("session.jsonl")).toEqual({ generation: 0, compressed: false });
    expect(parseLogName("session.v4.jsonl.zstd")).toEqual({ generation: 4, compressed: true });
    expect(parseLogName("session.v12.jsonl")).toEqual({ generation: 12, compressed: false });
    for (const n of ["session.lock", "session.v4.jsonl.zst", "session.v.jsonl", "sessions.v4.jsonl", "session.v4.jsonl.zstd.tmp", ".credentials.yaml", "credentials.jsonl", "session.v4.json"]) {
      expect(parseLogName(n)).toBeUndefined();
    }
  });

  test("isSessionLogPath: only <project>/<session>/<log> under the sessions root", () => {
    const root = "/h/.dsh/sessions";
    expect(isSessionLogPath(root, `${root}/--p--/session-1/session.v4.jsonl.zstd`)).toBe(true);
    expect(isSessionLogPath(root, `${root}/_no-cwd/abc/session.jsonl`)).toBe(true);
    for (const p of [
      `${root}/--p--/session-1/session.lock`,
      `${root}/--p--/session-1/credentials.json`,
      `${root}/--p--/session.v4.jsonl.zstd`, // not in a session folder
      `${root}/--p--/session-1/deeper/session.v4.jsonl.zstd`,
      `${root}/session.v4.jsonl.zstd`,
      "/h/.dsh/.credentials.yaml",
      "/h/.dsh/settings.yaml",
      "/h/.dsh/storages/session_projcache/sessions/x.json",
      `${root}/--p--/session-1/../../../.credentials.yaml`,
      `${root}/../other/a/b/session.v4.jsonl.zstd`,
      "/elsewhere/a/b/session.v4.jsonl.zstd",
      root,
    ]) {
      expect(isSessionLogPath(root, p)).toBe(false);
    }
  });
});

describe("guardIO", () => {
  test("reads session logs and nothing else; lists and lstats only inside the sessions root", async () => {
    const home = join(tmp, "home");
    const sessions = join(home, "sessions");
    const dir = join(sessions, "--p--", "session-1");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "session.v4.jsonl");
    writeFileSync(log, "0123456789");
    writeFileSync(join(dir, "credentials.json"), "secret");
    writeFileSync(join(home, ".credentials.yaml"), "secret");
    symlinkSync(dir, join(sessions, "--p--", "link"));
    const io = guardIO(nodeIO, home, sessions);

    expect(text(await io.readRange(log, 3, 4))).toBe("3456");
    expect(text(await io.readRange(log, 8, 100))).toBe("89");
    await expect(io.readRange(join(dir, "credentials.json"), 0, 10)).rejects.toBeInstanceOf(ForbiddenFileError);
    await expect(io.readRange(join(home, ".credentials.yaml"), 0, 10)).rejects.toBeInstanceOf(ForbiddenFileError);
    await expect(io.readRange(join(sessions, "--p--", "link", "..", "..", "..", ".credentials.yaml"), 0, 10)).rejects.toBeInstanceOf(ForbiddenFileError);

    expect((await io.stat(home))?.isDirectory).toBe(true);
    expect((await io.stat(sessions))?.isDirectory).toBe(true);
    expect(await io.stat(join(home, ".credentials.yaml"))).toBeUndefined();
    expect((await io.lstat(log))?.isFile).toBe(true);
    expect(await io.lstat(join(home, ".credentials.yaml"))).toBeUndefined();
    // A symbolic link is neither a file nor a folder: never followed.
    expect(await io.lstat(join(sessions, "--p--", "link"))).toMatchObject({ isFile: false, isDirectory: false });
    expect((await io.readdir(join(sessions, "--p--"))).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "link", kind: "other" },
      { name: "session-1", kind: "dir" },
    ]);
    expect(await io.readdir(home)).toEqual([]);
    expect(await io.readdir(join(sessions, "missing"))).toEqual([]);
  });
});

describe("Zstandard frames", () => {
  test("completeFrameEnds: streamed, sized and skippable frames; a torn one is left alone", async () => {
    const a = await frame("first batch\n"); // as the harness writes: no content size, checksummed
    const b = Bun.zstdCompressSync(new TextEncoder().encode("second batch\n")); // single segment, sized, no checksum
    const skippable = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9]);
    const big = await frame(`${"a line of a long batch\n".repeat(20_000)}`); // more than one block
    expect(a[4]).toBe(0x04);
    const all = concat([a, b, skippable, big]);
    const ends = [a.length, a.length + b.length, a.length + b.length + skippable.length, all.length];
    expect(completeFrameEnds(all)).toEqual(ends);
    expect(completeFrameEnds(new Uint8Array(0))).toEqual([]);
    // Cut anywhere inside the last frame: only the whole frames before it count.
    for (const cut of [1, 3, 4, 5, 9, big.length - 5, big.length - 1]) expect(completeFrameEnds(all.subarray(0, ends[2]! + cut))).toEqual(ends.slice(0, 3));
    // Bytes that start no frame end the walk.
    expect(completeFrameEnds(concat([a, new TextEncoder().encode("plain text"), b]))).toEqual([a.length]);
    // A view into a larger buffer.
    const padded = concat([new Uint8Array(7), all]);
    expect(completeFrameEnds(padded.subarray(7))).toEqual(ends);
  });

  test("inflateFrames: whole frames in order; a bad frame stops the read after the good ones", async () => {
    const frames = await Promise.all(["one\n", "two\n", "three\n"].map(frame));
    let out = "";
    expect(inflateFrames(concat(frames), (p) => (out += text(p)))).toEqual({ consumed: frames.reduce((n, f) => n + f.length, 0), corrupt: false });
    expect(out).toBe("one\ntwo\nthree\n");

    const torn = concat([frames[0]!, frames[1]!.subarray(0, 6)]);
    out = "";
    expect(inflateFrames(torn, (p) => (out += text(p)))).toEqual({ consumed: frames[0]!.length, corrupt: false });
    expect(out).toBe("one\n");

    const bad = frames[1]!.slice();
    bad[bad.length - 1]! ^= 0xff;
    out = "";
    expect(inflateFrames(concat([frames[0]!, bad, frames[2]!]), (p) => (out += text(p)))).toEqual({ consumed: frames[0]!.length, corrupt: true });
    expect(out).toBe("one\n");
  });
});
