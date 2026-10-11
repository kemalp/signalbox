#!/usr/bin/env bun
// Prints a SYNTHETIC session history (the `signalbox history --json` shape, the stream's "history" data) for the
// app's snapshot renderer and tests. Every title, project, id and number is made up; nothing comes from a real
// machine. The live entries are the busy, waiting and idle sessions of apps/macos/Fixtures/snapshot.json, so their
// Live pills lead to sessions the fixture has. Past desktop sessions are also in a made-up Claude app list (the
// app's title wins, some archived), and a few sessions are only in that list (no transcript, so no figures and no
// resume command). Regenerate with:
//   bun apps/macos/scripts/make-history-fixture.ts > apps/macos/Fixtures/history.json
// `--now <ISO>` pins the clock (default: the snapshot fixture's). The output doesn't depend on TZ.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; reasoning?: number };
type Entry = {
  agent: string;
  sessionId: string;
  title?: string;
  titleSource: string;
  appTitleSource?: string;
  project?: string;
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  startedAt: string;
  lastActivityAt: string;
  durationMs?: number;
  live: boolean;
  models: string[];
  effort?: string;
  responses?: number;
  tokens?: Tokens;
  costUsd?: number;
  unpricedTokens?: number;
  placeholderShare?: number;
  ledgerUsd?: number;
  compactions?: number;
  subagentFiles?: number;
  workflowRuns?: number;
  resume?: { command: string; cwd?: string };
  transcriptPath?: string;
  appSessionId?: string;
  archived?: boolean;
  hasTranscript: boolean;
};

const DEFAULT_NOW = "2026-10-09T14:30:00.000Z";
const nowArg = process.argv.indexOf("--now");
const now = new Date(nowArg !== -1 ? process.argv[nowArg + 1]! : DEFAULT_NOW);
if (Number.isNaN(now.getTime())) throw new Error("--now: not an ISO timestamp");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOME = "/Users/you";
const iso = (t: number) => new Date(t).toISOString();

// A small deterministic generator, so the fixture is the same on every run.
let seed = 20261009;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));

/** List prices per million tokens (input, output, cache read, cache write 5m, cache write 1h); none = unpriced. */
const PRICES: Record<string, [number, number, number, number, number]> = {
  "claude-opus-5-5": [5, 25, 0.5, 6.25, 10],
  "claude-sonnet-5-5": [3, 15, 0.3, 3.75, 6],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25, 2],
  "gpt-6-sol": [1.25, 10, 0.125, 0, 0],
};

function usage(models: string[], scale: number): Pick<Entry, "tokens" | "costUsd" | "unpricedTokens" | "responses"> {
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let cost = 0;
  let unpriced = 0;
  models.forEach((model, i) => {
    const share = i === 0 ? 1 : 0.25;
    const t: Tokens = {
      input: Math.round(between(8_000, 60_000) * scale * share),
      output: Math.round(between(12_000, 90_000) * scale * share),
      cacheRead: Math.round(between(900_000, 9_000_000) * scale * share),
      cacheWrite5m: Math.round(between(40_000, 400_000) * scale * share),
      cacheWrite1h: model.startsWith("claude") ? Math.round(between(0, 120_000) * scale * share) : 0,
    };
    for (const k of Object.keys(tokens) as (keyof Tokens)[]) tokens[k] = (tokens[k] ?? 0) + (t[k] ?? 0);
    // Codex reports reasoning tokens separately (already inside output); Claude Code doesn't.
    if (!model.startsWith("claude")) tokens.reasoning = (tokens.reasoning ?? 0) + Math.round(t.output * 0.3);
    const p = PRICES[model];
    if (p) cost += (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite5m * p[3] + t.cacheWrite1h * p[4]) / 1e6;
    else unpriced += t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  });
  return {
    tokens,
    costUsd: Math.round(cost * 100) / 100,
    unpricedTokens: unpriced,
    responses: Math.max(1, Math.round(between(20, 260) * scale)),
  };
}

function claudeIds(project: string, sessionId: string) {
  return {
    resume: { command: `claude --resume ${sessionId}`, cwd: project },
    transcriptPath: `${HOME}/.claude/projects/${project.replaceAll(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`,
  };
}

function codexIds(sessionId: string, started: number) {
  const d = new Date(started);
  const ymd = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("/");
  return {
    resume: { command: `codex resume ${sessionId}` },
    transcriptPath: `${HOME}/.codex/sessions/${ymd}/${sessionId}.jsonl`,
  };
}

const uuid = (n: number) => {
  const h = (n * 2654435761) >>> 0;
  const hex = h.toString(16).padStart(8, "0");
  return `${hex}-${String(n).padStart(4, "0")}-4${hex.slice(1, 4)}-8${hex.slice(4, 7)}-${((h ^ 0x5bd1e995) >>> 0).toString(16).padStart(8, "0")}${String(n).padStart(4, "0")}`;
};

