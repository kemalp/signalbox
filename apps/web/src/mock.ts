// Synthetic data for developing the page (`bun apps/web/src/dev.ts`) and for tests.
// Everything here is generated; nothing is copied from real transcripts.
import {
  embeddedCommandCatalogs,
  type AdapterHealth,
  type AgentId,
  type CommandsSnapshot,
  type CompactionEvent,
  type CostBreakdown,
  type DayTotals,
  type FleetSession,
  type FleetSnapshot,
  type GroupTotals,
  type LimitSnapshot,
  type ModelPrice,
  type ReconciliationRow,
  type RecordKind,
  type Report,
  type TokenCounts,
} from "@signalbox/core";
import type { ReportQuery } from "./server.ts";

export type { DayTotals };

const HOME = "/Users/you/code";
const PROJECTS = [`${HOME}/api-refactor`, `${HOME}/signalbox`, `${HOME}/web-app`, `${HOME}/infra`];

// USD per MTok, mock-only (shaped like pricing/anthropic.json). gpt-5.5-codex is deliberately unpriced.
const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, webSearchPerRequest: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

interface Stream {
  agent: AgentId;
  model: string;
  kind: RecordKind;
  /** Typical tokens per weekday. */
  daily: TokenCounts;
  responsesPerDay: number;
  placeholderShare: number;
  webSearchPerDay?: number;
  /** Weights over PROJECTS. */
  projects: number[];
}

const STREAMS: Stream[] = [
  {
    agent: "claude-code",
    model: "claude-opus-5-5",
    kind: "main",
    daily: { input: 4_200, output: 118_000, cacheRead: 61_000_000, cacheWrite5m: 0, cacheWrite1h: 1_150_000 },
    responsesPerDay: 290,
    placeholderShare: 0.004,
    webSearchPerDay: 6,
    projects: [0.45, 0.25, 0.3, 0],
  },
  {
    agent: "claude-code",
    model: "claude-opus-5-5",
    kind: "workflow",
    daily: { input: 2_100, output: 86_000, cacheRead: 168_000_000, cacheWrite5m: 4_400_000, cacheWrite1h: 0 },
    responsesPerDay: 820,
    placeholderShare: 0.944,
    projects: [0.6, 0.15, 0.25, 0],
  },
  {
    agent: "claude-code",
    model: "claude-opus-5-5",
    kind: "subagent",
    daily: { input: 900, output: 29_000, cacheRead: 22_000_000, cacheWrite5m: 880_000, cacheWrite1h: 0 },
    responsesPerDay: 140,
    placeholderShare: 0.86,
    projects: [0.3, 0.4, 0.3, 0],
  },
  {
    agent: "claude-code",
    model: "claude-sonnet-5-5",
    kind: "subagent",
    daily: { input: 1_100, output: 41_000, cacheRead: 9_200_000, cacheWrite5m: 610_000, cacheWrite1h: 0 },
    responsesPerDay: 95,
    placeholderShare: 0.81,
    projects: [0.2, 0.5, 0.3, 0],
  },
  {
    agent: "claude-code",
    model: "claude-haiku-4-5",
    kind: "auxiliary",
    daily: { input: 1_750_000, output: 58_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    responsesPerDay: 410,
    placeholderShare: 0,
    projects: [0.4, 0.3, 0.3, 0],
  },
  {
    agent: "codex",
    model: "gpt-5.5-codex",
    kind: "main",
    daily: { input: 2_450_000, output: 152_000, cacheRead: 17_800_000, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 61_000 },
    responsesPerDay: 120,
    placeholderShare: 0,
    projects: [0, 0, 0, 1],
  },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function zeroCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0 };
}

function price(model: string, t: TokenCounts, webSearches: number): CostBreakdown | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const c: CostBreakdown = {
    input: (t.input * p.input) / 1e6,
    output: (t.output * p.output) / 1e6,
    cacheRead: (t.cacheRead * p.cacheRead) / 1e6,
    cacheWrite5m: (t.cacheWrite5m * p.cacheWrite5m) / 1e6,
    cacheWrite1h: (t.cacheWrite1h * p.cacheWrite1h) / 1e6,
    webSearch: webSearches * (p.webSearchPerRequest ?? 0),
    total: 0,
  };
  c.total = c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h + c.webSearch;
  return c;
}

interface Cell {
  day: string;
  stream: Stream;
  project: string;
  tokens: TokenCounts;
  cost?: CostBreakdown;
  responses: number;
  placeholders: number;
}

