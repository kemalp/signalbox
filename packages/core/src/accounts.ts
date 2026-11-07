// Accounts: which subscription a session ran under, and one limit gauge per account. Adapters turn the vendor's
// account and organization UUIDs into AccountEvidence the moment they read them (accountEvidence below), so raw
// ids never travel further than the parse; this module picks one account per session and one reading per gauge.
import { createHash } from "node:crypto";
import { sanitizeTitle } from "./history.ts";
import type { AccountEvidence, AccountInfo, AccountRef, AccountSource, LimitSnapshot } from "./types.ts";

/** The vendor UUID shape (Claude Code account and organization ids). Anything else is not used. */
const VENDOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVendorUuid(v: unknown): v is string {
  return typeof v === "string" && VENDOR_UUID.test(v);
}

function hash12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** "acct-" + 12 hex of sha256(account + "\n" + organization), or of account + "\n?" when the organization is unknown. */
export function accountId(accountUuid: string, organizationUuid?: string): string {
  return `acct-${hash12(`${accountUuid.toLowerCase()}\n${organizationUuid?.toLowerCase() ?? "?"}`)}`;
}

/** The 6 characters after "acct-", for display when the user set no label. */
export function accountShortId(id: string): string {
  return id.startsWith("acct-") ? id.slice(5, 11) : id.slice(0, 6);
}

/**
 * Evidence from raw vendor ids, or undefined when the account id isn't UUID-shaped. An organization id that isn't
 * UUID-shaped counts as unknown. The caller drops the raw ids right after.
 */
export function accountEvidence(
  accountUuid: unknown,
  organizationUuid: unknown,
  source: AccountSource,
  quality: AccountRef["quality"],
  atMs?: number,
): AccountEvidence | undefined {
  if (!isVendorUuid(accountUuid)) return undefined;
  const org = isVendorUuid(organizationUuid) ? organizationUuid : undefined;
  const ev: AccountEvidence = {
    ref: { id: accountId(accountUuid, org), orgKnown: org !== undefined, source, quality },
    accountKey: hash12(`account\n${accountUuid.toLowerCase()}`),
  };
  if (atMs !== undefined && Number.isFinite(atMs)) ev.atMs = atMs;
  return ev;
}

/** The same evidence relabelled as an inference from another source (a config dir's login applied to a session). */
export function inferredFrom(ev: AccountEvidence, source: AccountSource, atMs?: number): AccountEvidence {
  const out: AccountEvidence = { ref: { ...ev.ref, source, quality: "inferred" }, accountKey: ev.accountKey };
  if (atMs !== undefined && Number.isFinite(atMs)) out.atMs = atMs;
  return out;
}

function newest(list: readonly AccountEvidence[]): AccountEvidence | undefined {
  let best: AccountEvidence | undefined;
  for (const e of list) if (!best || (e.atMs ?? -Infinity) > (best.atMs ?? -Infinity)) best = e;
  return best;
}

export interface ResolvedAccount {
  account?: AccountRef;
  /** Recorded evidence named more than one account; `account` is the newest. */
  conflict: boolean;
}

/**
 * One account for a session. Recorded evidence beats inferred; among recorded, a full (account, organization) id
 * beats an account-only one, and the newest wins. A conflict is recorded evidence for a different account (or, for
 * full ids, a different organization). No evidence: undefined, never a default.
 */
export function resolveAccount(evidence: readonly AccountEvidence[] | undefined): ResolvedAccount {
  const all = evidence ?? [];
  const recorded = all.filter((e) => e.ref.quality === "recorded");
  if (recorded.length > 0) {
    const full = recorded.filter((e) => e.ref.orgKnown);
    const winner = newest(full.length > 0 ? full : recorded)!;
    const conflict = recorded.some((e) => e.accountKey !== winner.accountKey || (e.ref.orgKnown && winner.ref.orgKnown && e.ref.id !== winner.ref.id));
    return { account: { ...winner.ref }, conflict };
  }
  const inferred = newest(all);
  return inferred ? { account: { ...inferred.ref }, conflict: false } : { conflict: false };
}

/** A limit reading with its spool sequence number, for tie-breaks. */
export interface LimitCandidate {
  snap: LimitSnapshot;
  seq?: number;
}

function limitKey(s: LimitSnapshot): string {
  return `${s.agent}\n${s.account?.id ?? ""}\n${s.kind}`;
}

function rank(c: LimitCandidate): [number, number, number] {
  const resets = c.snap.resetsAt ? Date.parse(c.snap.resetsAt) : NaN;
  const observed = Date.parse(c.snap.observedAt);
  return [Number.isNaN(resets) ? -Infinity : resets, Number.isNaN(observed) ? -Infinity : observed, c.seq ?? -Infinity];
}

function better(a: LimitCandidate, b: LimitCandidate): boolean {
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
  return false;
}

