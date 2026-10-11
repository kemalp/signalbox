// VERSION at the repo root is the one release version. The package.json files and bun.lock's workspace entries
// copy it (the CLI's --version and the stream's hello come from apps/cli/package.json; build-app.sh stamps the app
// bundle from VERSION). `packaging/version.sh set X.Y.Z` updates every copy; this test fails when one is missed.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const REPO = join(import.meta.dir, "..", "..", "..");
const VERSION = readFileSync(join(REPO, "VERSION"), "utf8").trim();

function manifests(): string[] {
  const out = [join(REPO, "package.json")];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, group))) {
      try {
        readFileSync(join(REPO, group, name, "package.json"));
        out.push(join(REPO, group, name, "package.json"));
      } catch {
        // not a workspace package (e.g. apps/macos)
      }
    }
  }
  return out;
}

describe("one release version", () => {
  test("VERSION is plain X.Y.Z (CFBundleShortVersionString allows nothing else)", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the CLI reports it", () => {
    expect(pkg.version).toBe(VERSION);
  });

  test("every package.json and bun.lock workspace entry copies it (fix: sh packaging/version.sh set <VERSION>)", () => {
    const wrong = manifests()
      .map((f) => [f.slice(REPO.length + 1), (JSON.parse(readFileSync(f, "utf8")) as { version?: string }).version] as const)
      .filter(([, v]) => v !== VERSION);
    expect(wrong).toEqual([]);
    const lock = readFileSync(join(REPO, "bun.lock"), "utf8");
    const workspaces = lock.slice(lock.indexOf('"workspaces": {'), lock.indexOf('"packages": {'));
    const lockVersions = [...workspaces.matchAll(/^ {6}"version": "([^"]+)"/gm)].map((m) => m[1]);
    expect(lockVersions.length).toBeGreaterThan(0);
    expect(lockVersions.filter((v) => v !== VERSION)).toEqual([]);
  });
});