class Acc {
  tokens = zeroTokens();
  cost = zeroCost();
  responses = 0;
  placeholderResponses = 0;
  unpricedTokens = 0;
  unpriced = new Set<string>();

  add(c: Cell): void {
    for (const k of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) this.tokens[k] += c.tokens[k];
    if (c.tokens.reasoning !== undefined) this.tokens.reasoning = (this.tokens.reasoning ?? 0) + c.tokens.reasoning;
    if (c.cost) {
      for (const k of Object.keys(this.cost) as Array<keyof CostBreakdown>) this.cost[k] += c.cost[k];
    } else {
      this.unpricedTokens += c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheWrite5m + c.tokens.cacheWrite1h;
      this.unpriced.add(c.stream.model);
    }
    this.responses += c.responses;
    this.placeholderResponses += c.placeholders;
  }

  out(key: string): GroupTotals {
    return {
      key,
      tokens: { ...this.tokens },
      cost: { ...this.cost },
      responses: this.responses,
      placeholderResponses: this.placeholderResponses,
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpriced].sort(),
    };
  }
}

function group(cells: Cell[], keyOf: (c: Cell) => string): GroupTotals[] {
  const m = new Map<string, Acc>();
  for (const c of cells) {
    const k = keyOf(c);
    let a = m.get(k);
    if (!a) m.set(k, (a = new Acc()));
    a.add(c);
  }
  return [...m.entries()].map(([k, a]) => a.out(k)).sort((x, y) => y.cost.total - x.cost.total || x.key.localeCompare(y.key));
}

function scale(t: TokenCounts, f: number): TokenCounts {
  const r = (n: number) => Math.round(n * f);
  const out: TokenCounts = {
    input: r(t.input),
    output: r(t.output),
    cacheRead: r(t.cacheRead),
    cacheWrite5m: r(t.cacheWrite5m),
    cacheWrite1h: r(t.cacheWrite1h),
  };
  if (t.reasoning !== undefined) out.reasoning = r(t.reasoning);
  return out;
}

