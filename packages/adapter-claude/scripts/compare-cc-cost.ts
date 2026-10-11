#!/usr/bin/env bun
// Compares ClaudeCodeAdapter.scanUsage token totals with the reference research/cost/cc_cost.py.
// Prints AGGREGATES ONLY (counts and token sums); never message content.
//
//   bun packages/adapter-claude/scripts/compare-cc-cost.ts [--days 7] [--quiet-minutes 2] [--live]
//
// Both sides use the same frozen `now`, so the window boundary is identical. By default both sides
// also see the same frozen file set: transcripts not modified in the last --quiet-minutes, because
// live sessions keep appending while the two scans run. --live drops that filter (expect small drift).
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createClaudeAdapter } from "../src/index.ts";
import { listTranscripts, mtimeMs } from "../src/paths.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const days = opt("--days", 7);
const quietMinutes = opt("--quiet-minutes", 2);
const live = args.includes("--live");

const repo = resolve(import.meta.dir, "../../..");
const configDir = join(homedir(), ".claude");
const projectsDir = join(configDir, "projects");
const nowMs = Date.now();
const since = new Date(nowMs - days * 86_400_000);
const until = new Date(nowMs);

// Frozen file set.
let allowed: Set<string> | undefined;
if (!live) {
  allowed = new Set();
  for (const f of await listTranscripts(projectsDir)) {
    const mt = await mtimeMs(f.path);
    if (mt !== undefined && mt <= nowMs - quietMinutes * 60_000) allowed.add(f.path);
  }
}

// Reference, with `now` pinned and glob optionally limited to the frozen set.
const wrapper = `
import sys, json, types, datetime as real, glob as g
sys.path.insert(0, sys.argv[1])
import cc_cost
NOW = float(sys.argv[2]) / 1000.0
class FixedDT(real.datetime):
    @classmethod
    def now(cls, tz=None): return real.datetime.fromtimestamp(NOW, tz)
cc_cost.dt = types.SimpleNamespace(datetime=FixedDT, timedelta=real.timedelta, timezone=real.timezone)
allowed = json.load(sys.stdin)
if allowed is not None:
    allowed = set(allowed); orig = g.glob
    cc_cost.glob.glob = lambda p, recursive=False: [f for f in orig(p, recursive=recursive) if f in allowed]
sys.argv = ['cc_cost.py', '--json', '--days', sys.argv[3], '--root', sys.argv[4]]
cc_cost.main()
`;
const t0 = performance.now();
const proc = Bun.spawn(
  ["python3", "-I", "-c", wrapper, join(repo, "research/cost"), String(nowMs), String(days), projectsDir],
  { stdin: new Blob([JSON.stringify(allowed ? [...allowed] : null)]), stdout: "pipe", stderr: "inherit" },
);
const refText = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) throw new Error("reference script failed");
const ref = JSON.parse(refText);
const refMs = performance.now() - t0;

// Adapter.
const canonical = (m: string) => m.replace(/-\d{8}$/, "").replace(/\[1m\]$/, "");
type Row = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; placeholders: number; webSearch: number; thinking: number };
const zero = (): Row => ({ responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, placeholders: 0, webSearch: 0, thinking: 0 });
const byModel = new Map<string, Row>();
const byKind = new Map<string, Row>();
const tot = zero();
const adapter = createClaudeAdapter({ configDir });
const t1 = performance.now();
for await (const r of adapter.scanUsage({ since, until })) {
  if (allowed && r.sourcePath && !allowed.has(r.sourcePath)) continue;
  const model = canonical(r.model);
  const kind = r.kind === "other" ? "main" : r.kind; // the reference calls every non-subagent file "main"
  for (const row of [
    byModel.get(model) ?? byModel.set(model, zero()).get(model)!,
    byKind.get(kind) ?? byKind.set(kind, zero()).get(kind)!,
    tot,
  ]) {
    row.responses++;
    row.input += r.tokens.input;
    row.output += r.tokens.output;
    row.cacheRead += r.tokens.cacheRead;
    row.cacheWrite += r.tokens.cacheWrite5m + r.tokens.cacheWrite1h;
    row.cacheWrite1h += r.tokens.cacheWrite1h;
    row.placeholders += r.outputFinal ? 0 : 1;
    row.webSearch += r.webSearchRequests;
    row.thinking += r.tokens.reasoning ?? 0;
  }
}
const oursMs = performance.now() - t1;

