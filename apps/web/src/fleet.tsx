import type { FleetSession, SessionStatus } from "@signalbox/core";
import type { FleetSessionExtras } from "./server.ts";
import {
  ageMs,
  basename,
  contextPercent,
  fmtAgo,
  fmtDuration,
  fmtPercent,
  fmtTokens,
  severity,
  shortId,
} from "./format.ts";
import { AgentBadge, Icon, LIST_PRICE_NOTE, Meter, Section, StatusPill, Usd } from "./ui.tsx";

const STATUS_RANK: Record<SessionStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3, ended: 4 };

export function sessionTitle(s: Pick<FleetSession, "name" | "cwd" | "sessionId">): string {
  return s.name || basename(s.cwd) || shortId(s.sessionId);
}

function sortSessions(a: FleetSession, b: FleetSession): number {
  const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
  if (r) return r;
  return (Date.parse(b.lastActivity ?? "") || 0) - (Date.parse(a.lastActivity ?? "") || 0);
}

/** Tooltip for the quality badge: where the fill and the window size come from. */
function contextSourceText(c: FleetSession["context"]): string {
  if (!c) return "";
  const fill = c.quality === "official" ? "Reported by the agent" : "Estimated from the last main-thread request";
  const window =
    c.windowSource === "model-table"
      ? "; window: the model's documented size"
      : c.windowSource === "agent"
        ? "; window reported by the agent"
        : c.window
          ? ""
          : "; window size unknown";
  return `${fill}${window}`;
}

function ContextGauge({ s }: { s: FleetSession }) {
  const c = s.context;
  const pct = contextPercent(c);
  if (!c || pct === undefined) {
    // Without a known window (an unknown model, or a prompt larger than its documented window) there is no percent.
    const known = c && Number.isFinite(c.tokens) ? c : undefined;
    return (
      <div>
        <div class="ctx-row">
          <span>
            Context
            {known ? <span class="muted tabular"> · {fmtTokens(known.tokens)} (window unknown)</span> : null}
          </span>
          {known ? (
            <span class={`badge ${known.quality === "official" ? "teal" : ""}`} title={contextSourceText(known)}>
              {known.quality}
            </span>
          ) : (
            <span class="muted">unknown</span>
          )}
        </div>
        <Meter
          value={undefined}
          label="Context window use"
          valueText={known ? `${fmtTokens(known.tokens)} tokens, window unknown` : "unknown"}
          severity="ok"
        />
      </div>
    );
  }
  const official = c.quality === "official";
  const tick = c.autoCompactAtPercent;
  const valueText = `${fmtPercent(pct)} of ${c.window ? fmtTokens(c.window) : "unknown"} tokens, ${c.quality}`;
  return (
    <div>
      <div class="ctx-row">
        <span>
          Context <strong class="tabular">{fmtPercent(pct)}</strong>
          <span class="muted tabular">
            {" "}
            · {fmtTokens(c.tokens)}
            {c.window ? ` / ${fmtTokens(c.window)}` : ""}
          </span>
        </span>
        <span class={`badge ${official ? "teal" : ""}`} title={contextSourceText(c)}>
          {official ? "official" : "estimated"}
        </span>
      </div>
      <Meter
        value={pct}
        label="Context window use"
        valueText={valueText}
        severity={severity(pct, 75, tick !== undefined ? Math.min(90, tick - 5) : 90)}
        tick={tick}
        tickLabel={tick !== undefined ? `Auto-compact at ${fmtPercent(tick, 1)}` : undefined}
      />
    </div>
  );
}

function SessionCard({ s, now }: { s: FleetSession; now: number }) {
  const title = sessionTitle(s);
  const since = ageMs(s.statusSince, now);
  const where = [s.name ? basename(s.cwd) : undefined, s.entrypoint, s.version ? `v${s.version}` : undefined]
    .filter(Boolean)
    .join(" · ");
  const model = [s.model ?? "model unknown", s.effort].filter(Boolean).join(" · ");
  const unpriced = (s as FleetSession & FleetSessionExtras).unpricedTokens;
  return (
    <article class={`card session ${s.status}`} aria-label={`${title}, ${s.status}`}>
      <div class="session-top">
        <AgentBadge agent={s.agent} />
        <StatusPill status={s.status} since={since !== undefined ? fmtDuration(since) : undefined} />
      </div>
      <div>
        <h3 class="session-title" title={s.cwd ?? s.sessionId}>
          {title}
        </h3>
        {where ? (
          <div class="session-meta" title={s.cwd}>
            {where}
          </div>
        ) : null}
      </div>
      <div class="session-model mono" title={model}>
        {model}
      </div>
      <ContextGauge s={s} />
      <div class="session-foot">
        <span>
          <Usd value={s.costUsd} class="session-cost tabular" />{" "}
          <span class="eq">{s.costUsd === undefined ? "cost unknown" : "list-price eq."}</span>
          {unpriced ? (
            <span class="badge amber" title={`${fmtTokens(unpriced)} tokens on models with no price row count as $0`}>
              {s.costUsd === undefined ? "unpriced" : "+ unpriced"}
            </span>
          ) : null}
        </span>
        <span class="tabular">{s.lastActivity ? `active ${fmtAgo(s.lastActivity, now)}` : "activity unknown"}</span>
      </div>
    </article>
  );
}

export function NeedsYou({ sessions, now }: { sessions: FleetSession[]; now: number }) {
  const waiting = sessions.filter((s) => s.status === "waiting").sort(sortSessions);
  if (!waiting.length) return null;
  return (
    <div class="lane" role="region" aria-label={`Needs you: ${waiting.length} waiting`}>
      <div class="lane-head">
        <span class="lane-title">
          <Icon name="alert" />
          Needs you · {waiting.length}
        </span>
        <span class="lane-note">
          waiting for your input or a permission answer — open the session to respond
        </span>
      </div>
      <div class="grid-fleet">
        {waiting.map((s) => (
          <SessionCard key={`${s.agent}:${s.sessionId}`} s={s} now={now} />
        ))}
      </div>
    </div>
  );
}

export function Fleet({ sessions, now }: { sessions: FleetSession[] | undefined; now: number }) {
  const list = (sessions ?? []).filter((s) => s.status !== "waiting").sort(sortSessions);
  const total = sessions?.length;
  return (
    <Section id="fleet" title="Fleet" count={total} note={`Session $ is a ${LIST_PRICE_NOTE.toLowerCase()}`}>
      {sessions ? <NeedsYou sessions={sessions} now={now} /> : null}
      {sessions === undefined ? (
        <p class="empty">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <div class="card empty">No live agent sessions found on this machine.</div>
      ) : list.length ? (
        <div class="grid-fleet">
          {list.map((s) => (
            <SessionCard key={`${s.agent}:${s.sessionId}`} s={s} now={now} />
          ))}
        </div>
      ) : null}
    </Section>
  );
}
