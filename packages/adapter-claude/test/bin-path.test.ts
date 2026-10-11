import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentsJson, withBinDirOnPath } from "../src/sessions.ts";

const root = mkdtempSync(join(tmpdir(), "signalbox-binpath-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("withBinDirOnPath", () => {
  test("prepends the binary's dir only when PATH lacks it", () => {
    expect(withBinDirOnPath("/opt/x/bin/claude", { PATH: "/usr/bin:/bin" }).PATH).toBe("/opt/x/bin:/usr/bin:/bin");
    const env = { PATH: "/usr/bin:/opt/x/bin" };
    expect(withBinDirOnPath("/opt/x/bin/claude", env)).toBe(env);
    expect(withBinDirOnPath("/opt/x/bin/claude", {}).PATH).toBe("/opt/x/bin");
    const rel = { PATH: "/usr/bin" };
    expect(withBinDirOnPath("claude", rel)).toBe(rel);
  });

  test("an `env <interpreter>` script runs under a Finder-style PATH when its interpreter sits next to it", async () => {
    // Synthetic stand-ins: `claude` is a script whose interpreter (`fakenode`) lives in the same dir,
    // like an npm global install under nvm or Homebrew.
    const bin = join(root, "nvm-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "fakenode"), "#!/bin/sh\necho '[]'\n");
    writeFileSync(join(bin, "claude"), "#!/usr/bin/env fakenode\n");
    chmodSync(join(bin, "fakenode"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    const run = await runAgentsJson(join(bin, "claude"), { timeoutMs: 5000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    expect(run).toMatchObject({ ok: true, entries: [] });
  });
});
