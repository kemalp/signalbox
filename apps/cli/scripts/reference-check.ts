#!/usr/bin/env bun
// Compares `signalbox report --agent claude-code --json` with the reference research/cost/cc_cost.py
// over the same fixed window. Prints AGGREGATES ONLY (counts, token sums, dollars).
//
//   bun apps/cli/scripts/reference-check.ts [--days 7] [--lag-minutes 10]
//
// `--days` here is N x 24h, like `cc_cost.py --days N` (and `signalbox report --days N --rolling`; plain
// `report --days N` is calendar days). Both runs get the same explicit window: `--since`/`--until` for signalbox.
// The window ends `--lag-minutes` ago, so lines that live sessions write while the two runs are in
// progress fall outside it. cc_cost.py has no upper bound, so the wrapper below pins its clock to the
// window end and hides assistant lines stamped at or after it. A response whose lines straddle the
// window end is the only thing that can still differ (the reference then sees fewer of its lines).
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Report } from "@signalbox/core";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const days = opt("--days", 7);
const lagMinutes = opt("--lag-minutes", 10);
const TOLERANCE = 0.005;

const repo = resolve(import.meta.dir, "../../..");
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const untilMs = Math.floor((Date.now() - lagMinutes * 60_000) / 1000) * 1000;
const until = new Date(untilMs);
const since = new Date(untilMs - days * 86_400_000);

const wrapper = `
import sys, json, types, datetime as real
sys.path.insert(0, sys.argv[1])
import cc_cost
END = real.datetime.fromtimestamp(float(sys.argv[2]) / 1000.0, real.timezone.utc)
class FixedDT(real.datetime):
    @classmethod
    def now(cls, tz=None): return END if tz is None else END.astimezone(tz)
cc_cost.dt = types.SimpleNamespace(datetime=FixedDT, timedelta=real.timedelta, timezone=real.timezone)
def loads_before_end(s, *a, **k):
    d = json.loads(s, *a, **k)
    ts = d.get('timestamp') if isinstance(d, dict) else None
    if isinstance(ts, str):
        try:
            if real.datetime.fromisoformat(ts.replace('Z', '+00:00')) >= END: return {}
        except ValueError: pass
    return d
cc_cost.json = types.SimpleNamespace(loads=loads_before_end, dumps=json.dumps)
sys.argv = ['cc_cost.py', '--json', '--days', sys.argv[3], '--root', sys.argv[4]]
cc_cost.main()
`;

