import { useState } from "preact/hooks";
import type { FleetSession, GroupTotals, Report } from "@signalbox/core";
import { DASH, agentLabel, basename, clipId, fmtCount, fmtRatio, fmtTokens, fmtUsd, shortId } from "./format.ts";
import { DailyChart } from "./daily-chart.tsx";
import { kindLabel } from "./stack.ts";
import { sessionTitle } from "./fleet.tsx";
import { AgentBadge, Icon, LIST_PRICE_NOTE, Section, Segmented, Usd } from "./ui.tsx";

export type RangeDays = 1 | 7 | 30;

function fresh(g: GroupTotals): number {
  const t = g.tokens;
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.output;
}

function processed(g: GroupTotals): number {
  const t = g.tokens;
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

function Kpis({ r }: { r: Report }) {
  const t = r.totals;
  const e = r.estimate;
  const freshShare = t.processedTokens > 0 ? t.freshTokens / t.processedTokens : undefined;
  return (
    <div class="kpis">
      <div class="card kpi hero">
        <span class="kpi-label">Recorded spend · lower bound</span>
        <span class="kpi-value">
          <Usd value={e.recordedUsd} />
        </span>
        <span class="kpi-sub">{LIST_PRICE_NOTE}. Sum of transcript-priced responses.</span>
      </div>
      <div class="card kpi wide">
        <span class="kpi-label">Estimated range</span>
        <span class="kpi-value kpi-range">
          <Usd value={e.estimatedLowUsd} />
          <span class="kpi-to">to</span>
          <Usd value={e.estimatedHighUsd} />
        </span>
        <span class="kpi-sub clamp" title={e.method}>
          {LIST_PRICE_NOTE}. {e.method}
        </span>
      </div>
      <div class="card kpi">
        <span class="kpi-label">Fresh tokens</span>
        <span class="kpi-value">{fmtTokens(t.freshTokens)}</span>
        <span class="kpi-sub">
          of <strong class="ink-2">{fmtTokens(t.processedTokens)}</strong> total processed
          {freshShare !== undefined ? ` · ${fmtRatio(1 - freshShare)} is cache replay` : ""}
        </span>
      </div>
      <div class="card kpi">
        <span class="kpi-label">Cache-hit ratio</span>
        <span class="kpi-value">{t.processedTokens > 0 ? fmtRatio(t.cacheHitRatio) : DASH}</span>
        <span class="kpi-sub">{t.processedTokens > 0 ? "cache reads ÷ all input tokens" : "no tokens in this range"}</span>
      </div>
      <div class="card kpi">
        <span class="kpi-label">Saved by caching</span>
        <span class="kpi-value">
          <Usd value={t.savedByCachingUsd} />
        </span>
        <span class="kpi-sub">gross, at list price · {LIST_PRICE_NOTE.toLowerCase()}</span>
      </div>
    </div>
  );
}

interface BreakdownProps {
  title: string;
  rows: GroupTotals[];
  totalUsd: number;
  nameOf(g: GroupTotals): string;
  titleOf?(g: GroupTotals): string;
  /** True for the by-model table: a row is either priced or not. */
  modelRows?: boolean;
  unpricedModels: Set<string>;
}

function Breakdown(p: BreakdownProps) {
  const [all, setAll] = useState(false);
  const LIMIT = 8;
  const rows = all ? p.rows : p.rows.slice(0, LIMIT);
  return (
    <div class="card">
      <h3>{p.title}</h3>
      {p.rows.length === 0 ? (
        <p class="empty">Nothing recorded in this range.</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" class="num" title={LIST_PRICE_NOTE}>
                  ${" "}
                  <span class="col-opt">list-price eq.</span>
                  <span class="sr-only"> ({LIST_PRICE_NOTE.toLowerCase()})</span>
                </th>
                <th scope="col" class="num" title="input + cache writes + output">
                  Fresh
                </th>
                <th scope="col" class="num" title="Fresh + cache reads">
                  Processed
                </th>
                <th scope="col" class="num col-opt">
                  Responses
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const share = p.totalUsd > 0 ? (g.cost.total / p.totalUsd) * 100 : 0;
                const unpriced = p.modelRows ? p.unpricedModels.has(g.key) || g.unpricedTokens > 0 : g.unpricedTokens > 0;
                const name = p.nameOf(g);
                return (
                  <tr key={g.key}>
                    <td>
                      <div class="cell-name">
                        <span class="label" title={p.titleOf?.(g) ?? name}>
                          {name}
                        </span>
                        {unpriced ? (
                          <span class="badge amber" title="No price row for this model; its tokens count as $0">
                            {p.modelRows ? "unpriced" : `${fmtTokens(g.unpricedTokens)} unpriced`}
                          </span>
                        ) : null}
                      </div>
                      <span class="share" style={{ width: `${Math.max(share, g.cost.total > 0 ? 1 : 0)}%` }} />
                    </td>
                    <td class="num">
                      <Usd value={g.cost.total} />
                    </td>
                    <td class="num">{fmtTokens(fresh(g))}</td>
                    <td class="num">{fmtTokens(processed(g))}</td>
                    <td class="num col-opt">{fmtCount(g.responses)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {p.rows.length > LIMIT ? (
        <div class="table-more">
          <button type="button" class="btn-link" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show top 8" : `Show all ${p.rows.length}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Ledger(props: {
  report: Report | undefined;
  refreshing: boolean;
  days: RangeDays;
  setDays(d: RangeDays): void;
  agent: string;
  setAgent(a: string): void;
  agents: string[];
}) {
  const r = props.report;
  const unpricedModels = new Set(r?.totals.unpricedModels ?? []);
  const totalUsd = r?.totals.cost.total ?? 0;
  const placeholderShare = r && r.totals.responses > 0 ? r.totals.placeholderResponses / r.totals.responses : undefined;

  return (
    <Section id="ledger" title="Burn ledger" note={`Every $ is a ${LIST_PRICE_NOTE.toLowerCase()}`}>
      <div class="controls filter-row">
        <Segmented<RangeDays>
          label="Range"
          value={props.days}
          onChange={props.setDays}
          options={[
            { value: 1, label: "Today" },
            { value: 7, label: "7d" },
            { value: 30, label: "30d" },
          ]}
        />
        <label class="sr-only" for="agent-filter">
          Agent
        </label>
        <select
          id="agent-filter"
          class="select"
          value={props.agent}
          onChange={(e) => props.setAgent((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">All agents</option>
          {props.agents.map((a) => (
            <option value={a} key={a}>
              {agentLabel(a)}
            </option>
          ))}
        </select>
        {props.refreshing ? <span class="small muted">Updating…</span> : null}
      </div>

      {!r ? (
        <p class="empty">Loading the ledger…</p>
      ) : (
        <div class={`ledger-body ${props.refreshing ? "refreshing" : ""}`} aria-busy={props.refreshing}>
          <Kpis r={r} />
          <p class="small muted ledger-meta">
            {fmtCount(r.totals.responses)} responses
            {placeholderShare !== undefined && r.totals.placeholderResponses > 0
              ? ` · ${fmtRatio(placeholderShare)} have lower-bound output (streaming placeholder), so output $ is understated`
              : ""}
          </p>
          {unpricedModels.size ? (
            <div class="banner unpriced-note" role="note">
              <Icon name="alert" />
              <span>
                <strong>Unpriced:</strong> <span title={[...unpricedModels].join(", ")}>{[...unpricedModels].map((m) => clipId(m)).join(", ")}</span> — no price row, so{" "}
                {fmtTokens(r.totals.unpricedTokens)} tokens count as {fmtUsd(0)}. Signalbox never guesses a price.
              </span>
            </div>
          ) : null}
          <DailyChart report={r} />
          <div class="breakdowns">
            <Breakdown
              title="By agent"
              rows={r.byAgent}
              totalUsd={totalUsd}
              nameOf={(g) => agentLabel(g.key)}
              unpricedModels={unpricedModels}
            />
            <Breakdown
              title="By model"
              rows={r.byModel}
              totalUsd={totalUsd}
              nameOf={(g) => g.key}
              modelRows
              unpricedModels={unpricedModels}
            />
            <Breakdown
              title="By project"
              rows={r.byProject}
              totalUsd={totalUsd}
              nameOf={(g) => basename(g.key) || "(no project)"}
              titleOf={(g) => g.key || "(no project)"}
              unpricedModels={unpricedModels}
            />
            <Breakdown
              title="By kind"
              rows={r.byKind}
              totalUsd={totalUsd}
              nameOf={(g) => kindLabel(g.key)}
              unpricedModels={unpricedModels}
            />
          </div>
        </div>
      )}
    </Section>
  );
}

export function Reconciliation({ report, sessions }: { report: Report | undefined; sessions: FleetSession[] }) {
  if (!report) return null;
  const rows = [...report.reconciliation].sort((a, b) => b.transcriptUsd - a.transcriptUsd);
  return (
    <section class="section" aria-label="Reconciliation">
      <details class="card">
        <summary>
          <Icon name="chevron" class="chev" />
          Reconciliation: transcripts vs the agent's own ledger
          <span class="muted small">
            {rows.length} session{rows.length === 1 ? "" : "s"}
          </span>
        </summary>
        <p class="small ink-2">
          Each session is priced twice with the same price table: from transcripts (what Signalbox counts) and from the
          agent's own ledger. <strong>k</strong> = transcript ÷ ledger; below 1 means the transcripts under-count
          (placeholder output, auxiliary calls). Placeholder share is the fraction of responses whose output is a lower
          bound. {LIST_PRICE_NOTE}.
        </p>
        <p class="small ink-2">
          Rows cover each session's whole history, including activity outside the selected range, so they don't add up
          to the recorded spend above.
        </p>
        <p class="small muted">Estimate method: {report.estimate.method}</p>
        {rows.length === 0 ? (
          <p class="empty">No sessions to reconcile in this range.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col" class="col-opt">
                    Project
                  </th>
                  <th scope="col" class="num">
                    Transcript $
                  </th>
                  <th scope="col" class="num">
                    Ledger $
                  </th>
                  <th scope="col" class="num">
                    k
                  </th>
                  <th scope="col" class="num" title="Share of responses whose output is a lower bound">
                    Placeholder
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = sessions.find((x) => x.sessionId === row.sessionId);
                  return (
                    <tr key={`${row.agent}:${row.sessionId}`}>
                      <td>
                        <div class="cell-name">
                          <AgentBadge agent={row.agent} />
                          <span class="label mono" title={row.sessionId}>
                            {s ? sessionTitle(s) : shortId(row.sessionId)}
                          </span>
                        </div>
                      </td>
                      <td class="col-opt" title={row.project}>
                        {basename(row.project) ?? "—"}
                      </td>
                      <td class="num">
                        <Usd value={row.transcriptUsd} />
                      </td>
                      <td class="num">
                        <Usd value={row.ledgerUsd} />
                      </td>
                      <td class="num">
                        {row.k === undefined ? (
                          "—"
                        ) : (
                          <span class="k-cell">
                            {row.k < 0.8 ? (
                              <span class="badge amber" title="Transcripts cover less than 80% of the ledger">
                                <Icon name="alert" size={11} />
                                low
                              </span>
                            ) : null}
                            {row.k.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td class="num">{fmtRatio(row.placeholderShare, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
