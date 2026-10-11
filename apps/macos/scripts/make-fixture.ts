#!/usr/bin/env bun
// Prints a SYNTHETIC `signalbox snapshot --json` object built from apps/web/src/mock.ts.
// Nothing here comes from a real machine. Regenerate the app's fixtures with:
//   TZ=UTC bun apps/macos/scripts/make-fixture.ts > apps/macos/Fixtures/snapshot.json
//   TZ=UTC bun apps/macos/scripts/make-fixture.ts --stress > apps/macos/Fixtures/stress-snapshot.json
// `--now <ISO>` pins the clock (default below); with TZ=UTC the output is identical across machines.
// `--stress` adds what real machines produce and the base mock doesn't: dozens of sessions, very long
// names and paths, unknown agents and statuses, unknown and over-100% limits, and unpriced models.
import type { FleetSession, GroupTotals, LimitSnapshot } from "@signalbox/core";
import { mockFleet, mockHealth, mockReport } from "../../web/src/mock.ts";

const DEFAULT_NOW = "2026-10-09T14:30:00.000Z";
const nowArg = process.argv.indexOf("--now");
const now = new Date(nowArg !== -1 ? process.argv[nowArg + 1]! : DEFAULT_NOW);
if (Number.isNaN(now.getTime())) throw new Error("--now: not an ISO timestamp");
const days = 7;

const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const fleet = mockFleet(now);
// The web mock has no ended session; add a synthetic one so the "Ended" group has a row to show.
const ended: FleetSession = {
  agent: "claude-code",
  sessionId: "e8a5c3b1-9d72-4e60-a4f8-0c1b3d5e7f29",
  cwd: "/Users/you/code/api-refactor",
  name: "release notes",
  status: "ended",
  statusSince: iso(-3 * HOUR),
  entrypoint: "cli",
  version: "2.1.293",
  model: "claude-opus-5-5",
  effort: "medium",
  startedAt: iso(-6 * HOUR),
  lastActivity: iso(-3 * HOUR),
  source: "registry",
  costUsd: 24.11,
};
fleet.sessions.push(ended);

const report = mockReport({ days }, now);
const health = mockHealth();
if (process.argv.includes("--stress")) addStress();

const snapshot = {
  v: 1,
  generatedAt: now.toISOString(),
  days,
  fleet,
  report,
  health,
};

