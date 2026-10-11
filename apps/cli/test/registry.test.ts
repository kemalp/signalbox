import { describe, expect, test } from "bun:test";
import { ADAPTERS, adapterIds, findEntry, loadAdapters, PLANNED } from "../src/registry.ts";

describe("registry", () => {
  test("ids are unique and include Claude Code and Codex", () => {
    const ids = adapterIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
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
    expect(ADAPTERS.length).toBe(adapterIds().length);
  });
});