export function mockReport(q: ReportQuery, now: Date = new Date()): Report {
  const days = Math.max(1, Math.min(365, Math.floor(q.days)));
  const streams = STREAMS.filter((s) => !q.agent || s.agent === q.agent);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const dayFraction = (now.getHours() * 60 + now.getMinutes()) / 1440;
  const cells: Cell[] = [];
  const dayKeys: string[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dayKey(d);
    dayKeys.push(key);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const isToday = i === days - 1;
    STREAMS.forEach((s, si) => {
      if (!streams.includes(s)) return;
      const r = rng(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() + si * 7919);
      let f = (weekend ? 0.28 : 1) * (0.55 + r() * 0.85);
      if (isToday) f *= Math.max(0.05, dayFraction);
      // Codex shows up only on some days.
      if (s.agent === "codex" && r() < 0.35) return;
      s.projects.forEach((w, pi) => {
        if (w <= 0) return;
        const tokens = scale(s.daily, f * w);
        const webSearches = Math.round((s.webSearchPerDay ?? 0) * f * w);
        const responses = Math.max(1, Math.round(s.responsesPerDay * f * w));
        const cell: Cell = {
          day: key,
          stream: s,
          project: PROJECTS[pi]!,
          tokens,
          responses,
          placeholders: Math.round(responses * s.placeholderShare),
        };
        const cost = price(s.model, tokens, webSearches);
        if (cost) cell.cost = cost;
        cells.push(cell);
      });
    });
  }

  const all = new Acc();
  for (const c of cells) all.add(c);
  const totalsBase = all.out("total");
  const t = totalsBase.tokens;
  let saved = 0;
  for (const c of cells) {
    const p = PRICES[c.stream.model];
    if (p) saved += (c.tokens.cacheRead * (p.input - p.cacheRead)) / 1e6;
  }

  const byDay: DayTotals[] = dayKeys.map((key) => {
    const dayCells = cells.filter((c) => c.day === key);
    const acc = new Acc();
    for (const c of dayCells) acc.add(c);
    return {
      ...acc.out(key),
      byModel: group(dayCells, (c) => c.stream.model),
      byKind: group(dayCells, (c) => c.stream.kind),
    };
  });

  const recorded = totalsBase.cost.total;
  const reconciliation = mockReconciliation(q.agent);

  const { key: _key, ...totalsRest } = totalsBase;
  return {
    generatedAt: now.toISOString(),
    range: { since: start.toISOString(), until: now.toISOString() },
    totals: {
      ...totalsRest,
      processedTokens: t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
      freshTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.output,
      cacheHitRatio: t.cacheRead / Math.max(1, t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input),
      savedByCachingUsd: saved,
    },
    byAgent: group(cells, (c) => c.stream.agent),
    byModel: group(cells, (c) => c.stream.model),
    byProject: group(cells, (c) => c.project),
    byKind: group(cells, (c) => c.stream.kind),
    byDay,
    reconciliation,
    estimate: {
      recordedUsd: recorded,
      estimatedLowUsd: recorded * 1.14,
      estimatedHighUsd: recorded * 1.29,
      method:
        "Ledger where a session has one, otherwise transcript ÷ per-model coverage k (claude-opus-5-5 k≈0.85); live sessions use the larger of transcript and live cost.",
    },
    priceTables: [
      { provider: "anthropic", asOf: "2026-10-09", sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing" },
    ],
    notes: [
      "Subagent and workflow output is a lower bound: many responses keep the streaming placeholder.",
      ...(streams.some((s) => !PRICES[s.model])
        ? ["gpt-5.5-codex has no price row and is counted as $0 (unpriced)."]
        : []),
    ],
  };
}

function mockReconciliation(agent: string | undefined): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [
    { agent: "claude-code", sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10", project: PROJECTS[0], transcriptUsd: 142.18, ledgerUsd: 167.4, k: 0.849, placeholderShare: 0.71 },
    { agent: "claude-code", sessionId: "c41d2e77-5a90-4f3b-8e2d-91b0a7c3f562", project: PROJECTS[2], transcriptUsd: 88.06, ledgerUsd: 89.12, k: 0.988, placeholderShare: 0.02 },
    { agent: "claude-code", sessionId: "2b9e0f14-6c3d-47a1-b8e9-5d4c2a1f7e03", project: PROJECTS[1], transcriptUsd: 51.3, ledgerUsd: 96.8, k: 0.53, placeholderShare: 0.93 },
    { agent: "claude-code", sessionId: "e8a5c3b1-9d72-4e60-a4f8-0c1b3d5e7f29", project: PROJECTS[0], transcriptUsd: 23.94, ledgerUsd: 24.11, k: 0.993, placeholderShare: 0.01 },
    { agent: "claude-code", sessionId: "51f0d9a6-3e8b-4c27-9f14-6a2e8b0c4d75", project: PROJECTS[2], transcriptUsd: 12.4, placeholderShare: 0.88 },
    { agent: "codex", sessionId: "rollout-2026-10-09T08-12-44-019a", project: PROJECTS[3], transcriptUsd: 0, placeholderShare: 0 },
  ];
  return rows.filter((r) => !agent || r.agent === agent);
}

function iso(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function mockFleet(now: Date = new Date()): FleetSnapshot {
  const sessions: FleetSession[] = [
    {
      agent: "claude-code",
      sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10",
      pid: 48211,
      cwd: PROJECTS[0],
      name: "api-refactor",
      status: "busy",
      statusSince: iso(now, -3 * MIN - 12_000),
      entrypoint: "claude-desktop",
      version: "2.1.293",
      model: "claude-opus-5-5",
      effort: "high",
      startedAt: iso(now, -5 * HOUR),
      lastActivity: iso(now, -4_000),
      source: "agents --json",
      costUsd: 18.42,
      context: {
        agent: "claude-code",
        sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10",
        tokens: 412_300,
        window: 1_000_000,
        windowSource: "agent",
        percent: 41.2,
        autoCompactAtPercent: 96.7,
        observedAt: iso(now, -40_000),
        quality: "official",
        source: "tap",
      },
    },
    {
      agent: "claude-code",
      sessionId: "2b9e0f14-6c3d-47a1-b8e9-5d4c2a1f7e03",
      pid: 48390,
      cwd: PROJECTS[1],
      name: "docs sweep",
      status: "waiting",
      statusSince: iso(now, -4 * MIN - 31_000),
      waitingFor: "permission prompt",
      entrypoint: "claude-desktop",
      version: "2.1.293",
      model: "claude-sonnet-5-5",
      effort: "medium",
      startedAt: iso(now, -2 * HOUR),
      lastActivity: iso(now, -4 * MIN - 31_000),
      source: "agents --json",
      costUsd: 3.17,
      context: {
        agent: "claude-code",
        sessionId: "2b9e0f14-6c3d-47a1-b8e9-5d4c2a1f7e03",
        tokens: 88_400,
        // Claude Sonnet 5.5's documented 1M window, from models/anthropic.json.
        window: 1_000_000,
        windowSource: "model-table",
        percent: 8.8,
        autoCompactAtPercent: 96.7,
        observedAt: iso(now, -4 * MIN),
        quality: "estimated",
        source: "transcript",
      },
    },
    {
      agent: "claude-code",
      sessionId: "c41d2e77-5a90-4f3b-8e2d-91b0a7c3f562",
      pid: 47002,
      cwd: PROJECTS[2],
      status: "idle",
      statusSince: iso(now, -26 * MIN),
      entrypoint: "cli",
      version: "2.1.293",
      model: "claude-opus-5-5",
      effort: "xhigh",
      startedAt: iso(now, -7 * HOUR),
      lastActivity: iso(now, -26 * MIN),
      source: "registry",
      costUsd: 41.9,
      context: {
        agent: "claude-code",
        sessionId: "c41d2e77-5a90-4f3b-8e2d-91b0a7c3f562",
        tokens: 902_100,
        window: 1_000_000,
        windowSource: "agent",
        percent: 90.2,
        autoCompactAtPercent: 96.7,
        observedAt: iso(now, -26 * MIN),
        quality: "official",
        source: "tap",
      },
    },
    {
      agent: "claude-code",
      sessionId: "a0c7e2d9-41b6-4f85-b3a0-8e9d1c2f6a47",
      cwd: PROJECTS[1],
      name: "nightly-triage",
      status: "busy",
      statusSince: iso(now, -41 * MIN),
      entrypoint: "sdk",
      version: "2.1.293",
      model: "claude-haiku-4-5",
      startedAt: iso(now, -41 * MIN),
      lastActivity: iso(now, -18_000),
      source: "agents --json",
    },
    {
      agent: "codex",
      sessionId: "rollout-2026-10-09T08-12-44-019a",
      pid: 51220,
      cwd: PROJECTS[3],
      status: "idle",
      statusSince: iso(now, -9 * MIN),
      entrypoint: "cli",
      version: "0.71.0",
      model: "gpt-5.5-codex",
      effort: "medium",
      startedAt: iso(now, -3 * HOUR),
      lastActivity: iso(now, -9 * MIN),
      source: "codex sessions",
      context: {
        agent: "codex",
        sessionId: "rollout-2026-10-09T08-12-44-019a",
        tokens: 128_000,
        window: 272_000,
        windowSource: "agent",
        observedAt: iso(now, -9 * MIN),
        quality: "estimated",
        source: "rollout",
      },
    },
  ];

  const limits: LimitSnapshot[] = [
    {
      agent: "claude-code",
      kind: "five_hour",
      usedPercent: 63,
      resetsAt: iso(now, 2 * HOUR + 14 * MIN),
      windowMinutes: 300,
      observedAt: iso(now, -40_000),
      plan: "Max 20x",
      sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10",
      source: "tap",
    },
    {
      agent: "claude-code",
      kind: "seven_day",
      usedPercent: 41,
      resetsAt: iso(now, 3 * DAY + 5 * HOUR),
      windowMinutes: 10080,
      observedAt: iso(now, -40_000),
      plan: "Max 20x",
      sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10",
      source: "tap",
    },
    {
      agent: "claude-code",
      kind: "seven_day_fable",
      usedPercent: 88,
      resetsAt: iso(now, 3 * DAY + 5 * HOUR),
      windowMinutes: 10080,
      observedAt: iso(now, -47 * MIN),
      sessionId: "c41d2e77-5a90-4f3b-8e2d-91b0a7c3f562",
      source: "tap",
    },
    {
      agent: "codex",
      kind: "codex.primary",
      usedPercent: 22,
      resetsAt: iso(now, 3 * HOUR + 2 * MIN),
      windowMinutes: 300,
      observedAt: iso(now, -9 * MIN),
      plan: "pro",
      sessionId: "rollout-2026-10-09T08-12-44-019a",
      source: "rollout",
    },
    {
      agent: "codex",
      kind: "codex.secondary",
      usedPercent: 58,
      resetsAt: iso(now, 4 * DAY + 2 * HOUR),
      windowMinutes: 10080,
      observedAt: iso(now, -9 * MIN),
      plan: "pro",
      sessionId: "rollout-2026-10-09T08-12-44-019a",
      source: "rollout",
    },
  ];

  const compactions: CompactionEvent[] = [
    { agent: "claude-code", sessionId: "c41d2e77-5a90-4f3b-8e2d-91b0a7c3f562", ts: iso(now, -2 * HOUR - 6 * MIN), trigger: "auto", preTokens: 967_400 },
    { agent: "claude-code", sessionId: "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10", ts: iso(now, -4 * HOUR - 40 * MIN), trigger: "manual", preTokens: 512_800 },
    { agent: "claude-code", sessionId: "e8a5c3b1-9d72-4e60-a4f8-0c1b3d5e7f29", ts: iso(now, -DAY - 3 * HOUR), trigger: "auto", preTokens: 966_900 },
    { agent: "codex", sessionId: "rollout-2026-10-09T08-12-44-019a", ts: iso(now, -2 * DAY), trigger: "unknown" },
  ];

  return { generatedAt: now.toISOString(), sessions, limits, compactions, health: mockHealth() };
}

export function mockHealth(): AdapterHealth[] {
  return [
    { name: "claude-code:agents-json", stability: "preview", ok: true, detail: "4 sessions from `claude agents --json` (0.4s)" },
    { name: "claude-code:registry", stability: "internal", ok: true, detail: "4 registry files; keys only" },
    { name: "claude-code:transcripts", stability: "internal", ok: true, detail: "312 transcript files in range" },
    { name: "claude-code:cost-state", stability: "internal", ok: true, detail: "52 ledger rows in 32 transcripts" },
    { name: "claude-code:spool", stability: "preview", ok: true, detail: "3 sessions reporting via signalbox-tap" },
    {
      name: "claude-app:sessions",
      stability: "internal",
      ok: true,
      detail:
        "21 session record files in /Users/you/Library/Application Support/Claude/claude-code-sessions (allow-listed local_*.json names, read-only); last history: 21 records read, 15 matched a transcript, 6 without a transcript, 7 archived, 0 skipped (not a regular file or over 1 MiB), 0 unreadable",
    },
    { name: "codex:rollouts", stability: "internal", ok: true, detail: "41 rollout files in range" },
    { name: "gemini-cli:telemetry", stability: "documented", ok: false, detail: "Gemini CLI not detected on this machine" },
  ];
}

/**
 * A command guide (`signalbox commands --json`): the real embedded catalogs, made-up installed versions
 * (Claude Code matches its catalog, Codex is newer than the one its catalog was checked on, Gemini CLI is
 * not installed) and made-up custom commands covering every kind and scope.
 */
export function mockCommands(now: Date = new Date()): CommandsSnapshot {
  const app = PROJECTS[1]!;
  return {
    v: 1,
    generatedAt: now.toISOString(),
    installed: { "claude-code": "2.1.293", codex: "0.162.0" },
    catalogs: embeddedCommandCatalogs(),
    custom: [
      { agent: "claude-code", name: "/release-notes", description: "Draft release notes from the pull requests merged since the last tag", kind: "command", scope: "user", source: "~/.claude/commands/release-notes.md" },
      { agent: "claude-code", name: "/db:check", description: "Compare pending migrations with the staging schema", kind: "command", scope: "project", source: `${app}/.claude/commands/db/check.md`, project: app },
      { agent: "claude-code", name: "/pdf-tools", description: "Fill, merge and split PDF files", kind: "skill", scope: "user", source: "~/.claude/skills/pdf-tools/SKILL.md" },
      { agent: "claude-code", name: "/acme:lint-fix", description: "Run the linters and fix what they can", kind: "plugin-command", scope: "plugin", source: "acme" },
      { agent: "claude-code", name: "/acme:triage", kind: "plugin-skill", scope: "plugin", source: "acme" },
      { agent: "codex", name: "$changelog", description: "Keep CHANGELOG.md in the house style", kind: "skill", scope: "user", source: "~/.agents/skills/changelog/SKILL.md" },
      { agent: "codex", name: "/prompts:standup", description: "Summarize yesterday's commits for a standup", kind: "prompt", scope: "user", source: "~/.codex/prompts/standup.md" },
      { agent: "gemini-cli", name: "/git:commit", description: "Write a commit message for the staged changes", kind: "command", scope: "user", source: "~/.gemini/commands/git/commit.toml" },
    ],
  };
}
