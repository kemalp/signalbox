// One DeepSeek Harness session log, folded line by line into what Signalbox reads from it: usage records, the
// turn and approval state, the context size, compactions and the session's title. The log is an event stream
// ({"type","seq","time","data"} after a header line), so the fold can stop anywhere and carry on when the log
// grows. A line is JSON-parsed only when its prefix names one of the event types below; user, system and tool
// lines (the content) are passed over as text and never parsed.
import { promptTokens, sanitizeTitle, type CompactionEvent, type RecordKind, type TokenCounts, type UsageRecord } from "@signalbox/core";
import { count, iso, isObj, isZeroUsage, label, lastUsageChunk, msTime, normalizeUsage, pathField, str, type Json } from "./normalize.ts";

export const AGENT = "deepseek-harness";

/** The log generation (`session.v4.jsonl`) this reader was checked against, written by DeepSeek Harness 0.2.2-rc.1. */
export const CHECKED_GENERATION = 4;

export interface LogHeader {
  id?: string;
  /** The log format generation. */
  version?: number;
  cwd?: string;
  /** ISO. */
  createdAt?: string;
  /** The session that delegated this one. */
  parentSession?: string;
  /** "subagent" for a delegated session; absent for one the user started. */
  origin?: string;
  /** The log starts with seeded events, closed by a `session/end-seed` line. */
  seeded: boolean;
}

export interface LogStats {
  lines: number;
  /** Lines recognised from their prefix as not needed (messages, tool calls and results, …) and never JSON-parsed. */
  skipped: number;
  badLines: number;
  /** assistant/message, assistant/attempt and compaction/summary lines: the ones that can carry usage. */
  usageLines: number;
  records: number;
  /** Records left out because a fork inherited them from its parent's log, where they are counted. */
  inherited: number;
  /** Model calls with no usage object (interrupted before the provider reported one). */
  noUsage: number;
  zeroUsage: number;
  unknownTypes: Record<string, number>;
}

export interface SessionLogSummary {
  path: string;
  header: LogHeader;
  /** The header's id, else the session folder's name. */
  sessionId: string;
  /** The session that delegated this one, for a subagent. */
  parentId?: string;
  kind: "main" | "subagent";
  /** `sessionId` is this log's own; the adapter moves a subagent's records to the session at the root. */
  records: UsageRecord[];
  compactions: CompactionEvent[];
  /** The prompt size of the last response; absent when a compaction came after it. */
  context?: { ts: string; tokens: number; window?: number };
  /** The model in use: the last one selected or sent a request. */
  model?: string;
  provider?: string;
  effort?: string;
  /** The working directory now: the header's, or the last `working-directory/change`. */
  cwd?: string;
  /** Sanitized. Never the harness's fallback title, which is the start of the user's first prompt. */
  title?: string;
  titleSource: "custom" | "ai" | "none";
  /** A `turn/start` with no `turn/end` yet. */
  turnOpen: boolean;
  /** Approvals asked for in the open turn and not decided yet. */
  pendingApprovals: number;
  /** ISO time of the last turn or approval event. */
  statusChangedAt?: string;
  firstTs?: string;
  lastTs?: string;
  workflowRuns: number;
  /** Sessions this one started as agents of a tool workflow. */
  workflowChildIds: string[];
  stats: LogStats;
  /** Set by the adapter: a complete frame of the file did not decode, and nothing after it was read. */
  damaged?: boolean;
}

// Every event line starts {"type":"…","seq":N,"time":MS, in that order (all of 20,988 lines checked on
// 0.2.2-rc.1). A line that doesn't is parsed in full: slower, still correct.
const PREFIX = /^\{"type":"([^"\\]{1,96})","seq":(\d{1,15}),"time":(\d{1,16})[,}]/;
const PREFIX_SCAN = 192;

/** A title line is small; a longer one is never parsed for a title, whatever it holds. */
const MAX_TITLE_LINE = 16 * 1024;

const WANTED: ReadonlySet<string> = new Set([
  "assistant/message",
  "assistant/attempt",
  "request/context",
  "model/selection",
  "session/title",
  "session/end-seed",
  "turn/start",
  "turn/end",
  "approval/asked",
  "approval/decided",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "working-directory/change",
  "tool-workflow/run-start",
  "tool-workflow/agent-start",
]);

// The rest of the harness's event vocabulary in 0.2.2-rc.1 (plus the packed rows of older generations): seen and
// passed over. A type in neither set is counted, and health names it.
const PASSED_OVER: ReadonlySet<string> = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/policy",
  "assistant/chunk",
  "command/done",
  "command/run",
  "compaction/prune",
  "deliverables/presented",
  "developer/message",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "image/offload",
  "job/registered",
  "job/settled",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/catalog",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "system/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "text-chunks",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/run-end",
  "tool/call",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "user/message",
  "web/deepseek-search-llm-request",
  "workspace/changes",
]);
const MAX_UNKNOWN_TYPES = 24;

