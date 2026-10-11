// Transcript → deduplicated UsageRecords (BRAINSTORM §6.2). Only usage fields are read;
// message content is never touched beyond JSON.parse of the line.
import { createHash } from "node:crypto";
import { SPLIT_CONTINUATION_FLAG, type RecordKind, type TokenCounts, type UsageRecord } from "../../core/src/index.ts";
import { badCount, count, isObj, num, str, type Obj } from "./util.ts";

export interface UsageStats {
  files: number;
  assistantLines: number;
  responses: number;
  requestKeys: number;
  hashKeys: number;
  /** Lines whose input/cache/model differ from the first line of the same response. Expected 0. */
  inputMismatches: number;
  /** Same dedup key in a second file; the later copy is dropped. Expected 0. */
  crossFileDuplicates: number;
  /** Responses split per `usage.iterations[]` entry (multi-iteration or other-model iterations). */
  iterationSplits: number;
  syntheticDropped: number;
  apiErrorDropped: number;
  parseErrors: number;
  /** Files that vanished or failed to read mid-scan; their records are skipped. */
  readErrors: number;
  /** Assistant lines with a token count that is not a plausible whole number; that field counts as 0. */
  invalidCounts: number;
}

export function emptyUsageStats(): UsageStats {
  return {
    files: 0,
    assistantLines: 0,
    responses: 0,
    requestKeys: 0,
    hashKeys: 0,
    inputMismatches: 0,
    crossFileDuplicates: 0,
    iterationSplits: 0,
    syntheticDropped: 0,
    apiErrorDropped: 0,
    parseErrors: 0,
    readErrors: 0,
    invalidCounts: 0,
  };
}

/** Human-readable data-loss notes for a scan's counters; empty when nothing was lost. */
export function scanIssues(s: UsageStats): string[] {
  const out: string[] = [];
  const n = (x: number, one: string, many: string) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
  if (s.readErrors > 0) {
    out.push(`${n(s.readErrors, "transcript", "transcripts")} could not be read (e.g. permission denied), so ${s.readErrors === 1 ? "its" : "their"} usage is missing`);
  }
  if (s.parseErrors > 0) {
    out.push(`${n(s.parseErrors, "transcript line", "transcript lines")} could not be parsed (truncated, corrupted or still being written), so any usage on ${s.parseErrors === 1 ? "it" : "them"} is missing`);
  }
  if (s.invalidCounts > 0) {
    out.push(`${n(s.invalidCounts, "response line has", "response lines have")} a token count that is not a plausible whole number; those counts are taken as 0`);
  }
  return out;
}

const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

function hasBadCount(u: Obj): boolean {
  if (TOKEN_FIELDS.some((f) => badCount(u[f]))) return true;
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
  return cc !== undefined && (badCount(cc.ephemeral_5m_input_tokens) || badCount(cc.ephemeral_1h_input_tokens));
}

/**
 * Lines of one streamed response with no message or request id are merged when they share the
 * stable fields (session, agent, model, prompt token counts) and arrive within this gap.
 */
const HASH_MERGE_GAP_MS = 10 * 60_000;

export interface FileContext {
  path: string;
  kind: RecordKind;
  sessionId: string;
}

interface Acc {
  key: string;
  keyQuality: UsageRecord["keyQuality"];
  sessionId: string;
  project?: string;
  model: string;
  tsMs: number;
  /** Latest line time, for merging hash-keyed lines. */
  lastTsMs: number;
  usage: Obj;
  final: boolean;
  signature: string;
}

/**
 * Cache-write split. Uses usage.cache_creation.ephemeral_{5m,1h}_input_tokens when present; any
 * remainder of cache_creation_input_tokens (or the whole amount when the split is absent) goes to
 * 1h for main sessions and 5m otherwise (BRAINSTORM §6.3/§6.5).
 */
export function tokensOf(u: Obj, kind: RecordKind): TokenCounts {
  const total = count(u.cache_creation_input_tokens);
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
  const e5 = num(cc?.ephemeral_5m_input_tokens);
  const e1 = num(cc?.ephemeral_1h_input_tokens);
  let w5 = 0;
  let w1 = 0;
  let rest = total;
  if (e5 !== undefined || e1 !== undefined) {
    w5 = count(e5);
    w1 = count(e1);
    rest = Math.max(total - w5 - w1, 0);
  }
  if (kind === "main") w1 += rest;
  else w5 += rest;
  const tokens: TokenCounts = {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  };
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : undefined;
  const reasoning = num(details?.thinking_tokens);
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  return tokens;
}

function webSearches(u: Obj): number {
  return isObj(u.server_tool_use) ? count(u.server_tool_use.web_search_requests) : 0;
}

function speedOf(u: Obj): UsageRecord["speed"] {
  return u.speed === "fast" || u.speed === "standard" ? u.speed : undefined;
}

function hashKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** Collects one file's assistant lines and merges them per API response. */
export class UsageAccumulator {
  private readonly byKey = new Map<string, Acc>();
  /** Hash base -> the key of the latest response with that base. */
  private readonly hashLatest = new Map<string, string>();
  private hashSeq = 0;

  constructor(
    private readonly file: FileContext,
    private readonly stats: UsageStats,
  ) {}

