// Binary discovery against a fake HOME and fake system dirs: nothing real is looked up or run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN_DIRS_ENV, envForBinary, fallbackDirs, findBinary, nvmBinDirs } from "../src/binaries.ts";
import { agentVersion, binarySource } from "../src/doctor.ts";

let root: string;
let home: string;
let sys: string[];
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function exe(dir: string, name: string, body = "#!/bin/sh\necho 'fake 1.0.0'\n"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-bins-"));
  home = join(root, "home");
  sys = [join(root, "opt-homebrew-bin"), join(root, "usr-local-bin")];
  mkdirSync(home);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = (extra: Record<string, string> = {}) => ({ env: { PATH: FINDER_PATH, ...extra }, home, systemDirs: sys });

describe("fallbackDirs", () => {
  test("lists the documented order, nvm versions highest first", () => {
    for (const v of ["v18.20.4", "v22.11.0", "v20.9.0", "v22.2.0", "not-a-version"]) mkdirSync(join(home, ".nvm", "versions", "node", v, "bin"), { recursive: true });
    const nvm = join(home, ".nvm", "versions", "node");
    expect(fallbackDirs({ env: {}, home, systemDirs: sys })).toEqual([
      join(home, ".local/bin"),
      join(home, ".claude/local"),
      join(home, ".bun/bin"),
      sys[0]!,
      sys[1]!,
      join(nvm, "v22.11.0", "bin"),
      join(nvm, "v22.2.0", "bin"),
      join(nvm, "v20.9.0", "bin"),
      join(nvm, "v18.20.4", "bin"),
      join(home, ".volta/bin"),
      join(home, ".asdf/shims"),
    ]);
    rmSync(join(home, ".nvm"), { recursive: true, force: true });
  });

  test("the default system dirs are Homebrew's", () => {
    const dirs = fallbackDirs({ env: {}, home });
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs.indexOf("/opt/homebrew/bin")).toBeLessThan(dirs.indexOf("/usr/local/bin"));
  });

  test("$NVM_DIR moves the nvm root", () => {
    const nvm = join(root, "custom-nvm");
    mkdirSync(join(nvm, "versions", "node", "v21.0.0", "bin"), { recursive: true });
    expect(fallbackDirs({ env: { NVM_DIR: nvm }, home, systemDirs: [] })).toContain(join(nvm, "versions", "node", "v21.0.0", "bin"));
    expect(nvmBinDirs(join(root, "nowhere"))).toEqual([]);
  });

  test(`$${BIN_DIRS_ENV} replaces the list; empty disables it`, () => {
    expect(fallbackDirs({ env: { [BIN_DIRS_ENV]: `/a:relative:/b` }, home })).toEqual(["/a", "/b"]);
    expect(fallbackDirs({ env: { [BIN_DIRS_ENV]: "" }, home })).toEqual([]);
  });
});

describe("findBinary", () => {
  test("walks override → PATH → fallbacks, earliest hit wins", () => {
    const nvmOld = exe(join(home, ".nvm", "versions", "node", "v20.1.0", "bin"), "claude");
    const nvmNew = exe(join(home, ".nvm", "versions", "node", "v22.0.0", "bin"), "claude");
    expect(findBinary("claude", opts())).toEqual({ path: nvmNew, via: join(home, ".nvm", "versions", "node", "v22.0.0", "bin") });
    rmSync(nvmNew);
    // A version dir without the binary is skipped, not a dead end.
    expect(findBinary("claude", opts())?.path).toBe(nvmOld);

    const brew = exe(sys[0]!, "claude");
    expect(findBinary("claude", opts())).toEqual({ path: brew, via: sys[0]! });
    const bun = exe(join(home, ".bun", "bin"), "claude");
    expect(findBinary("claude", opts())?.path).toBe(bun);
    const local = exe(join(home, ".claude", "local"), "claude");
    expect(findBinary("claude", opts())?.path).toBe(local);
    const dotLocal = exe(join(home, ".local", "bin"), "claude");
    expect(findBinary("claude", opts())).toEqual({ path: dotLocal, via: join(home, ".local/bin") });

    const pathDir = join(root, "on-path");
    const onPath = exe(pathDir, "claude");
    expect(findBinary("claude", { ...opts(), env: { PATH: `${pathDir}:${FINDER_PATH}` } })).toEqual({ path: onPath, via: "PATH" });

    expect(findBinary("claude", { ...opts({ SIGNALBOX_CLAUDE_BIN: "/custom/claude" }), envVar: "SIGNALBOX_CLAUDE_BIN" })).toEqual({
      path: "/custom/claude",
      via: "SIGNALBOX_CLAUDE_BIN",
    });
    // The override only counts for the binary that declares it.
    expect(findBinary("claude", opts({ SIGNALBOX_CLAUDE_BIN: "/custom/claude" }))?.path).toBe(dotLocal);
  });

  test("skips non-executable files and directories; nothing found is undefined", () => {
    const dir = join(home, ".volta", "bin");
    mkdirSync(join(dir, "codex"), { recursive: true });
    mkdirSync(join(home, ".asdf", "shims"), { recursive: true });
    writeFileSync(join(home, ".asdf", "shims", "codex"), "#!/bin/sh\n");
    chmodSync(join(home, ".asdf", "shims", "codex"), 0o644);
    expect(findBinary("codex", opts())).toBeUndefined();
    const shim = exe(join(home, ".asdf", "shims"), "gemini");
    expect(findBinary("gemini", opts())).toEqual({ path: shim, via: join(home, ".asdf/shims") });
  });

  test("an app bundle's own launcher is tried last, and never when the fallbacks are overridden", () => {
    const system = exe(join(root, "Applications", "Some Agent.app", "Contents", "Resources", "cli", "bin"), "agentx");
    const user = exe(join(home, "Applications", "Some Agent.app", "Contents", "Resources", "cli", "bin"), "agentx");
    const appPaths = [join(root, "missing", "agentx"), "relative/agentx", system, "~/Applications/Some Agent.app/Contents/Resources/cli/bin/agentx"];
    expect(findBinary("agentx", opts())).toBeUndefined();
    expect(findBinary("agentx", { ...opts(), appPaths })).toEqual({ path: system, via: join(root, "Applications", "Some Agent.app", "Contents", "Resources", "cli", "bin") });
    expect(findBinary("agentx", { ...opts(), appPaths: appPaths.slice(3) })?.path).toBe(user);
    // A copy in a fallback directory, or on PATH, comes first.
    const brew = exe(sys[1]!, "agentx");
    expect(findBinary("agentx", { ...opts(), appPaths })?.path).toBe(brew);
    rmSync(brew);
    // $SIGNALBOX_BIN_DIRS replaces every fallback, the app paths included: tests never reach a real install.
    expect(findBinary("agentx", { ...opts({ [BIN_DIRS_ENV]: "" }), appPaths })).toBeUndefined();
    expect(findBinary("agentx", { ...opts({ [BIN_DIRS_ENV]: sys[0]! }), appPaths })).toBeUndefined();
  });
});