/**
 * One reading per (agent, account, kind). The latest window wins (resetsAt; a reading without one ranks below any
 * with one), then the newest reading, then the higher spool seq: a session idle since an earlier window can report
 * that window's numbers again later, and must not replace the current one. Sorted by agent, then account (unknown
 * last), then kind.
 */
export function pickLimits(candidates: Iterable<LimitCandidate>): LimitSnapshot[] {
  const best = new Map<string, LimitCandidate>();
  for (const c of candidates) {
    const k = limitKey(c.snap);
    const prev = best.get(k);
    if (!prev || better(c, prev)) best.set(k, c);
  }
  const acct = (s: LimitSnapshot) => s.account?.id ?? "￿";
  return [...best.values()]
    .map((c) => c.snap)
    .sort((a, b) => cmp(String(a.agent), String(b.agent)) || cmp(acct(a), acct(b)) || cmp(a.kind, b.kind));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const MAX_ACCOUNT_LABEL_CHARS = 40;

/** A user-set account label fit to show (one line, no control characters, at most 40 characters). */
export function sanitizeAccountLabel(raw: unknown): string | undefined {
  return sanitizeTitle(raw, MAX_ACCOUNT_LABEL_CHARS);
}

const ACCOUNT_ID = /^acct-[0-9a-f]{12}$/;

/**
 * Signalbox's own accounts.json ({ "v": 1, "labels": { "<account id>": "<label>" } }) → id → label. Unknown keys,
 * ids of another shape and empty labels are ignored; anything unparsable gives no labels.
 */
export function parseAccountLabels(text: string): Record<string, string> {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return {};
  const labels = (d as Record<string, unknown>).labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return {};
  const out: Record<string, string> = {};
  for (const [id, raw] of Object.entries(labels as Record<string, unknown>)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const label = sanitizeAccountLabel(raw);
    if (label) out[id] = label;
  }
  return out;
}

/** What an adapter knows of one account, before labels and fleet counts. */
export interface AccountSighting {
  ref: AccountRef;
  loginConfigDir?: string;
  claudeAppFolder?: boolean;
}

/** Accounts from an adapter's sightings, merged by id (no labels or live counts yet; see finishAccounts). */
export function accountDirectory(sightings: Iterable<AccountSighting>): AccountInfo[] {
  const infos: AccountInfo[] = [];
  for (const x of sightings) {
    const info: AccountInfo = { id: x.ref.id, orgKnown: x.ref.orgKnown, sources: [x.ref.source] };
    if (x.loginConfigDir) info.loginConfigDirs = [x.loginConfigDir];
    if (x.claudeAppFolder) info.claudeAppFolder = true;
    infos.push(info);
  }
  return finishAccounts(infos);
}

/**
 * Merges account infos by id (sources and login dirs unioned), adds the user's labels and the number of live
 * sessions under each (an account only a live session names is added too), and sorts: full ids first, then by
 * label or short id.
 */
export function finishAccounts(
  infos: Iterable<AccountInfo>,
  opts: { labels?: Record<string, string>; live?: Iterable<{ account?: AccountRef }> } = {},
): AccountInfo[] {
  const byId = new Map<string, { info: AccountInfo; sources: Set<string>; logins: Set<string> }>();
  const slot = (id: string, orgKnown: boolean) => {
    let s = byId.get(id);
    if (!s) {
      s = { info: { id, orgKnown, sources: [] }, sources: new Set(), logins: new Set() };
      byId.set(id, s);
    }
    return s;
  };
  for (const i of infos) {
    const s = slot(i.id, i.orgKnown);
    for (const src of i.sources) s.sources.add(src);
    for (const d of i.loginConfigDirs ?? []) s.logins.add(d);
    if (i.claudeAppFolder) s.info.claudeAppFolder = true;
  }
  const live = new Map<string, number>();
  for (const l of opts.live ?? []) {
    if (!l.account) continue;
    live.set(l.account.id, (live.get(l.account.id) ?? 0) + 1);
    slot(l.account.id, l.account.orgKnown).sources.add(l.account.source);
  }
  const out: AccountInfo[] = [];
  for (const { info, sources, logins } of byId.values()) {
    const done: AccountInfo = { id: info.id, orgKnown: info.orgKnown, sources: [...sources].sort() };
    const label = opts.labels?.[info.id];
    if (label) done.label = label;
    if (logins.size > 0) done.loginConfigDirs = [...logins].sort();
    if (info.claudeAppFolder) done.claudeAppFolder = true;
    const n = live.get(info.id);
    if (n) done.liveSessions = n;
    out.push(done);
  }
  const name = (a: AccountInfo) => (a.label ?? accountShortId(a.id)).toLowerCase();
  return out.sort((a, b) => Number(b.orgKnown) - Number(a.orgKnown) || cmp(name(a), name(b)) || cmp(a.id, b.id));
}