function emptyStats(): LogStats {
  return { lines: 0, skipped: 0, badLines: 0, usageLines: 0, records: 0, inherited: 0, noUsage: 0, zeroUsage: 0, unknownTypes: {} };
}

export class SessionLogFold {
  private header: LogHeader = { seeded: false };
  private headerSeen = false;
  private seedClosed = false;
  private records: UsageRecord[] = [];
  private compactions: CompactionEvent[] = [];
  private readonly openCompactions = new Map<string, { trigger: "manual" | "auto"; preTokens?: number }>();
  private context?: { ts: string; tokens: number; window?: number };
  private compactedAfterContext = false;
  private model?: string;
  private provider?: string;
  private effort?: string;
  private window?: number;
  private cwd?: string;
  private title?: string;
  private titleSource: "custom" | "ai" | "none" = "none";
  private turnOpen = false;
  private readonly pending = new Set<string>();
  private statusAtMs?: number;
  private firstMs?: number;
  private lastMs?: number;
  private workflowRuns = 0;
  private readonly workflowChildIds = new Set<string>();
  private readonly stats = emptyStats();
  private carry = "";

  /** `fallbackId`: the session folder's name, used when the header line is missing or has no usable id. */
  constructor(
    private readonly path: string,
    private readonly fallbackId: string,
  ) {}

  /** Folds every complete line of `text`; a last line without its newline waits for the next call. */
  pushText(text: string): void {
    if (this.carry) {
      text = this.carry + text;
      this.carry = "";
    }
    let start = 0;
    let nl: number;
    while ((nl = text.indexOf("\n", start)) !== -1) {
      this.push(text.slice(start, nl));
      start = nl + 1;
    }
    if (start < text.length) this.carry = text.slice(start);
  }

