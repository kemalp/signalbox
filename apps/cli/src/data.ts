// Wires adapters to core: scans (cached, so the page's polling doesn't rescan), reports, fleet and
// health. No formatting here; `main.ts` prints and `serve` hands these to the web server.
import {
  buildHistory,
  buildReport,
  DEFAULT_HISTORY_LIMIT,
  priceRecord,
  processedTokens,
  type AdapterHealth,
  type CompactionEvent,
  type ContextSnapshot,
  type FleetSession,
  type FleetSnapshot,
  type HistorySession,
  type HistorySnapshot,
  type LedgerEntry,
  type LimitSnapshot,
  type PriceTable,
  type Report,
  type SessionInfo,
  type UsageRecord,
} from "@signalbox/core";
import type { FleetSessionExtras } from "@signalbox/web";
import { calendarSince } from "./args.ts";
import { tildify } from "./format.ts";
import type { AppListSource, LoadedAdapter } from "./registry.ts";

export interface AdapterScan {
  agent: string;
  records: UsageRecord[];
  ledger: LedgerEntry[];
  since: Date;
  /** Exclusive end actually scanned: the requested `until`, or the time the scan started. */
  until: Date;
  ms: number;
  /** Set when the scan or ledger read failed; the records then hold whatever was read. */
  error?: string;
  /** Data the scan skipped (unreadable files, unparsable lines), as sentences. */
  issues: string[];
}

export interface ReportRequest {
  since: Date;
  /** Exclusive. Omitted means "now", and the scan may be reused for `ttlMs`. */
  until?: Date;
  agent?: string;
}

export interface HistoryRequest {
  /** Sessions with activity at or after this time; omitted means every session. */
  since?: Date;
  /** Exclusive: sessions that started before this time. */
  until?: Date;
  agent?: string;
  /** Default DEFAULT_HISTORY_LIMIT. */
  limit?: number;
}

export interface DataOptions {
  adapters: LoadedAdapter[];
  tables: PriceTable[];
  /** How long scans, compactions and detect() results are reused. Default 30 s. */
  ttlMs?: number;
  /** How long health() is reused. Default: `ttlMs`. */
  healthTtlMs?: number;
  now?: () => Date;
  /** IANA zone for byDay. Default: the system zone. */
  timeZone?: string;
  /** Session $ on fleet cards comes from a whole-session scan of this many calendar days. Default 7. */
  fleetDays?: number;
}

interface SessionCost {
  usd: number;
  /** Records with a price row. */
  priced: number;
  /** Tokens on records whose model has no price row (counted at $0). */
  unpricedTokens: number;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
  settled: boolean;
}

/** Per-call freshness. A cached value still being computed is always reused, whatever its age. */
export interface Freshness {
  /** Reuse a cached value only if it was started at most this long ago. Default: the cache's TTL. */
  maxAgeMs?: number;
}

/** Per-call fleet options. */
export interface FleetOptions {
  /**
   * A status push between regular fleets: sessions come from cheap local reads (no `claude agents
   * --json` run) and health is the last reading, whatever its age.
   */
  quick?: boolean;
}

/** Fleet compactions cover this many calendar days (today and the 6 before), like the report windows. */
const FLEET_COMPACTION_DAYS = 7;

export class SignalboxData {
  readonly tables: PriceTable[];
  private readonly adapters: LoadedAdapter[];
  private readonly ttlMs: number;
  private readonly healthTtlMs: number;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly fleetDays: number;
  private readonly cache = new Map<string, Cached<unknown>>();
  private lastHealth?: AdapterHealth[];
  private lastFleetSessions?: SessionInfo[];
  private readonly sessionCost = new WeakMap<AdapterScan, Map<string, SessionCost>>();

  constructor(opts: DataOptions) {
    this.adapters = opts.adapters;
    this.tables = opts.tables;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.healthTtlMs = opts.healthTtlMs ?? this.ttlMs;
    this.now = opts.now ?? (() => new Date());
    this.timeZone = opts.timeZone;
    this.fleetDays = opts.fleetDays ?? 7;
  }