  addLine(line: string): void {
    // Cheap prefilter: every assistant line contains this token; most other lines don't.
    if (!line.includes('"assistant"')) return;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      this.stats.parseErrors++; // usually the partial last line of a live file
      return;
    }
    this.addObject(d);
  }

  addObject(d: unknown): void {
    if (!isObj(d) || d.type !== "assistant") return;
    const m = isObj(d.message) ? d.message : undefined;
    if (!m) return;
    const model = str(m.model);
    if (!model) return;
    if (model === "<synthetic>") {
      this.stats.syntheticDropped++;
      return;
    }
    if (d.isApiErrorMessage === true) {
      this.stats.apiErrorDropped++;
      return;
    }
    const u = isObj(m.usage) ? m.usage : undefined;
    if (!u) return;
    const tsMs = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (Number.isNaN(tsMs)) return;
    this.stats.assistantLines++;
    if (hasBadCount(u)) this.stats.invalidCounts++;

    const sessionId = str(d.sessionId) ?? this.file.sessionId;
    let key: string;
    let keyQuality: UsageRecord["keyQuality"];
    const msgId = str(m.id);
    const reqId = str(d.requestId);
    if (msgId) {
      key = msgId;
      keyQuality = "id";
    } else if (reqId) {
      key = `req:${reqId}`;
      keyQuality = "request";
    } else {
      // Only fields that stay the same across one response's lines: the timestamp and output_tokens
      // change from one content-block line to the next.
      const base = hashKey([
        sessionId,
        str(d.agentId) ?? null,
        model,
        u.input_tokens ?? null,
        u.cache_read_input_tokens ?? null,
        u.cache_creation_input_tokens ?? null,
      ]);
      const latest = this.hashLatest.get(base);
      const prevAcc = latest ? this.byKey.get(latest) : undefined;
      if (latest && prevAcc && Math.abs(tsMs - prevAcc.lastTsMs) <= HASH_MERGE_GAP_MS) {
        key = latest;
      } else {
        key = latest ? `hash:${base}:${++this.hashSeq}` : `hash:${base}`;
        this.hashLatest.set(base, key);
      }
      keyQuality = "hash";
    }

    const signature = JSON.stringify([
      model,
      u.input_tokens ?? null,
      u.cache_read_input_tokens ?? null,
      u.cache_creation_input_tokens ?? null,
    ]);
    const hasStop = m.stop_reason !== null && m.stop_reason !== undefined;
    const prev = this.byKey.get(key);
    if (!prev) {
      const acc: Acc = { key, keyQuality, sessionId, model, tsMs, lastTsMs: tsMs, usage: u, final: hasStop, signature };
      const project = str(d.cwd);
      if (project) acc.project = project;
      this.byKey.set(key, acc);
      return;
    }
    if (signature !== prev.signature) this.stats.inputMismatches++;
    if (tsMs < prev.tsMs) prev.tsMs = tsMs;
    if (tsMs > prev.lastTsMs) prev.lastTsMs = tsMs;
    // Streaming writes one line per content block; output_tokens only grows. Ties take the later line.
    if (count(u.output_tokens) >= count(prev.usage.output_tokens)) prev.usage = u;
    if (hasStop) prev.final = true;
    if (!prev.project) {
      const project = str(d.cwd);
      if (project) prev.project = project;
    }
  }

  /**
   * One entry per API response, keyed by its dedup key. `records` usually holds one record; see
   * `toRecords` for the iterations[] exception.
   */
  responses(): Array<{ key: string; records: UsageRecord[] }> {
    const out: Array<{ key: string; records: UsageRecord[] }> = [];
    for (const acc of this.byKey.values()) {
      if (acc.keyQuality === "request") this.stats.requestKeys++;
      if (acc.keyQuality === "hash") this.stats.hashKeys++;
      out.push({ key: acc.key, records: this.toRecords(acc) });
    }
    return out;
  }

  private toRecords(acc: Acc): UsageRecord[] {
    const u = acc.usage;
    const kind = this.file.kind;
    const base = {
      agent: "claude-code" as const,
      keyQuality: acc.keyQuality,
      sessionId: acc.sessionId,
      kind,
      ts: new Date(acc.tsMs).toISOString(),
      outputFinal: acc.final,
      sourcePath: this.file.path,
    };
    const extra: Partial<UsageRecord> = {};
    if (acc.project) extra.project = acc.project;
    const geo = str(u.inference_geo);
    if (geo) extra.geo = geo;
    const speed = speedOf(u);
    if (speed) extra.speed = speed;

    // BRAINSTORM §6.2 item 6: iterations[] is never added on top of the top-level usage. Only when
    // there is more than one iteration, or one names a different model, is the response priced
    // per iteration instead (ids get a "#iter<n>" suffix so the split is visible). The response
    // still counts once: records after the first carry SPLIT_CONTINUATION_FLAG.
    const iters = Array.isArray(u.iterations) ? u.iterations.filter(isObj) : [];
    const otherModel = iters.some((it) => {
      const im = str(it.model);
      return im !== undefined && im !== acc.model;
    });
    if (iters.length > 1 || otherModel) {
      this.stats.iterationSplits++;
      return iters.map((it, i) => ({
        ...base,
        ...extra,
        id: `${acc.key}#iter${i}`,
        model: str(it.model) ?? acc.model,
        tokens: tokensOf(it, kind),
        webSearchRequests: i === 0 ? webSearches(u) : 0,
        flags: i === 0 ? ["iteration-split"] : ["iteration-split", SPLIT_CONTINUATION_FLAG],
      }));
    }
    return [{ ...base, ...extra, id: acc.key, model: acc.model, tokens: tokensOf(u, kind), webSearchRequests: webSearches(u) }];
  }
}