async function run(cmd: string[]): Promise<{ text: string; ms: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited with ${code}`);
  return { text, ms: performance.now() - t0 };
}

const [refRun, oursRun] = await Promise.all([
  run(["python3", "-I", "-c", wrapper, join(repo, "research/cost"), String(untilMs), String(days), projectsDir]),
  run(["bun", "apps/cli/src/main.ts", "report", "--agent", "claude-code", "--json", "--since", since.toISOString(), "--until", until.toISOString()]),
]);
const ref = JSON.parse(refRun.text);
const ours = JSON.parse(oursRun.text) as Report;

const canonical = (m: string) => m.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
type Row = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; placeholders: number; usd: number };
const fromGroup = (g: Report["byModel"][number]): Row => ({
  responses: g.responses,
  input: g.tokens.input,
  output: g.tokens.output,
  cacheRead: g.tokens.cacheRead,
  cacheWrite: g.tokens.cacheWrite5m + g.tokens.cacheWrite1h,
  cacheWrite1h: g.tokens.cacheWrite1h,
  placeholders: g.placeholderResponses,
  usd: g.cost.total,
});
const merge = (rows: Map<string, Row>, key: string, r: Row) => {
  const prev = rows.get(key);
  if (!prev) return void rows.set(key, { ...r });
  for (const k of Object.keys(r) as Array<keyof Row>) prev[k] += r[k];
};
const oursByModel = new Map<string, Row>();
for (const g of ours.byModel) merge(oursByModel, canonical(g.key), fromGroup(g));
const oursByKind = new Map<string, Row>();
for (const g of ours.byKind) merge(oursByKind, g.key === "other" ? "main" : g.key, fromGroup(g));

const lines: string[] = [];
let failures = 0;
const check = (scope: string, field: string, theirs: number, mine: number, tol = 0) => {
  const diff = theirs === 0 ? (mine === 0 ? 0 : 1) : Math.abs(mine - theirs) / Math.abs(theirs);
  const ok = diff <= tol;
  if (!ok) failures++;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  lines.push(`${ok ? "  ok " : "  !! "}${scope.padEnd(22)}${field.padEnd(13)}${fmt(theirs).padStart(16)}${fmt(mine).padStart(16)}${`${(diff * 100).toFixed(3)}%`.padStart(10)}`);
};

const t = ref.totals;
const mine = ours.totals;
check("TOTAL", "responses", ref.unique_api_responses, mine.responses);
check("TOTAL", "input", t.input, mine.tokens.input);
check("TOTAL", "output", t.output_recorded, mine.tokens.output);
check("TOTAL", "cacheRead", t.cache_read, mine.tokens.cacheRead);
check("TOTAL", "cacheWrite", t.cache_write, mine.tokens.cacheWrite5m + mine.tokens.cacheWrite1h);
check("TOTAL", "cacheWrite1h", t.cache_write_1h, mine.tokens.cacheWrite1h);
check("TOTAL", "placeholders", t.placeholder_output_responses, mine.placeholderResponses);
check("TOTAL", "usd", t.usd_list_price, ours.estimate.recordedUsd, TOLERANCE);
for (const m of [...new Set([...Object.keys(ref.by_model), ...oursByModel.keys()])].sort()) {
  const r = ref.by_model[m] ?? {};
  const o = oursByModel.get(m) ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, placeholders: 0, usd: 0 };
  check(m, "responses", r.responses ?? 0, o.responses);
  check(m, "input", r.input ?? 0, o.input);
  check(m, "output", r.output_recorded ?? 0, o.output);
  check(m, "cacheRead", r.cache_read ?? 0, o.cacheRead);
  check(m, "cacheWrite", r.cache_write ?? 0, o.cacheWrite);
  check(m, "usd", r.usd ?? 0, o.usd, TOLERANCE);
}
for (const k of [...new Set([...Object.keys(ref.by_kind), ...oursByKind.keys()])].sort()) {
  const r = ref.by_kind[k] ?? {};
  const o = oursByKind.get(k);
  check(`kind:${k}`, "responses", r.responses ?? 0, o?.responses ?? 0);
  check(`kind:${k}`, "usd", r.usd ?? 0, o?.usd ?? 0, TOLERANCE);
}

console.log(`window ${since.toISOString()} -> ${until.toISOString()} (${days} days, ending ${lagMinutes} min ago)`);
console.log(`cc_cost.py ${refRun.ms.toFixed(0)} ms, signalbox report ${oursRun.ms.toFixed(0)} ms (both wall time, run in parallel)`);
console.log(`     ${"scope".padEnd(22)}${"field".padEnd(13)}${"cc_cost.py".padStart(16)}${"signalbox".padStart(16)}${"diff".padStart(10)}`);
console.log(lines.join("\n"));
const usdDiff = Math.abs(ours.estimate.recordedUsd - t.usd_list_price) / t.usd_list_price;
console.log(
  failures === 0
    ? `MATCH: tokens identical, recorded USD within ${(usdDiff * 100).toFixed(4)}% (tolerance ${TOLERANCE * 100}%)`
    : `MISMATCH: ${failures} fields differ`,
);
console.log(JSON.stringify({ window: { since: since.toISOString(), until: until.toISOString() }, signalboxUsd: ours.estimate.recordedUsd, referenceUsd: t.usd_list_price, diffPct: usdDiff * 100 }));
process.exit(failures === 0 ? 0 : 1);
