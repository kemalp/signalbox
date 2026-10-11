// End-to-end checks of the `signalbox` binary in a sandbox: a temp HOME with no agent data, an empty
// PATH, no fallback binary dirs and a temp TMPDIR, so nothing real is read, run or touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
let root: string;
let env: Record<string, string>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "signalbox-cli-"));
  for (const d of ["home", "bin", "tmp"]) mkdirSync(join(root, d));
  env = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    CODEX_HOME: join(root, "home", ".codex"),
    SIGNALBOX_CLAUDE_BIN: "/nonexistent",
    SIGNALBOX_BIN_DIRS: "",
    PATH: join(root, "bin"),
    TMPDIR: join(root, "tmp"),
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const spoolDir = () => join(root, "home", "Library", "Application Support", "signalbox", "spool");
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe("signalbox binary", () => {
  test("report --json through a pipe is complete JSON, however large", async () => {
    // A 10-year window has ~3650 byDay rows: well over the 64-128 KiB a hard exit used to cut off.
    const { code, out } = await run(["report", "--json", "--days", "3650"]);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(200_000);
    const r = JSON.parse(out);
    expect(r.byDay.length).toBeGreaterThan(3600);
    expect(r.notes[0]).toStartWith("No agent data was found on this machine");
  });

  test("report with no agent data says 'no data', not $0.00", async () => {
    const { code, out } = await run(["report"]);
    expect(code).toBe(0);
    expect(out).toContain("no data");
    expect(out).not.toContain("$0.00");
    expect(out).toContain("CLAUDE_CONFIG_DIR");
  });

  test("usage errors exit 2", async () => {
    const { code, err } = await run(["report", "--since", "2999-01-01"]);
    expect(code).toBe(2);
    expect(err).toContain("--since is in the future");
  });

  test("doctor flags a group-readable spool dir even before any spool file exists", async () => {
    mkdirSync(spoolDir(), { recursive: true, mode: 0o755 });
    try {
      const { code, out } = await run(["doctor"]);
      expect(code).toBe(0);
      expect(out).toContain("it should be 0700");
      expect(out).toMatch(/tap +spool +OPEN/);
      expect(out).toContain("No agent data was found on this machine");
      // No claude binary: one warning for it, not a second one for agents --json.
      expect(out).not.toContain("agents-json is not working");
    } finally {
      rmSync(join(root, "home", "Library"), { recursive: true, force: true });
    }
  });

  test("serve tightens an existing spool dir to 0700 and cleans up its socket dir on SIGHUP", async () => {
    mkdirSync(spoolDir(), { recursive: true, mode: 0o755 });
    const proc = Bun.spawn([process.execPath, MAIN, "serve", "--no-open", "--port", "0"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      const deadline = Date.now() + 15_000;
      while (!out.includes("Open:") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(out).toContain("Open: http://127.0.0.1:");
      expect(mode(spoolDir())).toBe("700");
      expect(readdirSync(join(root, "tmp")).filter((n) => n.startsWith("signalbox-"))).toHaveLength(1);
      reader.releaseLock();
      proc.kill("SIGHUP");
      await proc.exited;
      expect(readdirSync(join(root, "tmp")).filter((n) => n.startsWith("signalbox-"))).toEqual([]);
    } finally {
      proc.kill();
      rmSync(join(root, "home", "Library"), { recursive: true, force: true });
    }
  }, 30_000);
});
