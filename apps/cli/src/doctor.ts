// `signalbox doctor`: what Signalbox can see on this machine, and how much to trust it.
// It runs `<agent> --version` and, through the Claude Code adapter's health check, `claude agents
// --json --all` (argv, no shell, with a timeout; skipped when Claude Code's global config file is
// missing, because that command would create it). It never runs a slash command. Data paths are
// stat'ed, never opened, except through the adapters' own health checks.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  agree,
  clipId,
  countsAsResponse,
  embeddedModelTables,
  findPrice,
  plural,
  type AdapterHealth,
  type ModelTable,
  type PriceTable,
  type Stability,
} from "@signalbox/core";
import { calendarSince } from "./args.ts";
import { envForBinary, findBinary } from "./binaries.ts";
import { noDataMessage, type SignalboxData } from "./data.ts";
import { fmtInt, fmtLocal, tildify, wrap } from "./format.ts";
import { OPEN_BITS } from "./private-dir.ts";
import { PLANNED, type AgentBinary, type LoadedAdapter } from "./registry.ts";

const VERSION_TIMEOUT_MS = 5000;
const USAGE_DAYS = 30;
const STALE_PRICES_DAYS = 45;
const SPOOL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export interface BinaryInfo {
  name: string;
  path?: string;
  /** Where the path came from: an override variable's name, "PATH", or the fallback directory it was found in. */
  via?: string;
  version?: string;
  error?: string;
}

export interface DoctorReport {
  signalbox: { version: string; bun: string; platform: string };
  agents: Array<{ id: string; displayName: string; adapter: boolean; detected?: boolean; binary?: BinaryInfo; doc?: string }>;
  dataDirs: Array<{ agent: string; label: string; path: string; exists: boolean }>;
  sources: Array<AdapterHealth & { agent: string }>;
  pricing: Array<{ provider: string; asOf: string; ageDays?: number; rows: number; sourceUrl: string }>;
  /** Context-window tables (models/*.json) and the agent behaviour they record. */
  models: Array<{ provider: string; asOf: string; ageDays?: number; rows: number; sourceUrl: string; observed: Array<{ agent: string; stability: Stability; observedIn: string }> }>;
  spool?: { path: string; exists: boolean; mode?: string; files?: number; newestAt?: string };
  usage: Array<{ agent: string; days: number; responses: number; models: number; unpriced: Record<string, number>; hashKeyed: number; scanMs: number; error?: string }>;
  warnings: string[];
}

export async function agentVersion(bin: AgentBinary, env: Record<string, string | undefined> = process.env, home?: string): Promise<BinaryInfo> {
  const info: BinaryInfo = { name: bin.name };
  const found = findBinary(bin.name, { envVar: bin.envVar, env, home });
  if (!found) {
    info.error = `not found on PATH or in the usual install dirs${bin.envVar ? ` (or set ${bin.envVar})` : ""}`;
    return info;
  }
  const { path } = found;
  info.path = path;
  info.via = found.via;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([path, ...bin.versionArgs], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: envForBinary(path, env) });
  } catch (err) {
    info.error = `could not run (${err instanceof Error ? err.message : String(err)})`;
    return info;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), VERSION_TIMEOUT_MS)));
  try {
    const res = await Promise.race([Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]), timeout]);
    if (res === "timeout") {
      proc.kill();
      info.error = `--version timed out after ${VERSION_TIMEOUT_MS} ms`;
    } else if (res[1] !== 0) {
      info.error = `--version exited with code ${res[1]}`;
    } else {
      const first = res[0].split("\n").find((l) => l.trim())?.trim();
      if (first) info.version = first.slice(0, 80);
      else info.error = "--version printed nothing";
    }
  } finally {
    clearTimeout(timer);
  }
  return info;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Spool directory status from stat() and file names only; the adapter's health check parses the files. */