const entries: Entry[] = [];

// The fixture's live sessions (busy, waiting, idle) and its ended one, with the titles the app would show.
const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "..", "Fixtures", "snapshot.json"), "utf8")) as {
  fleet: { sessions: { agent: string; sessionId: string; name?: string; status: string; cwd?: string; model?: string; startedAt?: string; lastActivity?: string; costUsd?: number; entrypoint?: string; version?: string }[] };
};
const liveTitles: Record<string, [string | undefined, string]> = {
  "api-refactor": ["api-refactor", "custom"],
  "docs sweep": ["docs sweep", "custom"],
  "nightly-triage": ["nightly-triage", "agent-name"],
};
for (const s of snapshot.fleet.sessions) {
  const started = Date.parse(s.startedAt ?? iso(now.getTime() - HOUR));
  const last = Date.parse(s.lastActivity ?? iso(now.getTime()));
  const project = s.cwd;
  const [title, titleSource] = s.name
    ? (liveTitles[s.name] ?? [s.name, "custom"])
    : s.agent === "codex"
      ? ["Tidy up the terraform plan output", "index"]
      : ["Fix flaky checkout end-to-end tests", "ai"];
  const models = s.agent === "codex" ? ["gpt-5.5-codex"] : [s.model ?? "claude-opus-5-5"];
  const u = usage(models, s.agent === "codex" ? 0.6 : 1.4);
  entries.push({
    agent: s.agent,
    sessionId: s.sessionId,
    title,
    titleSource,
    project,
    gitBranch: s.agent === "codex" ? "main" : pick(["main", "feat/streaming-usage", "fix/checkout-flake"]),
    entrypoint: s.entrypoint,
    version: s.version,
    startedAt: iso(started),
    lastActivityAt: iso(last),
    durationMs: last - started,
    live: s.status !== "ended",
    models,
    ...u,
    costUsd: s.costUsd ?? u.costUsd,
    placeholderShare: 0.02,
    ledgerUsd: s.costUsd !== undefined && s.agent === "claude-code" ? Math.round(s.costUsd * 1.07 * 100) / 100 : undefined,
    compactions: s.name === "api-refactor" ? 2 : 0,
    subagentFiles: s.name === "api-refactor" ? 3 : 0,
    workflowRuns: 0,
    ...(s.agent === "codex" ? codexIds(s.sessionId, started) : claudeIds(project ?? HOME, s.sessionId)),
    hasTranscript: true,
  });
}

// Past sessions over about three months: invented tasks in invented projects. Two projects share a folder name
// ("api"), one path has a space and a quote (the resume line must quote it), and some sessions have no title.
const PROJECTS = [
  `${HOME}/code/api-refactor`,
  `${HOME}/code/signalbox`,
  `${HOME}/code/web-app`,
  `${HOME}/code/infra`,
  `${HOME}/code/mobile-app`,
  `${HOME}/code/data-pipeline`,
  `${HOME}/code/clients/acme/api`,
  `${HOME}/code/personal/api`,
  `${HOME}/code/Client Work/o'reilly-site`,
];
const TITLES = [
  "Refactor auth middleware to use session tokens",
  "Add dark mode to the settings page",
  "Migrate CI to the new runner images",
  "Investigate memory growth in the worker pool",
  "Write onboarding docs for new contributors",
  "Upgrade the mobile app's navigation library",
  "Profile slow dashboard queries",
  "Set up preview deployments for pull requests",
  "Remove unused feature flags",
  "Design a rate limiter for the public API",
  "Port the billing scripts to TypeScript",
  "Add retries to webhook delivery",
  "Split the monolith config into packages",
  "Fix the timezone bug in weekly reports",
  "Improve search ranking for short queries",
  "Replace the date library with Temporal",
  "Speed up the test suite with sharding",
  "Draft the 3.2 release notes",
  "Add an export to CSV button",
  "Review dependency updates",
];
const LONG_TITLE =
  "Investigate the intermittent websocket reconnect storm in staging after the TLS certificate rotation and write it up";
const CLAUDE_MODELS = [["claude-opus-5-5"], ["claude-sonnet-5-5"], ["claude-opus-5-5", "claude-haiku-4-5"], ["claude-sonnet-5-5", "claude-haiku-4-5"]];
/** The Claude app's own titles for past desktop sessions (it renames sessions the transcript calls something else). */
const APP_TITLES = [
  "Websocket reconnect storm write-up",
  "Session token middleware",
  "Worker pool memory growth",
  "Dashboard query profiling",
  "Preview deployments",
  "Billing scripts in TypeScript",
];
const appId = (n: number) => `local_${uuid(n + 5000)}`;
let merged = 0;
const CODEX_MODELS = [["gpt-6-sol"], ["gpt-5.5-codex"], ["gpt-6-sol", "gpt-5.5-codex"]];