let mismatches = 0;
const lines: string[] = [];
const cmp = (scope: string, field: string, theirs: number | undefined, ours: number) => {
  const ok = (theirs ?? 0) === ours;
  if (!ok) mismatches++;
  lines.push(`${ok ? "  ok " : "  !! "}${scope.padEnd(24)}${field.padEnd(14)}${String(theirs ?? 0).padStart(16)}${String(ours).padStart(16)}`);
};

const t = ref.totals;
cmp("TOTAL", "responses", ref.unique_api_responses, tot.responses);
cmp("TOTAL", "input", t.input, tot.input);
cmp("TOTAL", "output", t.output_recorded, tot.output);
cmp("TOTAL", "cacheRead", t.cache_read, tot.cacheRead);
cmp("TOTAL", "cacheWrite", t.cache_write, tot.cacheWrite);
cmp("TOTAL", "cacheWrite1h", t.cache_write_1h, tot.cacheWrite1h);
cmp("TOTAL", "placeholders", t.placeholder_output_responses, tot.placeholders);
cmp("TOTAL", "webSearch", t.web_search, tot.webSearch);
cmp("TOTAL", "thinking", t.thinking_recorded, tot.thinking);
const models = new Set([...Object.keys(ref.by_model), ...byModel.keys()]);
for (const m of [...models].sort()) {
  const r = ref.by_model[m] ?? {};
  const o = byModel.get(m) ?? zero();
  cmp(m, "responses", r.responses, o.responses);
  cmp(m, "input", r.input, o.input);
  cmp(m, "output", r.output_recorded, o.output);
  cmp(m, "cacheRead", r.cache_read, o.cacheRead);
  cmp(m, "cacheWrite", r.cache_write, o.cacheWrite);
  cmp(m, "placeholders", r.placeholder_output_responses, o.placeholders);
}
const kinds = new Set([...Object.keys(ref.by_kind), ...byKind.keys()]);
for (const k of [...kinds].sort()) {
  const r = ref.by_kind[k] ?? {};
  const o = byKind.get(k) ?? zero();
  cmp(`kind:${k}`, "responses", r.responses, o.responses);
  // The reference only prints a 3-decimal share here, so this one is checked to that precision.
  const share = o.responses ? Math.round((o.placeholders / o.responses) * 1000) / 1000 : 0;
  const ok = share === (r.placeholder_output_share ?? 0);
  if (!ok) mismatches++;
  lines.push(`${ok ? "  ok " : "  !! "}${`kind:${k}`.padEnd(24)}${"placeholder%".padEnd(14)}${String(r.placeholder_output_share ?? 0).padStart(16)}${String(share).padStart(16)}`);
}

console.log(`window ${since.toISOString()} -> ${until.toISOString()} (${days} days), mode ${live ? "live" : `frozen (files quiet >= ${quietMinutes} min: ${allowed?.size})`}`);
console.log(`reference ${refMs.toFixed(0)} ms, adapter ${oursMs.toFixed(0)} ms; adapter scan stats ${JSON.stringify(adapter.lastScanStats())}`);
console.log(`     ${"scope".padEnd(24)}${"field".padEnd(14)}${"cc_cost.py".padStart(16)}${"adapter".padStart(16)}`);
console.log(lines.join("\n"));
console.log(mismatches === 0 ? "MATCH: all compared token totals are identical" : `MISMATCH: ${mismatches} fields differ`);
process.exit(mismatches === 0 ? 0 : 1);