function addStress(): void {
  const LONG_NAME = "Investigate the intermittent websocket reconnect storm in staging after the TLS certificate rotation";
  const LONG_CWD = "/Users/you/code/clients/acme-corporation/platform-monorepo/packages/an-unreasonably-long-package-directory-name";
  const agents = ["claude-code", "claude-code", "codex", "gemini-cli", "aider"] as const;
  const statuses = ["waiting", "busy", "idle", "unknown", "ended", "waiting", "idle"] as const;
  const models = ["claude-opus-5-5", "claude-experimental-research-preview-2026-10-01", "gpt-6-sol", "gemini-3.5-pro", undefined];
  for (let i = 0; i < 28; i++) {
    const agent = agents[i % agents.length]!;
    const sessionId = `5a5a${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const hasContext = i % 3 !== 0;
    const window = i % 4 === 1 ? undefined : agent === "codex" ? 272_000 : 1_000_000;
    const tokens = 30_000 + i * 37_000;
    fleet.sessions.push({
      agent,
      sessionId,
      pid: i % 5 === 0 ? undefined : 50_000 + i,
      cwd: i % 6 === 2 ? undefined : i % 2 === 0 ? `${LONG_CWD}-${i}` : `/Users/you/code/svc-${i}`,
      name: i % 4 === 0 ? `${LONG_NAME} #${i}` : i % 4 === 3 ? undefined : `task ${i}`,
      status: statuses[i % statuses.length]!,
      statusSince: i % 5 === 4 ? undefined : iso(-(i + 1) * 7 * MIN),
      entrypoint: i % 2 ? "cli" : "claude-desktop",
      version: "2.1.300",
      model: models[i % models.length],
      effort: i % 3 === 0 ? "xhigh" : undefined,
      startedAt: iso(-(i + 2) * HOUR),
      lastActivity: i % 7 === 6 ? undefined : iso(-(i + 1) * 3 * MIN),
      source: agent === "aider" ? "experimental" : "registry",
      costUsd: i % 5 === 2 ? undefined : i === 1 ? 12_345.67 : 0.37 * (i + 1) ** 2,
      ...(i % 5 === 1 ? { unpricedTokens: 1_234_567 } : {}),
      context: hasContext
        ? {
            agent,
            sessionId,
            tokens,
            window,
            percent: window === undefined ? undefined : i === 4 ? 103.4 : Math.round((tokens / window) * 1000) / 10,
            observedAt: iso(-(i + 1) * MIN),
            quality: i % 2 ? "estimated" : "official",
            source: i % 2 ? "transcript" : "tap",
          }
        : undefined,
    } as FleetSession);
  }

  const limit = (l: Partial<LimitSnapshot> & Pick<LimitSnapshot, "agent" | "kind" | "usedPercent">): LimitSnapshot => ({
    observedAt: iso(-2 * MIN),
    source: "synthetic",
    ...l,
  });
  fleet.limits.push(
    // A kind the app has no label for, with no window, no reset time and over 100%.
    limit({ agent: "claude-code", kind: "monthly_overage_credits_pool", usedPercent: 104 }),
    limit({ agent: "claude-code", kind: "seven_day_opus", usedPercent: 97, windowMinutes: 10_080, resetsAt: iso(30 * HOUR) }),
    // An unknown agent with more windows than the menu bar shows.
    limit({ agent: "aider", kind: "a.hourly", label: "Hourly requests", usedPercent: 12, windowMinutes: 60, resetsAt: iso(40 * MIN) }),
    limit({ agent: "aider", kind: "a.daily", label: "Daily requests", usedPercent: 55, windowMinutes: 1_440, resetsAt: iso(9 * HOUR) }),
    limit({ agent: "aider", kind: "a.weekly", label: "Weekly (experimental-model-with-a-long-name)", usedPercent: 81, windowMinutes: 10_080 }),
    limit({ agent: "aider", kind: "a.monthly", label: "Monthly", usedPercent: 3, windowMinutes: 43_200, observedAt: iso(-3 * HOUR) }),
  );
  // gemini-cli has sessions but no limit reading at all.

  const longModel = "claude-experimental-research-preview-2026-10-01";
  const unpricedRow = (key: string, from: GroupTotals): GroupTotals => ({
    ...from,
    key,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0 },
    unpricedTokens: from.tokens.input + from.tokens.output + from.tokens.cacheRead + from.tokens.cacheWrite5m + from.tokens.cacheWrite1h,
    unpricedModels: [key],
  });
  const base = report.byModel[1] ?? report.byModel[0]!;
  report.byModel.push(unpricedRow(longModel, base), unpricedRow("gemini-3.5-pro", base));
  report.totals.unpricedModels.push(longModel, "gemini-3.5-pro");
  report.byAgent.push(unpricedRow("aider", base), unpricedRow("gemini-cli", base));
  for (let i = 0; i < 12; i++) {
    const from = report.byProject[i % report.byProject.length]!;
    report.byProject.push({ ...from, key: i % 2 ? `${LONG_CWD}-${i}` : `/Users/you/code/svc-${i}`, cost: { ...from.cost, total: from.cost.total / (i + 2) } });
  }
  // One unpriced note in the CLI's wording, naming every unpriced model.
  report.notes = report.notes.filter((n) => !n.includes("no price row"));
  report.notes.unshift(`No price row for ${report.totals.unpricedModels.join(", ")}: 118,431,906 tokens are counted at $0.`);
  report.notes.push(
    "A deliberately long note to check wrapping: ledger cache writes have no 5m/1h split, so they are split by the session's own transcript share for the same model, or priced as 1h writes when the transcript has none.",
  );
  health.push(
    { name: "gemini-cli:sessions", stability: "internal", ok: false, detail: `no session files in ${LONG_CWD}/.gemini/tmp (gemini-cli not installed, or never run on this machine); sessions and usage unknown` },
    { name: "aider:experimental", stability: "preview", ok: true, detail: "a source from an adapter this app version doesn't know" },
  );
}

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