// Offsets back from now, in hours, for the last activity: dense this week, sparser further back.
const offsets: number[] = [];
for (let h = 1.5; h < 7 * 24; h += 4 + rand() * 9) offsets.push(h);
for (let h = 7 * 24; h < 100 * 24; h += 20 + rand() * 50) offsets.push(h);

offsets.forEach((back, i) => {
  const n = i + 1;
  const codex = i % 5 === 3;
  const agent = codex ? "codex" : "claude-code";
  const project = i === 2 ? PROJECTS[8]! : pick(PROJECTS);
  const last = Math.round((now.getTime() - back * HOUR) / 1000) * 1000;
  const durationMs = between(4, 260) * MIN;
  const started = last - durationMs;
  const models = codex ? pick(CODEX_MODELS) : pick(CLAUDE_MODELS);
  const sessionId = codex ? `rollout-${iso(started).slice(0, 19).replaceAll(":", "-")}-${uuid(n).slice(0, 4)}` : uuid(n);
  let title: string | undefined;
  let titleSource: string;
  if (i === 0) {
    title = LONG_TITLE;
    titleSource = "custom";
  } else if (i % 9 === 4) {
    title = undefined;
    titleSource = "none";
  } else if (codex) {
    title = pick(TITLES);
    titleSource = "index";
  } else if (i % 11 === 6) {
    title = pick(["dependency-bot", "docs-linter", "release-captain"]);
    titleSource = "agent-name";
  } else {
    title = pick(TITLES);
    titleSource = i % 3 === 0 ? "ai" : "custom";
  }
  const u = usage(models, 0.3 + rand() * 1.6);
  // In this order, so the generator's sequence (and every other value) stays what it was before the app's list.
  const gitBranch = pick(["main", "main", "develop", `feat/${(title ?? "untitled").toLowerCase().split(" ").slice(0, 3).join("-")}`]);
  const entrypoint = codex ? "cli" : pick(["cli", "cli", "claude-desktop", "sdk"]);
  // A desktop session is in the Claude app's list too: the CLI merges the app's record into this entry (the app's
  // title wins; every third one is archived in the app).
  const inApp = entrypoint === "claude-desktop";
  const app = inApp
    ? {
        appSessionId: appId(n),
        archived: merged % 3 === 2,
        title: merged % 4 === 1 ? APP_TITLES[(merged >> 2) % APP_TITLES.length]! : (title ?? APP_TITLES[merged % APP_TITLES.length]!),
        titleSource: "app",
        // The app's raw label: "auto" when it generated the title.
        appTitleSource: merged % 2 === 0 ? "auto" : "user",
        effort: merged % 3 === 0 ? "high" : undefined,
      }
    : {};
  if (inApp) merged += 1;
  entries.push({
    agent,
    sessionId,
    title,
    titleSource,
    project,
    gitBranch,
    entrypoint,
    version: codex ? "0.71.0" : pick(["2.1.288", "2.1.290", "2.1.293"]),
    startedAt: iso(started),
    lastActivityAt: iso(last),
    durationMs,
    live: false,
    models,
    ...u,
    placeholderShare: i % 4 === 0 ? 0.08 : 0,
    ledgerUsd: !codex && i % 3 === 1 ? Math.round((u.costUsd ?? 0) * 1.12 * 100) / 100 : undefined,
    compactions: i % 6 === 0 ? between(1, 3) : 0,
    subagentFiles: i % 4 === 1 ? between(1, 6) : 0,
    workflowRuns: i % 10 === 5 ? 1 : 0,
    ...(codex ? codexIds(sessionId, started) : claudeIds(project, sessionId)),
    ...app,
    hasTranscript: true,
  });
});

// A session that ran across midnight (UTC), and one the CLI knows little about: no figures, no resume command.
const midnight = new Date(now);
midnight.setUTCHours(0, 0, 0, 0);
const lateStart = midnight.getTime() - DAY - 50 * MIN;
entries.push({
  agent: "claude-code",
  sessionId: uuid(900),
  title: "Hotfix for the expired signing certificate",
  titleSource: "custom",
  project: `${HOME}/code/web-app`,
  gitBranch: "hotfix/signing-cert",
  entrypoint: "cli",
  version: "2.1.293",
  startedAt: iso(lateStart),
  lastActivityAt: iso(lateStart + 95 * MIN),
  durationMs: 95 * MIN,
  live: false,
  models: ["claude-opus-5-5"],
  ...usage(["claude-opus-5-5"], 0.8),
  compactions: 0,
  subagentFiles: 0,
  workflowRuns: 0,
  ...claudeIds(`${HOME}/code/web-app`, uuid(900)),
  hasTranscript: true,
});
entries.push({
  agent: "claude-code",
  sessionId: uuid(901),
  titleSource: "none",
  startedAt: iso(now.getTime() - 12 * DAY - 3 * HOUR),
  lastActivityAt: iso(now.getTime() - 12 * DAY - 3 * HOUR),
  live: false,
  models: [],
  hasTranscript: true,
});