  /**
   * Reuses a value for `maxAgeMs` (default `ttlMs`), and an in-flight promise even past that, so a
   * forced refresh never starts a second copy of a running scan. Nothing is kept past the longest TTL
   * (a hung read then gets a fresh attempt). Failed promises are not kept.
   */
  private cached<T>(key: string, make: () => Promise<T>, maxAgeMs = this.ttlMs): Promise<T> {
    const t = Date.now();
    const keep = Math.max(this.ttlMs, this.healthTtlMs);
    for (const [k, c] of this.cache) if (t - c.at >= keep) this.cache.delete(k);
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && (!hit.settled || t - hit.at < maxAgeMs)) return hit.value;
    const entry: Cached<T> = { at: t, value: make(), settled: false };
    this.cache.set(key, entry);
    entry.value.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return entry.value;
  }

  /** Adapters whose agent has data on this machine (detect() is cached like everything else). */
  async detected(agent?: string): Promise<LoadedAdapter[]> {
    const list = this.adapters.filter((a) => !agent || a.adapter.id === agent);
    const found = await Promise.all(list.map((a) => this.cached(`detect|${a.adapter.id}`, () => a.adapter.detect().catch(() => false))));
    return list.filter((_, i) => found[i]);
  }

  /**
   * Every record of every session with activity in [since, until) (wholeSessions), plus the ledger
   * for the range. buildReport filters totals to the range and reconciles whole sessions.
   */
  scan(la: LoadedAdapter, since: Date, until?: Date, fresh: Freshness = {}): Promise<AdapterScan> {
    const key = `scan|${la.adapter.id}|${since.toISOString()}|${until?.toISOString() ?? "now"}`;
    return this.cached(key, async () => {
      const end = until ?? this.now();
      const started = performance.now();
      const out: AdapterScan = { agent: la.adapter.id, records: [], ledger: [], since, until: end, ms: 0, issues: [] };
      const errors: string[] = [];
      try {
        for await (const r of la.adapter.scanUsage({ since, until: end, wholeSessions: true })) out.records.push(r);
        out.issues = la.entry.scanIssues?.(la.adapter) ?? [];
      } catch (err) {
        errors.push(`usage scan failed (${message(err)})`);
      }
      if (la.adapter.readLedger) {
        try {
          out.ledger = await la.adapter.readLedger({ since, until: end });
        } catch (err) {
          errors.push(`ledger read failed (${message(err)})`);
        }
      }
      if (errors.length) out.error = errors.join("; ");
      out.ms = Math.round(performance.now() - started);
      return out;
    }, fresh.maxAgeMs);
  }

  async report(req: ReportRequest, fresh: Freshness = {}): Promise<Report> {
    const adapters = await this.detected(req.agent);
    const scans = await Promise.all(adapters.map((a) => this.scan(a, req.since, req.until, fresh)));
    const until = req.until ?? (scans.length ? new Date(Math.min(...scans.map((s) => s.until.getTime()))) : this.now());
    const report = buildReport({
      records: scans.flatMap((s) => s.records),
      ledger: scans.flatMap((s) => s.ledger),
      tables: this.tables,
      since: req.since,
      until: until.getTime() > req.since.getTime() ? until : req.since,
      timeZone: this.timeZone,
      now: this.now(),
    });
    for (const s of scans) {
      if (s.error) report.notes.push(`${s.agent}: ${s.error}.`);
      for (const issue of s.issues) report.notes.push(`${s.agent}: ${issue}.`);
    }
    if (adapters.length === 0) report.notes.unshift(noDataMessage(this.adapters.filter((a) => !req.agent || a.adapter.id === req.agent), req.agent));
    return report;
  }

  health(fresh: Freshness = {}): Promise<AdapterHealth[]> {
    const value = this.cached("health", async () => {
      const per = await Promise.all(
        this.adapters.map(async ({ adapter }) => {
          try {
            return await adapter.health();
          } catch (err) {
            return [{ name: `${adapter.id}:health`, stability: "internal", ok: false, detail: `health() failed (${message(err)})` } satisfies AdapterHealth];
          }
        }),
      );
      return per.flat();
    }, fresh.maxAgeMs ?? this.healthTtlMs);
    value.then((h) => (this.lastHealth = h), () => {});
    return value;
  }

  /**
   * Calls `onChange(agent)` when an adapter that can watch its sessions sees a possible status change.
   * Every adapter with `watchSessions` is followed, detected or not (a registry dir that appears later
   * counts). Returns a function that stops every watch.
   */
  watchSessions(onChange: (agent: string) => void): () => void {
    const stops: Array<() => void> = [];
    for (const { adapter } of this.adapters) {
      if (!adapter.watchSessions) continue;
      try {
        stops.push(adapter.watchSessions(() => onChange(adapter.id)));
      } catch {
        // no fast status for this agent; the regular fleet still covers it
      }
    }
    return () => {
      for (const stop of stops.splice(0)) stop();
    };
  }

  /**
   * Live and recent sessions, for the command guide's project scope: the last fleet's sessions when
   * there was one, else a listing from cheap local reads (`quick`, no `claude agents --json` run).
   * `full` lists afresh with every source, like a fleet (for one-shot commands).
   */
  async recentSessions(opts: { full?: boolean } = {}): Promise<SessionInfo[]> {
    if (!opts.full && this.lastFleetSessions) return this.lastFleetSessions;
    const adapters = await this.detected();
    const per = await Promise.all(adapters.map((la) => list<SessionInfo>(la.adapter.listSessions?.(opts.full ? undefined : { quick: true }))));
    return per.flat();
  }

  /**
   * Session history from every detected adapter that has one, priced and newest first. Adapters reuse their
   * per-file transcript caches, so a repeat call re-reads only the files that changed. `live` comes from the
   * last fleet's sessions, else from a quick listing (no `claude agents --json` run). One adapter failing
   * leaves its sessions out; all of them failing is an error.
   */
  history(req: HistoryRequest = {}, fresh: Freshness = {}): Promise<HistorySnapshot> {
    const limit = req.limit ?? DEFAULT_HISTORY_LIMIT;
    const key = `history|${req.agent ?? "*"}|${req.since?.toISOString() ?? "all"}|${req.until?.toISOString() ?? "now"}|${limit}`;
    return this.cached(key, async () => {
      const adapters = (await this.detected(req.agent)).filter((la) => la.adapter.listHistory);
      const errors: string[] = [];
      const per = await Promise.all(
        adapters.map(async (la): Promise<HistorySession[]> => {
          try {
            return await la.adapter.listHistory!({ since: req.since, until: req.until });
          } catch (err) {
            errors.push(`${la.adapter.id}: ${message(err)}`);
            return [];
          }
        }),
      );
      if (adapters.length > 0 && errors.length === adapters.length) throw new Error(`history failed (${errors.join("; ")})`);
      const live = await this.recentSessions().catch(() => [] as SessionInfo[]);
      // The Claude app's list, when an adapter folded it in (or was told not to).
      let claudeApp: AppListSource | undefined;
      for (const la of adapters) claudeApp ??= la.entry.claudeApp?.(la.adapter);
      return buildHistory({ sessions: per.flat(), tables: this.tables, live, since: req.since, until: req.until, limit, now: this.now(), claudeApp });
    }, fresh.maxAgeMs);
  }

  private compactions(la: LoadedAdapter, fresh: Freshness): Promise<CompactionEvent[]> {
    return this.cached(`compactions|${la.adapter.id}`, async () => {
      if (!la.adapter.readCompactions) return [];
      const now = this.now();
      return la.adapter.readCompactions({ since: calendarSince(FLEET_COMPACTION_DAYS, now), until: now });
    }, fresh.maxAgeMs);
  }

  /** Transcript-priced $ per session over a whole-session scan, computed once per scan. */
  private costs(scan: AdapterScan): Map<string, SessionCost> {
    let m = this.sessionCost.get(scan);
    if (!m) {
      m = new Map();
      for (const r of scan.records) {
        let c = m.get(r.sessionId);
        if (!c) m.set(r.sessionId, (c = { usd: 0, priced: 0, unpricedTokens: 0 }));
        const pr = priceRecord(r, this.tables);
        c.usd += pr.cost.total;
        if (pr.priced) c.priced++;
        else c.unpricedTokens += processedTokens(r.tokens);
      }
      this.sessionCost.set(scan, m);
    }
    return m;
  }

  /**
   * Sessions, limits and context are read on every call; session $ and compactions come from cached
   * transcript reads (see `fresh`), and `health` from the health cache. See FleetOptions for `quick`.
   */
  async fleet(fresh: Freshness = {}, opts: FleetOptions = {}): Promise<FleetSnapshot> {
    const now = this.now();
    const adapters = await this.detected();
    const fleetSince = calendarSince(this.fleetDays, now);
    const per = await Promise.all(
      adapters.map(async (la) => {
        const a = la.adapter;
        const [sessions, contexts, limits, compactions, scan] = await Promise.all([
          list<SessionInfo>(a.listSessions?.(opts.quick ? { quick: true } : undefined)),
          list<ContextSnapshot>(a.readContext?.()),
          list<LimitSnapshot>(a.readLimits?.()),
          list(this.compactions(la, fresh)),
          maybe(this.scan(la, fleetSince, undefined, fresh)),
        ]);
        const ctx = new Map(contexts.map((c) => [c.sessionId, c]));
        const cost = scan ? this.costs(scan) : undefined;
        const out: FleetSession[] = sessions.map((s) => {
          const f: FleetSession & FleetSessionExtras = { ...s };
          const c = ctx.get(s.sessionId);
          if (c) f.context = c;
          const sc = cost?.get(s.sessionId);
          // A session whose every record is unpriced has an unknown cost, not $0.
          if (sc && sc.priced > 0) f.costUsd = sc.usd;
          if (sc && sc.unpricedTokens > 0) f.unpricedTokens = sc.unpricedTokens;
          return f;
        });
        return { sessions: out, limits, compactions };
      }),
    );
    const sessions = per.flatMap((p) => p.sessions);
    this.lastFleetSessions = sessions;
    return {
      generatedAt: now.toISOString(),
      sessions,
      limits: per.flatMap((p) => p.limits),
      compactions: per.flatMap((p) => p.compactions).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
      health: (opts.quick ? this.lastHealth : undefined) ?? (await this.health()),
    };
  }
}

// Optional adapter methods may be missing or fail; the fleet view then shows less, not an error.
async function list<T>(p: Promise<T[]> | undefined): Promise<T[]> {
  try {
    return (await p) ?? [];
  } catch {
    return [];
  }
}

async function maybe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

/**
 * Says where Signalbox looked when no agent data was found, so an empty report reads as "unknown"
 * (e.g. a mistyped CLAUDE_CONFIG_DIR) rather than as $0 of usage.
 */
export function noDataMessage(adapters: LoadedAdapter[], agent?: string): string {
  const looked = adapters.map((la) => {
    const home = la.entry.dataDirs(la.adapter)[0];
    return `${la.entry.displayName} in ${home ? tildify(home.path) : "its default location"}${la.entry.homeEnv ? ` (set ${la.entry.homeEnv} to change it)` : ""}`;
  });
  const what = agent ? `No ${agent} data was found on this machine` : "No agent data was found on this machine";
  return `${what}${looked.length ? `; looked for ${looked.join(" and ")}` : ""}. This is unknown, not $0 of usage: run \`signalbox doctor\` for details.`;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
