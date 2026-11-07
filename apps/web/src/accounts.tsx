// Accounts: which subscription each session runs under, from the fleet's `accounts` and each session's `account`.
// Ids are hashes; the page shows your label (set in the macOS app) or the short id. A session or reading with no
// account is "Account unknown", never a default account.
// Types only from core: the page bundle stays free of Node built-ins (core hashes ids with node:crypto).
import type { AccountInfo, AccountRef, AgentId, FleetSession, LimitSnapshot } from "@signalbox/core";
import { Section } from "./ui.tsx";

/** /Users/<name>/… as ~/… (the page doesn't know $HOME; this is display only). */
function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** The 6 characters after "acct-" (core's accountShortId). */
export function accountShortId(id: string): string {
  return id.startsWith("acct-") ? id.slice(5, 11) : id.slice(0, 6);
}

const SOURCE_TEXT: Record<string, string> = {
  "claude-app-folder": "Claude app's session folders",
  transcript: "transcript account lines",
  "config-login": "a config dir's current login",
  "tap-config-dir": "the tap's config dir and its login",
};

export function accountName(id: string, accounts: readonly AccountInfo[] | undefined): string {
  return accounts?.find((a) => a.id === id)?.label ?? accountShortId(id);
}

export function accountTitle(ref: AccountRef): string {
  const how = ref.quality === "inferred" ? "Inferred from" : "From";
  const org = ref.orgKnown ? "" : " (organization unknown)";
  return `${how} ${SOURCE_TEXT[ref.source] ?? ref.source}${org}; account ${accountShortId(ref.id)}`;
}

export function AccountChip({ account, accounts }: { account: AccountRef | undefined; accounts: readonly AccountInfo[] | undefined }) {
  if (!account) return null;
  return (
    <span class={`badge acct ${account.quality === "inferred" ? "inferred" : ""}`} title={accountTitle(account)}>
      {accountName(account.id, accounts)}
    </span>
  );
}

export interface LimitGroup {
  agent: AgentId;
  /** Undefined: readings from sessions whose account is unknown. */
  account?: AccountRef;
  limits: LimitSnapshot[];
}

/** One group per (agent, account); known accounts first (by name), the unknown-account group last. */
export function limitGroups(limits: readonly LimitSnapshot[], accounts: readonly AccountInfo[] | undefined): LimitGroup[] {
  const groups = new Map<string, LimitGroup>();
  for (const l of limits) {
    const key = `${l.agent}\n${l.account?.id ?? ""}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = l.account ? { agent: l.agent, account: l.account, limits: [] } : { agent: l.agent, limits: [] }));
    g.limits.push(l);
  }
  const name = (g: LimitGroup) => (g.account ? accountName(g.account.id, accounts).toLowerCase() : "￿");
  return [...groups.values()].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
}

export function Accounts({ accounts, sessions }: { accounts: AccountInfo[] | undefined; sessions: FleetSession[] | undefined }) {
  const list = accounts ?? [];
  const unknownLive = (sessions ?? []).filter((s) => s.agent === "claude-code" && !s.account && s.status !== "ended").length;
  return (
    <Section id="accounts" title="Accounts" count={accounts ? list.length : undefined} note="Hashed ids only; never an email">
      {accounts === undefined ? (
        <p class="empty">No account information from this Signalbox version.</p>
      ) : list.length === 0 ? (
        <div class="card empty">No account seen yet. Claude Code names one in the Claude app's session list, in some transcript lines, and in each config dir's login.</div>
      ) : (
        <div class="card">
          <div class="table-wrap">
          <table class="accounts-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Named by</th>
                <th scope="col">Terminal login of</th>
                <th scope="col" class="num">
                  Live
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.label ?? accountShortId(a.id)}</strong>
                    {a.label ? <span class="muted mono small"> {accountShortId(a.id)}</span> : null}
                    {a.orgKnown ? null : (
                      <span class="badge amber" title="Only the account half was found; its plan limits can't be told apart">
                        organization unknown
                      </span>
                    )}
                  </td>
                  <td class="small">
                    {[...a.sources.map((s) => SOURCE_TEXT[s] ?? s), ...(a.claudeAppFolder && !a.sources.includes("claude-app-folder") ? [SOURCE_TEXT["claude-app-folder"]!] : [])].join(", ")}
                  </td>
                  <td class="small mono">{a.loginConfigDirs?.map((d) => tildify(d)).join(", ") ?? "—"}</td>
                  <td class="num tabular">{a.liveSessions ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {unknownLive ? (
            <p class="small muted">
              {unknownLive} live Claude Code {unknownLive === 1 ? "session has" : "sessions have"} no account: nothing on disk names it, and a desktop session runs
              on the Claude app's own login.
            </p>
          ) : null}
          <p class="small muted">Labels come from the macOS app's Accounts screen.</p>
        </div>
      )}
    </Section>
  );
}