  push(line: string): void {
    if (line.length === 0 || (line.charCodeAt(0) !== 123 && line.trim().length === 0)) return;
    this.stats.lines++;
    const pre = PREFIX.exec(line.length > PREFIX_SCAN ? line.slice(0, PREFIX_SCAN) : line);
    let type = "";
    let seq: number | undefined;
    let timeMs: number | undefined;
    if (pre) {
      type = pre[1]!;
      seq = Number(pre[2]);
      timeMs = msTime(Number(pre[3]));
      this.noteTime(timeMs);
      if (!WANTED.has(type) || (type === "session/title" && line.length > MAX_TITLE_LINE)) {
        this.passOver(type);
        this.stats.skipped++;
        return;
      }
    }
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      this.stats.badLines++;
      return;
    }
    if (!isObj(j)) {
      this.stats.badLines++;
      return;
    }
    if (!pre) {
      type = str(j.type) ?? "";
      if (type === "session" && j.seq === undefined) {
        this.readHeader(j);
        return;
      }
      seq = count(j.seq);
      timeMs = msTime(j.time);
      this.noteTime(timeMs);
      if (!WANTED.has(type)) {
        this.passOver(type);
        return;
      }
    }
    if (isObj(j.data)) this.apply(type, seq, timeMs, j.data);
  }

  private noteTime(ms: number | undefined): void {
    if (ms === undefined) return;
    if (this.firstMs === undefined || ms < this.firstMs) this.firstMs = ms;
    if (this.lastMs === undefined || ms > this.lastMs) this.lastMs = ms;
  }

  private passOver(type: string): void {
    // "plugin:…" events come from plugins outside the harness; it marks them ignorable itself.
    if (PASSED_OVER.has(type) || WANTED.has(type) || type.startsWith("plugin:")) return;
    const key = label(type, 96) ?? "(none)";
    const seen = this.stats.unknownTypes;
    if (key in seen) seen[key]!++;
    else if (Object.keys(seen).length < MAX_UNKNOWN_TYPES) seen[key] = 1;
  }

  private readHeader(j: Json): void {
    if (this.headerSeen) return;
    this.headerSeen = true;
    const created = msTime(j.createdAt);
    this.header = { seeded: j.isSeeded === true };
    const id = label(j.id, 200);
    if (id) this.header.id = id;
    const version = count(j.version);
    if (version !== undefined) this.header.version = version;
    const cwd = pathField(j.cwd);
    if (cwd) this.header.cwd = cwd;
    if (created !== undefined) this.header.createdAt = iso(created);
    const parent = label(j.parentSession, 200);
    if (parent) this.header.parentSession = parent;
    const origin = label(j.origin, 48);
    if (origin) this.header.origin = origin;
    this.cwd = cwd;
  }

  private sessionId(): string {
    return this.header.id ?? this.fallbackId;
  }

  private threadKind(): "main" | "subagent" {
    return this.header.origin === "subagent" || this.header.parentSession !== undefined ? "subagent" : "main";
  }

  private addRecord(r: {
    id: string;
    keyQuality: UsageRecord["keyQuality"];
    kind: RecordKind;
    model: string;
    timeMs: number;
    tokens: TokenCounts;
    outputFinal: boolean;
    flags?: string[];
  }): void {
    const rec: UsageRecord = {
      agent: AGENT,
      id: r.id,
      keyQuality: r.keyQuality,
      sessionId: this.sessionId(),
      kind: r.kind,
      model: r.model,
      ts: iso(r.timeMs),
      tokens: r.tokens,
      outputFinal: r.outputFinal,
      webSearchRequests: 0,
      sourcePath: this.path,
    };
    if (this.cwd) rec.project = this.cwd;
    if (r.flags) rec.flags = r.flags;
    this.records.push(rec);
  }

  private apply(type: string, seq: number | undefined, timeMs: number | undefined, d: Json): void {
    const nth = seq ?? this.stats.lines;
    switch (type) {
      case "turn/start":
      case "turn/end":
        this.turnOpen = type === "turn/start";
        this.pending.clear();
        if (timeMs !== undefined) this.statusAtMs = timeMs;
        break;
      case "approval/asked":
        // Only the id is taken; the reason next to it describes the tool call and is never kept.
        this.pending.add(label(d.id, 200) ?? `#${nth}`);
        if (timeMs !== undefined) this.statusAtMs = timeMs;
        break;
      case "approval/decided": {
        const id = label(d.id, 200);
        if (id) this.pending.delete(id);
        else this.pending.clear();
        if (timeMs !== undefined) this.statusAtMs = timeMs;
        break;
      }
      case "request/context": {
        const model = label(d.model);
        if (model) {
          this.model = model;
          this.provider = label(d.provider);
        }
        const window = count(d.contextWindow);
        if (window) this.window = window;
        break;
      }
      case "model/selection": {
        const model = label(d.model);
        if (!model) break;
        this.model = model;
        this.provider = label(d.provider);
        this.effort = label(d.reasoningEffort, 32);
        break;
      }
      case "working-directory/change": {
        const cwd = pathField(d.cwd);
        if (cwd) this.cwd = cwd;
        break;
      }
      case "session/title": {
        // "fallback" titles are the leading words of the first prompt, so only a generated title ("provider")
        // or a rename ("user") is kept. The last one wins, as in the harness.
        const source = isObj(d.source) ? str(d.source.kind) : undefined;
        if (source !== "user" && source !== "provider") break;
        const title = sanitizeTitle(d.title);
        if (!title) break;
        this.title = title;
        this.titleSource = source === "user" ? "custom" : "ai";
        break;
      }
      case "session/end-seed":
        this.seedClosed = true;
        if (d.inherited !== true) break;
        // A fork starts with a copy of its parent's log up to this line. The usage, compactions and workflow
        // runs in the copy belong to the parent's log; the title, model and context carry over.
        this.stats.inherited += this.records.length;
        this.records = [];
        this.compactions = [];
        this.openCompactions.clear();
        this.workflowRuns = 0;
        this.workflowChildIds.clear();
        this.firstMs = undefined;
        this.lastMs = undefined;
        break;
      case "assistant/message": {
        this.stats.usageLines++;
        const message = isObj(d.message) ? d.message : undefined;
        const source = message && isObj(message.source) ? message.source : undefined;
        const tokens = normalizeUsage(d.usage ?? lastUsageChunk(d.stream));
        if (!tokens) {
          this.stats.noUsage++;
          break;
        }
        if (isZeroUsage(tokens)) {
          this.stats.zeroUsage++;
          break;
        }
        if (timeMs === undefined) break;
        const id = label(message?.id, 200);
        this.addRecord({
          id: id ?? `${this.sessionId()}:message:${nth}`,
          keyQuality: id ? "id" : "request",
          kind: this.threadKind(),
          model: label(source?.model) ?? this.model ?? "unknown",
          timeMs,
          tokens,
          outputFinal: d.interrupted !== true,
        });
        this.context = { ts: iso(timeMs), tokens: promptTokens(tokens) };
        if (this.window !== undefined) this.context.window = this.window;
        this.compactedAfterContext = false;
        break;
      }
      case "assistant/attempt": {
        // A model call that was retried: it never became a message, but the provider answered and counted it.
        this.stats.usageLines++;
        const tokens = normalizeUsage(lastUsageChunk(d.stream));
        if (!tokens) {
          this.stats.noUsage++;
          break;
        }
        if (isZeroUsage(tokens)) {
          this.stats.zeroUsage++;
          break;
        }
        if (timeMs === undefined) break;
        this.addRecord({
          id: `${this.sessionId()}:attempt:${nth}`,
          keyQuality: "request",
          kind: this.threadKind(),
          model: this.model ?? "unknown",
          timeMs,
          tokens,
          outputFinal: true,
          flags: ["retried-attempt"],
        });
        break;
      }
      case "compaction/start": {
        const id = label(d.compactionId, 200);
        // A compaction a command asked for carries the command's id; an automatic one runs inside a turn.
        if (id) this.openCompactions.set(id, { trigger: d.sourceCommandId !== undefined ? "manual" : "auto" });
        break;
      }
      case "compaction/summary": {
        // The summarizing call: a model response of its own, and the size of what it summarized.
        this.stats.usageLines++;
        const id = label(d.compactionId, 200);
        const tokens = normalizeUsage(d.usage);
        if (!tokens) {
          this.stats.noUsage++;
          break;
        }
        const open = id ? this.openCompactions.get(id) : undefined;
        if (open) open.preTokens = promptTokens(tokens);
        if (isZeroUsage(tokens)) {
          this.stats.zeroUsage++;
          break;
        }
        if (timeMs === undefined) break;
        this.addRecord({
          id: `${this.sessionId()}:compaction:${id ?? nth}`,
          keyQuality: id ? "id" : "request",
          kind: "auxiliary",
          model: label(d.model) ?? this.model ?? "unknown",
          timeMs,
          tokens,
          outputFinal: true,
        });
        break;
      }
      case "compaction/end": {
        const id = label(d.compactionId, 200);
        const open = id ? this.openCompactions.get(id) : undefined;
        if (id) this.openCompactions.delete(id);
        // An end line with an error closes a compaction that changed nothing.
        if (d.error !== undefined || timeMs === undefined) break;
        const event: CompactionEvent = { agent: AGENT, sessionId: this.sessionId(), ts: iso(timeMs), trigger: open?.trigger ?? "unknown" };
        const preTokens = open?.preTokens ?? (this.compactedAfterContext ? undefined : this.context?.tokens);
        if (preTokens !== undefined) event.preTokens = preTokens;
        this.compactions.push(event);
        this.compactedAfterContext = true;
        break;
      }
      case "tool-workflow/run-start":
        this.workflowRuns++;
        break;
      case "tool-workflow/agent-start": {
        const child = label(d.childId, 200);
        if (child) this.workflowChildIds.add(child);
        break;
      }
    }
  }

  /** A snapshot of the fold so far. Later lines never change a summary already handed out. */
  summary(): SessionLogSummary {
    // The seeded start of a log is only known to be someone else's once its end mark is read; until then
    // nothing in it is counted.
    const counted = !this.header.seeded || this.seedClosed;
    const records = counted ? this.records.slice() : [];
    const s: SessionLogSummary = {
      path: this.path,
      header: { ...this.header },
      sessionId: this.sessionId(),
      kind: this.threadKind(),
      records,
      compactions: counted ? this.compactions.slice() : [],
      titleSource: this.title ? this.titleSource : "none",
      turnOpen: this.turnOpen,
      pendingApprovals: this.turnOpen ? this.pending.size : 0,
      workflowRuns: counted ? this.workflowRuns : 0,
      workflowChildIds: counted ? [...this.workflowChildIds] : [],
      stats: { ...this.stats, records: records.length, unknownTypes: { ...this.stats.unknownTypes } },
    };
    if (this.header.parentSession) s.parentId = this.header.parentSession;
    if (this.context && !this.compactedAfterContext) s.context = { ...this.context };
    if (this.model) s.model = this.model;
    if (this.provider) s.provider = this.provider;
    if (this.effort) s.effort = this.effort;
    if (this.cwd) s.cwd = this.cwd;
    if (this.title) s.title = this.title;
    if (this.statusAtMs !== undefined) s.statusChangedAt = iso(this.statusAtMs);
    if (this.firstMs !== undefined) s.firstTs = iso(this.firstMs);
    if (this.lastMs !== undefined) s.lastTs = iso(this.lastMs);
    return s;
  }
}

/** Folds a whole log given as text (the plain JSONL, already inflated). */
export function parseSessionLog(text: string, path: string, fallbackId: string): SessionLogSummary {
  const fold = new SessionLogFold(path, fallbackId);
  fold.pushText(text.endsWith("\n") ? text : `${text}\n`);
  return fold.summary();
}
