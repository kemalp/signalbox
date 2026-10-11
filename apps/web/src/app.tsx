import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AdapterHealth, FleetSnapshot, Report } from "@signalbox/core";
import { AuthError, forgetToken, takeToken, useNow, usePoll } from "./api.ts";
import { agentOrder, fmtAgo, fmtTime } from "./format.ts";
import { Fleet } from "./fleet.tsx";
import { Ledger, Reconciliation, type RangeDays } from "./ledger.tsx";
import { Limits } from "./limits.tsx";
import { Compactions, Health } from "./panels.tsx";
import { BrandMark, Icon, LIST_PRICE_NOTE } from "./ui.tsx";

const FLEET_MS = 15_000;
const REPORT_MS = 60_000;

// Read at startup so the token leaves the address bar before anything renders.
const INITIAL_TOKEN = takeToken();

function readPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const v: unknown = JSON.parse(raw);
      if (valid(v)) return v;
    }
  } catch {
    // ignore unreadable storage
  }
  return fallback;
}

function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

const isRange = (v: unknown): v is RangeDays => v === 1 || v === 7 || v === 30;
const isAgent = (v: unknown): v is string => typeof v === "string" && v.length < 65;

function Gate({ expired }: { expired: boolean }) {
  return (
    <main class="gate">
      <div class="card">
        <BrandMark />
        <h1>{expired ? "This link has expired" : "Open the link printed by signalbox serve"}</h1>
        <p>
          {expired
            ? "Signalbox makes a new access key each time it starts. Open the most recent link it printed in your terminal."
            : "This dashboard only answers requests carrying the one-time key from the link that Signalbox prints when it starts. In a terminal, run:"}
        </p>
        <pre>signalbox serve</pre>
        <p class="small muted">
          The key sits after the <code>#</code> in that link. Browsers never send that part over the network, and the
          page removes it from the address bar as soon as it loads.
        </p>
      </div>
    </main>
  );
}

function Header(props: { fleetOk: boolean; updatedAt: number | undefined; now: number; waiting: number }) {
  const label = props.fleetOk ? "Live" : "Reconnecting…";
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <BrandMark />
          <div>
            <div class="brand-name">Signalbox</div>
            <div class="brand-sub">Local control room for coding agents · unofficial</div>
          </div>
        </div>
        <div class="topbar-status">
          {props.waiting ? (
            <a class="pill st-waiting" href="#fleet-h">
              <Icon name="waiting" size={12} />
              {props.waiting} need{props.waiting === 1 ? "s" : ""} you
            </a>
          ) : null}
          <span class={`live-dot ${props.fleetOk ? "" : "bad"}`} aria-hidden="true" />
          <span role="status">{label}</span>
          <span class="muted tabular">
            {props.updatedAt ? `· updated ${fmtAgo(new Date(props.updatedAt).toISOString(), props.now)}` : ""}
          </span>
        </div>
      </div>
    </header>
  );
}

function Footer({ report, now }: { report: Report | undefined; now: number }) {
  return (
    <footer class="footer">
      <div>
        <strong>{LIST_PRICE_NOTE}.</strong> Dollar figures price your local token counts at public list prices;
        subscription plans bill differently.
      </div>
      {report?.priceTables.length ? (
        <div>
          Prices:{" "}
          {report.priceTables.map((p, i) => (
            <span key={p.provider}>
              {i ? " · " : ""}
              {p.provider} as of {p.asOf} (
              <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
                source
              </a>
              )
            </span>
          ))}
          {" · "}report generated {fmtTime(report.generatedAt, now)}
        </div>
      ) : null}
      {report?.notes.length ? (
        <ul>
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <div>
        Signalbox is unofficial and not affiliated with or endorsed by Anthropic, OpenAI or Google. It reads files on
        this machine, needs no credentials, and sends nothing anywhere.
      </div>
    </footer>
  );
}

function Dashboard({ token, onAuthFail }: { token: string; onAuthFail(): void }) {
  const now = useNow(1000);
  const [days, setDaysState] = useState<RangeDays>(() => readPref("signalbox.days", 7, isRange));
  const [agent, setAgentState] = useState<string>(() => readPref("signalbox.agent", "", isAgent));
  const setDays = (d: RangeDays) => {
    setDaysState(d);
    writePref("signalbox.days", d);
  };
  const setAgent = (a: string) => {
    setAgentState(a);
    writePref("signalbox.agent", a);
  };

  const fleet = usePoll<FleetSnapshot>("/api/fleet", token, FLEET_MS);
  const reportPath = `/api/report?days=${days}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  const report = usePoll<Report>(reportPath, token, REPORT_MS);
  const health = usePoll<AdapterHealth[]>("/api/health", token, REPORT_MS);

  useEffect(() => {
    if ([fleet.error, report.error, health.error].some((e) => e instanceof AuthError)) onAuthFail();
  }, [fleet.error, report.error, health.error]);

  // Agents seen anywhere stay in the filter, even while the report is filtered to one of them.
  const known = useRef(new Set<string>());
  for (const s of fleet.data?.sessions ?? []) known.current.add(s.agent);
  for (const g of report.data?.byAgent ?? []) known.current.add(g.key);
  if (agent) known.current.add(agent);
  const agents = [...known.current].sort(agentOrder);

  const sessions = fleet.data?.sessions;
  const waiting = sessions?.filter((s) => s.status === "waiting").length ?? 0;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Signalbox` : "Signalbox";
  }, [waiting]);

  const reportFailed = report.error && !(report.error instanceof AuthError);
  const fleetFailed = fleet.error && !(fleet.error instanceof AuthError);

  return (
    <>
      <Header fleetOk={!fleetFailed} updatedAt={fleet.updatedAt} now={now} waiting={waiting} />
      <main class="wrap">
        {fleetFailed || reportFailed ? (
          <div class="banner" role="alert">
            <Icon name="alert" />
            <span>
              Can't reach the Signalbox server right now; showing the last data received. Retrying automatically.
            </span>
          </div>
        ) : null}
        <Fleet sessions={sessions} now={now} />
        <Limits limits={fleet.data?.limits} sessions={sessions} health={health.data ?? fleet.data?.health} now={now} />
        <Ledger
          report={report.data}
          refreshing={report.loading && report.data !== undefined}
          days={days}
          setDays={setDays}
          agent={agent}
          setAgent={setAgent}
          agents={agents}
        />
        <Reconciliation report={report.data} sessions={sessions ?? []} />
        <section class="section panels" aria-label="Compactions and data sources">
          <Compactions events={fleet.data?.compactions} sessions={sessions ?? []} now={now} />
          <Health items={health.data ?? fleet.data?.health} />
        </section>
        <Footer report={report.data} now={now} />
      </main>
    </>
  );
}

function App() {
  const [token, setToken] = useState(INITIAL_TOKEN);
  const [expired, setExpired] = useState(false);

  // Pasting a fresh link into an open tab only changes the fragment, which doesn't reload the page.
  useEffect(() => {
    const onHash = () => {
      const next = takeToken();
      if (next && location.hash === "") {
        setToken(next);
        setExpired(false);
      }
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  if (!token || expired) return <Gate expired={expired} />;
  return (
    <Dashboard
      key={token}
      token={token}
      onAuthFail={() => {
        forgetToken();
        setExpired(true);
      }}
    />
  );
}

const root = document.getElementById("app");
if (root) {
  root.replaceChildren();
  render(<App />, root);
}