// Two sessions opened and closed with nothing sent (no title, no response): the app hides them unless asked.
for (const [n, back, project] of [[902, 26 * HOUR + 7 * MIN, `${HOME}/code/signalbox`], [903, 26 * HOUR + 4 * MIN, `${HOME}/code/web-app`]] as const) {
  const last = Math.round((now.getTime() - back) / 1000) * 1000;
  entries.push({
    agent: "claude-code",
    sessionId: uuid(n),
    titleSource: "none",
    project,
    entrypoint: "claude-desktop",
    version: "2.1.293",
    startedAt: iso(last - 31_000),
    lastActivityAt: iso(last),
    durationMs: 31_000,
    live: false,
    models: [],
    responses: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    costUsd: 0,
    unpricedTokens: 0,
    placeholderShare: 0,
    compactions: 0,
    subagentFiles: 0,
    workflowRuns: 0,
    ...claudeIds(project, uuid(n)),
    hasTranscript: true,
  });
}

// Sessions only in the Claude app's list: their transcripts aren't on this Mac (removed, or the session ran on another
// machine), so they have a title, folder, dates and maybe a model, and no figures, resume command or transcript path.
// The app's own id stands in for the session id, except where the app still names the removed transcript's id.
const APP_ONLY: Array<{ n: number; back: number; span: number; title: string; project: string; model?: string; effort?: string; archived: boolean; cliId?: boolean }> = [
  { n: 950, back: 3 * HOUR + 10 * MIN, span: 40 * MIN, title: "Sketch the onboarding checklist", project: `${HOME}/code/web-app`, model: "claude-opus-5-5", effort: "medium", archived: false },
  { n: 951, back: DAY + 5 * HOUR, span: 25 * MIN, title: "Plan the Q4 roadmap doc", project: `${HOME}/code/signalbox`, archived: false },
  { n: 952, back: DAY + 2 * HOUR, span: 90 * MIN, title: "Try the new MCP server config", project: `${HOME}/code/infra`, model: "claude-sonnet-5-5", archived: true },
  { n: 953, back: 15 * DAY, span: 3 * HOUR, title: "Clean up old feature branches", project: `${HOME}/code/mobile-app`, model: "claude-sonnet-5-5", archived: false, cliId: true },
  { n: 954, back: 36 * DAY, span: 2 * HOUR, title: "Prototype the pricing page", project: `${HOME}/code/web-app`, model: "claude-opus-5-5", archived: true },
  { n: 955, back: 64 * DAY, span: 50 * MIN, title: "Notes on the data retention policy", project: `${HOME}/code/data-pipeline`, archived: false },
];
for (const a of APP_ONLY) {
  const last = Math.round((now.getTime() - a.back) / 1000) * 1000;
  entries.push({
    agent: "claude-code",
    sessionId: a.cliId ? uuid(a.n) : appId(a.n),
    title: a.title,
    titleSource: "app",
    appTitleSource: "auto",
    project: a.project,
    startedAt: iso(last - a.span),
    lastActivityAt: iso(last),
    durationMs: a.span,
    live: false,
    models: a.model ? [a.model] : [],
    effort: a.effort,
    appSessionId: appId(a.n),
    archived: a.archived,
    hasTranscript: false,
  });
}

entries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.sessionId.localeCompare(b.sessionId));
for (const e of entries) {
  for (const k of Object.keys(e) as (keyof Entry)[]) if (e[k] === undefined) delete e[k];
}

const inAppList = entries.filter((e) => e.appSessionId !== undefined);
const sources = {
  transcripts: entries.filter((e) => e.hasTranscript).length,
  claudeApp: {
    enabled: true,
    records: inAppList.length,
    merged: inAppList.filter((e) => e.hasTranscript).length,
    appOnly: inAppList.filter((e) => !e.hasTranscript).length,
    archived: inAppList.filter((e) => e.archived).length,
  },
};

process.stdout.write(
  `${JSON.stringify({ v: 1, generatedAt: now.toISOString(), entries, total: entries.length, truncated: false, sources }, null, 2)}\n`,
);
