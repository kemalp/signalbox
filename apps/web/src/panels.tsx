import { useState } from "preact/hooks";
import type { AdapterHealth, CompactionEvent, FleetSession } from "@signalbox/core";
import { fmtAgo, fmtTime, fmtTokens, shortId } from "./format.ts";
import { sessionTitle } from "./fleet.tsx";
import { AgentBadge, Icon, StabilityBadge } from "./ui.tsx";

const TRIGGER_LABEL: Record<CompactionEvent["trigger"], string> = {
  auto: "Auto",
  manual: "Manual",
  unknown: "Unknown",
};

export function Compactions(props: { events: CompactionEvent[] | undefined; sessions: FleetSession[]; now: number }) {
  const [all, setAll] = useState(false);
  const events = [...(props.events ?? [])].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const LIMIT = 10;
  const shown = all ? events : events.slice(0, LIMIT);
  return (
    <div class="card">
      <h3>Compaction log</h3>
      {props.events === undefined ? (
        <p class="empty">Loading…</p>
      ) : events.length === 0 ? (
        <p class="empty">No compactions recorded.</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Session</th>
                <th scope="col">Trigger</th>
                <th scope="col" class="num" title="Context tokens just before compacting">
                  Before
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const s = props.sessions.find((x) => x.sessionId === e.sessionId);
                return (
                  <tr key={`${e.agent}:${e.sessionId}:${e.ts}`}>
                    <td class="tabular" title={e.ts}>
                      {fmtTime(e.ts, props.now)}
                      <div class="small muted">{fmtAgo(e.ts, props.now)}</div>
                    </td>
                    <td>
                      <div class="cell-name">
                        <AgentBadge agent={e.agent} />
                        <span class="label" title={e.sessionId}>
                          {s ? sessionTitle(s) : <span class="mono">{shortId(e.sessionId)}</span>}
                        </span>
                      </div>
                    </td>
                    <td>{TRIGGER_LABEL[e.trigger] ?? e.trigger}</td>
                    <td class="num">{e.preTokens === undefined ? "—" : fmtTokens(e.preTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {events.length > LIMIT ? (
        <div class="table-more">
          <button type="button" class="btn-link" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show latest 10" : `Show all ${events.length}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Health({ items }: { items: AdapterHealth[] | undefined }) {
  const list = items ?? [];
  const bad = list.filter((h) => !h.ok).length;
  return (
    <div class="card">
      <h3>
        Data sources{" "}
        {items ? (
          <span class="small muted">
            {list.length - bad} ok{bad ? ` · ${bad} not available` : ""}
          </span>
        ) : null}
      </h3>
      {items === undefined ? (
        <p class="empty">Loading…</p>
      ) : list.length === 0 ? (
        <p class="empty">No adapters reported.</p>
      ) : (
        <ul class="health-list">
          {list.map((h) => (
            <li key={h.name}>
              <span class={h.ok ? "ok-icon" : "bad-icon"} title={h.ok ? "Working" : "Not available"}>
                <Icon name={h.ok ? "check" : "alert"} />
              </span>
              <div class="health-name">
                <span class="mono">{h.name}</span>
                <StabilityBadge stability={h.stability} />
                <span class="sr-only">{h.ok ? "working" : "not available"}</span>
              </div>
              <div class="health-detail">{h.detail}</div>
            </li>
          ))}
        </ul>
      )}
      <p class="small muted health-key">
        <strong>documented</strong>: vendor-documented · <strong>preview</strong>: may change between releases ·{" "}
        <strong>internal</strong>: undocumented format, may break any release
      </p>
    </div>
  );
}