async function spoolStatus(path: string): Promise<NonNullable<DoctorReport["spool"]>> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return { path, exists: false };
  }
  const out: NonNullable<DoctorReport["spool"]> = { path, exists: true, mode: (st.mode & 0o777).toString(8).padStart(4, "0") };
  try {
    const names = (await readdir(path)).filter((n) => SPOOL_FILE.test(n) && !n.startsWith("spike-results-"));
    out.files = names.length;
    let newest = 0;
    for (const n of names) {
      try {
        newest = Math.max(newest, (await stat(`${path}/${n}`)).mtimeMs);
      } catch {
        // vanished between readdir and stat
      }
    }
    if (newest > 0) out.newestAt = new Date(newest).toISOString();
  } catch {
    // unreadable dir: mode says why
  }
  return out;
}

/** True when group or others can get into the spool directory. */
function spoolIsOpen(s: NonNullable<DoctorReport["spool"]>): boolean {
  return s.exists && s.mode !== undefined && (Number.parseInt(s.mode, 8) & OPEN_BITS) !== 0;
}

function ageDays(asOf: string, now: Date): number | undefined {
  const t = Date.parse(`${asOf}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.floor((now.getTime() - t) / 86_400_000);
}

export async function runDoctor(opts: {
  data: SignalboxData;
  adapters: LoadedAdapter[];
  tables: PriceTable[];
  /** Default: the embedded models/*.json. */
  modelTables?: ModelTable[];
  version: string;
  now?: Date;
}): Promise<DoctorReport> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const [versions, planned, detected, health] = await Promise.all([
    Promise.all(opts.adapters.map((la) => (la.entry.bin ? agentVersion(la.entry.bin) : Promise.resolve(undefined)))),
    Promise.all(PLANNED.map((p) => agentVersion(p.bin))),
    Promise.all(opts.adapters.map((la) => la.adapter.detect().catch(() => false))),
    Promise.all(
      opts.adapters.map(async (la) => {
        try {
          return (await la.adapter.health()).map((h) => ({ ...h, agent: la.adapter.id }));
        } catch (err) {
          const detail = `health() failed (${err instanceof Error ? err.message : String(err)})`;
          return [{ agent: la.adapter.id, name: `${la.adapter.id}:health`, stability: "internal" as Stability, ok: false, detail }];
        }
      }),
    ),
  ]);

  const agents: DoctorReport["agents"] = opts.adapters.map((la, i) => {
    const a: DoctorReport["agents"][number] = { id: la.adapter.id, displayName: la.entry.displayName, adapter: true, detected: detected[i] };
    const v = versions[i];
    if (v) a.binary = v;
    return a;
  });
  PLANNED.forEach((p, i) => {
    const v = planned[i]!;
    agents.push({ id: p.id, displayName: p.displayName, adapter: false, binary: v, doc: p.doc });
    if (v.path) warnings.push(`${p.displayName} is installed (${tildify(v.path)}), but Signalbox has no adapter for it yet; see ${p.doc}.`);
  });
  if (opts.adapters.length > 0 && !detected.some(Boolean)) warnings.unshift(noDataMessage(opts.adapters));

  const dataDirs: DoctorReport["dataDirs"] = [];
  for (const la of opts.adapters) {
    for (const d of la.entry.dataDirs(la.adapter)) {
      dataDirs.push({ agent: la.adapter.id, label: d.label, path: d.path, exists: await exists(d.path) });
    }
  }

  // Usage over the last 30 calendar days: response counts, unpriced models and hash-keyed rows.
  const since = calendarSince(USAGE_DAYS, now);
  const usage: DoctorReport["usage"] = [];
  for (const [i, la] of opts.adapters.entries()) {
    if (!detected[i]) continue;
    const scan = await opts.data.scan(la, since, now);
    const unpriced: Record<string, number> = {};
    const models = new Set<string>();
    let responses = 0;
    let hashKeyed = 0;
    for (const r of scan.records) {
      const t = Date.parse(r.ts);
      if (t < since.getTime() || t >= now.getTime()) continue;
      models.add(r.model);
      if (!countsAsResponse(r)) continue;
      responses++;
      if (r.keyQuality === "hash") hashKeyed++;
      if (!findPrice(r.model, opts.tables)) unpriced[r.model] = (unpriced[r.model] ?? 0) + 1;
    }
    const row: DoctorReport["usage"][number] = { agent: la.adapter.id, days: USAGE_DAYS, responses, models: models.size, unpriced, hashKeyed, scanMs: scan.ms };
    if (scan.error) row.error = scan.error;
    usage.push(row);
    const up = Object.entries(unpriced).sort((a, b) => b[1] - a[1]);
    if (up.length) {
      warnings.push(
        `${la.entry.displayName}: ${up.map(([m, n]) => `${clipId(m)} (${plural(n, "response")})`).join(", ")} ${up.length === 1 ? "has" : "have"} no list price and ${up.length === 1 ? "is" : "are"} counted at $0.`,
      );
    }
    if (hashKeyed) {
      warnings.push(
        `${la.entry.displayName}: ${plural(hashKeyed, "response")} ${agree(hashKeyed, "has", "have")} no message or request id (hash dedup key): possible double counting.`,
      );
    }
    if (scan.error) warnings.push(`${la.entry.displayName}: ${scan.error}.`);
    for (const issue of scan.issues) warnings.push(`${la.entry.displayName}: ${issue}.`);
  }

  const pricing = opts.tables.map((t) => {
    const age = ageDays(t.asOf, now);
    if (age !== undefined && age > STALE_PRICES_DAYS) warnings.push(`pricing/${t.provider}.json is ${age} days old (as of ${t.asOf}); re-check ${t.sourceUrl}.`);
    const p: DoctorReport["pricing"][number] = { provider: t.provider, asOf: t.asOf, rows: Object.keys(t.models).length, sourceUrl: t.sourceUrl };
    if (age !== undefined) p.ageDays = age;
    return p;
  });

  const models = (opts.modelTables ?? embeddedModelTables()).map((t) => {
    const age = ageDays(t.asOf, now);
    const m: DoctorReport["models"][number] = {
      provider: t.provider,
      asOf: t.asOf,
      rows: Object.keys(t.models).length,
      sourceUrl: t.sourceUrl,
      observed: Object.entries(t.agents ?? {}).map(([agent, n]) => ({ agent, stability: n.stability, observedIn: n.observedIn })),
    };
    if (age !== undefined) m.ageDays = age;
    return m;
  });

  let spool: DoctorReport["spool"];
  for (const la of opts.adapters) {
    const dir = la.entry.spoolDir?.(la.adapter);
    if (dir) spool = await spoolStatus(dir);
  }
  if (spool && (!spool.exists || spool.files === 0)) {
    warnings.push("The signalbox-tap mod has not written a spool yet: plan limits read \"unknown\" and context is estimated from transcripts. See docs/SPIKE.md.");
  }
  if (spool && spoolIsOpen(spool)) {
    warnings.push(`The spool directory is mode ${spool.mode}; it should be 0700 (\`signalbox serve\` fixes it, or chmod 700 "${spool.path}").`);
  }

  for (const [i, la] of opts.adapters.entries()) {
    if (!detected[i]) continue;
    const v = versions[i];
    const binMissing = !!v?.error && !v.path;
    if (v?.error && la.entry.bin) {
      warnings.push(`${la.entry.displayName} data exists, but its CLI (${la.entry.bin.name}) ${binMissing ? "was " : ""}${v.error}.`);
    }
    for (const h of health[i]!) {
      if (h.ok || h.name.endsWith(":spool")) continue;
      // One cause, one warning: a missing binary already explains why agents --json failed.
      if (binMissing && h.name.endsWith(":agents-json")) continue;
      warnings.push(`${h.name} is not working: ${h.detail}`);
    }
  }

  return {
    signalbox: { version: opts.version, bun: Bun.version, platform: `${process.platform} ${process.arch}` },
    agents,
    dataDirs,
    sources: health.flat(),
    pricing,
    models,
    ...(spool ? { spool } : {}),
    usage,
    warnings,
  };
}

