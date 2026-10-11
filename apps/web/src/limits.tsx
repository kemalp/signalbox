import type { AdapterHealth, AgentId, FleetSession, LimitSnapshot } from "@signalbox/core";
import { ageMs, agentOrder, fmtAgo, fmtCountdown, fmtPercent, limitLabel, severity, windowLabel } from "./format.ts";
import { sessionTitle } from "./fleet.tsx";
import { AgentBadge, Icon, Meter, Section } from "./ui.tsx";

/** A reading older than this shows no fill: limits move with use on other devices too. */
export const STALE_AFTER_MS = 15 * 60_000;

export type LimitState = "fresh" | "stale" | "reset-passed";

/**
 * Reset passed beats stale: a window that reset since the reading is known to be out of date. Only a fresh
 * reading fills its meter; the others keep their last value as "was N%". Same rule as the macOS app.
 */
export function limitState(l: Pick<LimitSnapshot, "observedAt" | "resetsAt">, now: number): LimitState {
  const resetMs = ageMs(l.resetsAt, now);
  if (resetMs !== undefined && resetMs >= 0) return "reset-passed";
  const age = ageMs(l.observedAt, now);
  return age === undefined || age > STALE_AFTER_MS ? "stale" : "fresh";
}

function LimitGauge({ l, sessions, now }: { l: LimitSnapshot; sessions: FleetSession[]; now: number }) {
  const state = limitState(l, now);
  const fresh = state === "fresh";
  const from = l.sessionId ? sessions.find((s) => s.sessionId === l.sessionId) : undefined;
  const name = limitLabel(l);
  const win = windowLabel(l.windowMinutes);
  const was = fmtPercent(l.usedPercent);
  const ago = fmtAgo(l.observedAt, now);
  // A stale or reset-passed reading is out of date: an empty track and "was N%", never a fill at the old value.
  const valueText =
    state === "reset-passed"
      ? `unknown: the window reset after the last reading (${was} before)`
      : state === "stale"
        ? `unknown: the last reading is stale, from ${ago}, and was ${was}`
        : `${was} used`;
  return (
    <div class={`limit ${fresh ? "" : "is-stale"}`}>
      <div class="limit-row">
        <span class="limit-name">
          {name}
          {win && !name.includes(win) ? <span class="muted"> · {win}</span> : null}
        </span>
        <span
          class="limit-pct tabular"
          title={state === "reset-passed" ? `${was} before the window reset` : state === "stale" ? `${was} as of ${ago}` : undefined}
        >
          {fresh ? was : "—"}
        </span>
      </div>
      <Meter
        value={fresh ? l.usedPercent : undefined}
        label={`${name} used`}
        valueText={valueText}
        severity={severity(l.usedPercent, 75, 90)}
        stale={!fresh}
      />
      <div class="limit-sub">
        {state === "reset-passed" ? (
          <span class="badge" title="The window reset after this reading; open the agent to get a new one">
            reset passed · was {was}
          </span>
        ) : state === "stale" ? (
          <span class="badge" title="Reading is old; limits also move with use elsewhere. Open the agent to refresh it">
            stale · was {was}
          </span>
        ) : null}
        {state !== "reset-passed" ? <span class="tabular">{fmtCountdown(l.resetsAt, now)}</span> : null}
        <span class="tabular">as of {ago}</span>
        {from ? <span>from {sessionTitle(from)}</span> : null}
      </div>
    </div>
  );
}

/** What to tell the user about missing Claude Code limits, from the tap spool's health entry. */
export function claudeLimitsHint(spool: AdapterHealth | undefined): "no-tap" | "tap-waiting" | "unknown" {
  if (!spool) return "unknown";
  return spool.ok ? "tap-waiting" : "no-tap";
}

function UnknownLimits({ agent, spool }: { agent: AgentId; spool: AdapterHealth | undefined }) {
  const hint = agent === "claude-code" ? claudeLimitsHint(spool) : undefined;
  return (
    <div class="unknown-limits">
      <Icon name="info" size={16} class="muted" />
      <div>
        <strong>Unknown</strong> —{" "}
        {hint === "no-tap" ? (
          <>
            Claude Code reports plan limits to Signalbox only through the <strong>signalbox-tap</strong> mod, which isn't
            loaded in any session yet. See <code>docs/SPIKE.md</code> in the Signalbox repo to load it. Signalbox never
            calls account endpoints.
          </>
        ) : hint === "tap-waiting" ? (
          <>
            the signalbox-tap mod is loaded, but no session has reported a limit reading yet. It arrives with Claude
            Code's next response; meanwhile <code>/usage</code> in a Claude Code session shows your plan limits.
          </>
        ) : hint === "unknown" ? (
          <>
            Signalbox shows Claude Code's limits only when the signalbox-tap mod reports them locally (see{" "}
            <code>docs/SPIKE.md</code>); it never calls account endpoints.
          </>
        ) : (
          <>no reading from this agent yet.</>
        )}
      </div>
    </div>
  );
}

export function Limits(props: {
  limits: LimitSnapshot[] | undefined;
  sessions: FleetSession[] | undefined;
  /** Data-source health; the tap spool's entry decides what an unknown Claude Code limit says. */
  health?: AdapterHealth[] | undefined;
  now: number;
}) {
  const spool = props.health?.find((h) => h.name === "claude-code:spool");
  const limits = props.limits ?? [];
  const sessions = props.sessions ?? [];
  const agents = new Set<AgentId>(["claude-code"]);
  for (const l of limits) agents.add(l.agent);
  for (const s of sessions) agents.add(s.agent);
  const ordered = [...agents].sort(agentOrder);

  return (
    <Section id="limits" title="Plan limits" note="Account-wide; the freshest reading per window wins">
      {props.limits === undefined ? (
        <p class="empty">Loading limits…</p>
      ) : (
        <div class="limits">
          {ordered.map((agent) => {
            const mine = limits
              .filter((l) => l.agent === agent)
              .sort((a, b) => (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9) || a.kind.localeCompare(b.kind));
            const plan = mine.find((l) => l.plan)?.plan;
            return (
              <div class="card" key={agent}>
                <div class="limit-group-head">
                  <AgentBadge agent={agent} />
                  {plan ? <span class="small muted">{plan}</span> : null}
                </div>
                {mine.length ? (
                  mine.map((l) => <LimitGauge key={l.kind} l={l} sessions={sessions} now={props.now} />)
                ) : (
                  <UnknownLimits agent={agent} spool={spool} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