describe("envForBinary", () => {
  test("adds the binary's dir to PATH only when it is missing", () => {
    expect(envForBinary("/x/bin/codex", { PATH: FINDER_PATH }).PATH).toBe(`/x/bin:${FINDER_PATH}`);
    const env = { PATH: `/x/bin:${FINDER_PATH}` };
    expect(envForBinary("/x/bin/codex", env)).toBe(env);
  });
});

describe("doctor agentVersion", () => {
  test("reports the fallback dir it used and runs --version with that dir on PATH", async () => {
    const dir = join(root, "gem-home", ".local", "bin");
    exe(dir, "fakeinterp", "#!/bin/sh\necho 'gemini 9.9.9'\n");
    exe(dir, "gemini", "#!/usr/bin/env fakeinterp\n");
    const info = await agentVersion({ name: "gemini", versionArgs: ["--version"] }, { PATH: FINDER_PATH, [BIN_DIRS_ENV]: dir }, join(root, "gem-home"));
    expect(info).toEqual({ name: "gemini", path: join(dir, "gemini"), via: dir, version: "gemini 9.9.9" });
    expect(binarySource(info.via)).toBe(`(not on PATH; found in ${dir})`);
    expect(binarySource("PATH")).toBe("(on PATH)");
    expect(binarySource("SIGNALBOX_CLAUDE_BIN")).toBe("(from $SIGNALBOX_CLAUDE_BIN)");
    expect(binarySource("/Applications/Some Agent.app/Contents/Resources/cli/bin")).toBe("(not on PATH; found in the app's bundle)");
  });

  test("not found anywhere says so", async () => {
    const info = await agentVersion({ name: "codex", versionArgs: ["--version"] }, { PATH: FINDER_PATH, [BIN_DIRS_ENV]: "" }, join(root, "empty"));
    expect(info.path).toBeUndefined();
    expect(info.error).toContain("not found on PATH or in the usual install dirs");
  });
});

describe("the signalbox-switch shim", () => {
  const shimBody = "#!/bin/sh\n# signalbox-switch shim (written by Signalbox; your edits are overwritten). Unofficial.\nexec false\n";

  test("is skipped on PATH and in the fallback dirs, and reported", () => {
    const shimDir = join(root, "switch-bin");
    const shim = exe(shimDir, "claude", shimBody);
    const real = exe(join(root, "real-bin"), "claude");
    const found = findBinary("claude", opts({ PATH: `${shimDir}:${join(root, "real-bin")}:${FINDER_PATH}` }));
    expect(found).toEqual({ path: real, via: "PATH", skippedShims: [shim] });
    // Only the shim on PATH: the fallback dirs still find the real one.
    const fallback = exe(sys[0]!, "claude");
    expect(findBinary("claude", opts({ PATH: `${shimDir}:${FINDER_PATH}`, [BIN_DIRS_ENV]: `${shimDir}:${sys[0]}` }))).toEqual({
      path: fallback,
      via: sys[0]!,
      skippedShims: [shim],
    });
    rmSync(fallback);
    // Nothing but the shim: not found, rather than the shim.
    expect(findBinary("claude", opts({ PATH: `${shimDir}:${FINDER_PATH}`, [BIN_DIRS_ENV]: shimDir }))).toBeUndefined();
    // An ordinary script is never mistaken for it, and relative PATH entries are ignored.
    expect(findBinary("claude", opts({ PATH: `relative:${join(root, "real-bin")}` }))).toEqual({ path: real, via: "PATH" });
  });
});
