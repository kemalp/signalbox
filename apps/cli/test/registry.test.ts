import { describe, expect, test } from "bun:test";
import { ADAPTERS, adapterIds, findEntry, loadAdapters, PLANNED } from "../src/registry.ts";

describe("registry", () => {
  test("ids are unique and include Claude Code, Codex and DeepSeek Harness", () => {
    const ids = adapterIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["claude-code", "codex", "deepseek-harness"]);
    expect(PLANNED.some((p) => ids.includes(p.id))).toBe(false);
  });

  test("each entry builds an adapter with the same id, and lists data paths without reading them", () => {
    for (const { entry, adapter } of loadAdapters()) {
      expect(adapter.id).toBe(entry.id);
      expect(adapter.displayName).toBe(entry.displayName);
      for (const d of entry.dataDirs(adapter)) expect(d.path.startsWith("/")).toBe(true);
    }
  });

  test("loadAdapters filters by id", () => {
    expect(loadAdapters("codex").map((l) => l.adapter.id)).toEqual(["codex"]);
    expect(loadAdapters("nope")).toEqual([]);
    expect(findEntry("claude-code")?.bin?.name).toBe("claude");
    expect(loadAdapters("deepseek-harness").map((l) => l.adapter.displayName)).toEqual(["DeepSeek Harness"]);
    expect(findEntry("deepseek-harness")).toMatchObject({ homeEnv: "DSH_HOME", bin: { name: "dsh", versionArgs: ["--version"] } });
    // The app's own launcher, for a desktop install that put no `dsh` on PATH.
    expect(findEntry("deepseek-harness")!.bin!.appPaths!.every((p) => p.endsWith("/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"))).toBe(true);
    expect(ADAPTERS.length).toBe(adapterIds().length);
  });
});
