import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "../../core/src/index.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const BIN = join(FIXTURES, "bin");

export const SID_A = "11111111-1111-4111-8111-111111111111";
export const SID_B = "22222222-2222-4222-8222-222222222222";
export const SID_C = "33333333-3333-4333-8333-333333333333";
export const SID_D = "44444444-4444-4444-8444-444444444444";
export const SID_E = "55555555-5555-4555-8555-555555555555";

export const A_MTIME = new Date("2026-01-10T13:00:00.000Z");
export const B_MTIME = new Date("2026-01-05T01:00:00.000Z");
export const A_REGISTRY_STATUS_AT = Date.parse("2026-01-10T11:59:00.000Z");

export const A_DIR = join("projects", "-Users-test-alpha");
export const A_MAIN = join(A_DIR, `${SID_A}.jsonl`);
export const A_SUB = join(A_DIR, SID_A, "subagents", "agent-a1b2.jsonl");
export const A_WF = join(A_DIR, SID_A, "subagents", "workflows", "wf_abc123", "agent-w1.jsonl");
export const A_JOURNAL = join(A_DIR, SID_A, "subagents", "workflows", "wf_abc123", "journal.jsonl");
export const B_MAIN = join("projects", "-Users-test-beta", `${SID_B}.jsonl`);

export interface Sandbox {
  root: string;
  configDir: string;
  spoolDir: string;
  cleanup(): void;
}

/**
 * Copies the synthetic fixtures to a temp dir, pins file mtimes (the adapter skips files by mtime)
 * and adds a registry file for this test process's own pid, so one session is provably alive.
 */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "signalbox-claude-"));
  const configDir = join(root, "claude-config");
  const spoolDir = join(root, "spool");
  cpSync(join(FIXTURES, "claude-config"), configDir, { recursive: true });
  cpSync(join(FIXTURES, "spool"), spoolDir, { recursive: true });
  for (const p of [A_MAIN, A_SUB, A_WF, A_JOURNAL]) utimesSync(join(configDir, p), A_MTIME, A_MTIME);
  utimesSync(join(configDir, B_MAIN), B_MTIME, B_MTIME);
  // Claude Code's global config; the adapter only checks that it exists before running agents --json.
  writeFileSync(join(configDir, ".claude.json"), "{}\n");
  writeFileSync(
    join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SID_A,
      cwd: "/Users/test/alpha",
      startedAt: Date.parse("2026-01-10T09:59:00.000Z"),
      version: "2.1.293",
      kind: "interactive",
      entrypoint: "cli",
      name: "alpha registry name",
      updatedAt: A_REGISTRY_STATUS_AT,
      status: "busy",
      statusUpdatedAt: A_REGISTRY_STATUS_AT,
    }),
  );
  return { root, configDir, spoolDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function collect(it: AsyncIterable<UsageRecord>): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

export function byId(records: UsageRecord[]): Map<string, UsageRecord> {
  return new Map(records.map((r) => [r.id, r]));
}