/** How a binary was found, for the doctor's Agents table. */
export function binarySource(via: string | undefined): string {
  if (!via) return "";
  if (via === "PATH") return "(on PATH)";
  if (via.startsWith("/")) return `(not on PATH; found in ${tildify(via)})`;
  return `(from $${via})`;
}

export function formatDoctor(d: DoctorReport, width = 100): string {
  const w = Math.max(72, Math.min(width, 140));
  const out: string[] = [];
  out.push(`Signalbox doctor  v${d.signalbox.version}  (bun ${d.signalbox.bun}, ${d.signalbox.platform})`);
  out.push("Read-only: this ran `<agent> --version`, `claude agents --json --all` (only when Claude Code's config file exists) and the adapters' own health checks.");

  out.push("", "Agents");
  for (const a of d.agents) {
    const b = a.binary;
    const bin = b ? (b.path ? `${b.version ?? "version unknown"}  ${tildify(b.path)}  ${binarySource(b.via)}` : `${b.name}: ${b.error}`) : "";
    const state = a.adapter ? (a.detected ? "data found" : "no data") : "no adapter yet";
    out.push(`  ${a.displayName.padEnd(12)} ${state.padEnd(15)} ${bin}`);
  }

  out.push("", "Data");
  for (const dd of d.dataDirs) {
    out.push(`  ${dd.agent.padEnd(12)} ${dd.label.padEnd(14)} ${dd.exists ? "ok     " : "missing"}  ${tildify(dd.path)}`);
  }
  if (d.spool) {
    const s = d.spool;
    const state = s.exists
      ? `mode ${s.mode}, ${s.files ?? 0} spool files${s.newestAt ? `, newest ${fmtLocal(s.newestAt)}` : ""}`
      : "missing (signalbox-tap not loaded yet)";
    const label = !s.exists ? "missing" : spoolIsOpen(s) ? "OPEN   " : "ok     ";
    out.push(`  ${"tap".padEnd(12)} ${"spool".padEnd(14)} ${label}  ${tildify(s.path)}  ${s.exists ? state : ""}`.trimEnd());
  }

  out.push("", "Sources  (stability: documented > preview > internal; internal formats can change in any release)");
  for (const s of d.sources) {
    const head = `  ${s.ok ? "ok  " : "FAIL"}  ${`[${s.stability}]`.padEnd(12)} ${s.name.padEnd(26)} `;
    const home = homedir();
    const detail = home ? s.detail.split(home).join("~") : s.detail;
    out.push(wrap(head, detail, w));
  }

  out.push("", "Price tables");
  for (const p of d.pricing) {
    out.push(`  ${p.provider.padEnd(12)} as of ${p.asOf}${p.ageDays !== undefined ? ` (${p.ageDays} days old)` : ""}, ${p.rows} rows  ${p.sourceUrl}`);
  }

  out.push("", "Context windows");
  for (const m of d.models) {
    out.push(`  ${m.provider.padEnd(12)} as of ${m.asOf}${m.ageDays !== undefined ? ` (${m.ageDays} days old)` : ""}, ${m.rows} rows  ${m.sourceUrl}`);
    for (const o of m.observed) out.push(`  ${"".padEnd(12)} [${o.stability}] ${o.agent}: auto-compact point and id suffixes observed in ${o.observedIn}`);
  }

  if (d.usage.length) {
    out.push("", `Usage seen (last ${d.usage[0]!.days} calendar days)`);
    for (const u of d.usage) {
      const unpriced = Object.entries(u.unpriced);
      out.push(
        `  ${u.agent.padEnd(12)} ${fmtInt(u.responses).padStart(7)} ${u.responses === 1 ? "response" : "responses"}, ${plural(u.models, "model")}, ${unpriced.length ? `${unpriced.length} unpriced` : "all priced"}, ${u.hashKeyed} hash-keyed  (scan ${u.scanMs} ms)`,
      );
    }
  }

  out.push("", d.warnings.length ? "Warnings" : "Warnings: none");
  for (const x of d.warnings) out.push(wrap("  - ", x, w));
  return out.join("\n");
}

