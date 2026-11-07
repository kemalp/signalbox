import { describe, expect, test } from "bun:test";
import {
  accountDirectory,
  accountEvidence,
  accountMatches,
  accountId,
  accountShortId,
  buildHistory,
  finishAccounts,
  inferredFrom,
  isExpiredReading,
  mergeAppSessions,
  parseAccountLabels,
  pickLimits,
  resolveAccount,
  type AccountEvidence,
  type AppSessionRecord,
  type HistorySession,
  type LimitSnapshot,
} from "../src/index.ts";

// Synthetic ids only.
const ACCT_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ACCT_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const ORG_X = "0c0c0c0c-0000-4000-8000-00000000000c";
const ORG_Y = "0d0d0d0d-0000-4000-8000-00000000000d";

const ev = (a: string, o: string | undefined, source: string, quality: "recorded" | "inferred", atMs?: number): AccountEvidence =>
  accountEvidence(a, o, source, quality, atMs)!;

describe("account ids", () => {
  test("stable, opaque, organization-scoped", () => {
    const id = accountId(ACCT_A, ORG_X);
    expect(id).toMatch(/^acct-[0-9a-f]{12}$/);
    expect(accountId(ACCT_A.toUpperCase(), ORG_X)).toBe(id);
    expect(accountId(ACCT_A, ORG_Y)).not.toBe(id);
    expect(accountId(ACCT_A)).not.toBe(id);
    expect(id).not.toContain(ACCT_A.slice(0, 8));
    expect(accountShortId(id)).toBe(id.slice(5, 11));
  });

  test("evidence needs a UUID-shaped account id; a bad organization id is unknown", () => {
    expect(accountEvidence("someone@example.com", ORG_X, "transcript", "recorded")).toBeUndefined();
    expect(accountEvidence("", undefined, "transcript", "recorded")).toBeUndefined();
    const partial = accountEvidence(ACCT_A, "not-a-uuid", "transcript", "recorded")!;
    expect(partial.ref.orgKnown).toBe(false);
    expect(partial.ref.id).toBe(accountId(ACCT_A));
    expect(JSON.stringify(partial)).not.toContain(ACCT_A);
  });
});

describe("resolveAccount", () => {
  test("no evidence is unknown, never a default", () => {
    expect(resolveAccount(undefined)).toEqual({ conflict: false });
    expect(resolveAccount([])).toEqual({ conflict: false });
  });

  test("recorded beats inferred, whatever the times", () => {
    const r = resolveAccount([ev(ACCT_B, ORG_Y, "config-login", "inferred", 9e12), ev(ACCT_A, ORG_X, "claude-app-folder", "recorded", 1)]);
    expect(r.account?.id).toBe(accountId(ACCT_A, ORG_X));
    expect(r.account?.quality).toBe("recorded");
    expect(r.conflict).toBe(false);
  });

  test("a full id beats an account-only one of the same account, without a conflict", () => {
    const r = resolveAccount([ev(ACCT_A, undefined, "transcript", "recorded", 5), ev(ACCT_A, ORG_X, "claude-app-folder", "recorded", 1)]);
    expect(r.account?.id).toBe(accountId(ACCT_A, ORG_X));
    expect(r.conflict).toBe(false);
  });

  test("two recorded accounts: the newest wins and the conflict is flagged", () => {
    const r = resolveAccount([ev(ACCT_A, ORG_X, "claude-app-folder", "recorded", 1), ev(ACCT_B, ORG_Y, "transcript", "recorded", 2)]);
    expect(r.account?.id).toBe(accountId(ACCT_B, ORG_Y));
    expect(r.conflict).toBe(true);
  });

  test("same account, two organizations: a conflict", () => {
    const r = resolveAccount([ev(ACCT_A, ORG_X, "claude-app-folder", "recorded", 1), ev(ACCT_A, ORG_Y, "transcript", "recorded", 2)]);
    expect(r.account?.id).toBe(accountId(ACCT_A, ORG_Y));
    expect(r.conflict).toBe(true);
  });

  test("an account-only winner is completed by the one full id with the same account half", () => {
    const partial = ev(ACCT_A, undefined, "transcript", "recorded", 5);
    const match = accountMatches([partial], [ev(ACCT_A, ORG_X, "claude-app-folder", "recorded"), ev(ACCT_B, ORG_Y, "config-login", "inferred")]);
    expect(match.map((m) => [m.ref.id, m.ref.source, m.ref.quality])).toEqual([[accountId(ACCT_A, ORG_X), "account-match", "inferred"]]);
    expect(resolveAccount([partial, ...match]).account).toEqual({ id: accountId(ACCT_A, ORG_X), orgKnown: true, source: "account-match", quality: "inferred" });
    // Two organizations for that account: no way to tell, so the account-only id stays.
    const two = accountMatches([partial], [ev(ACCT_A, ORG_X, "claude-app-folder", "recorded"), ev(ACCT_A, ORG_Y, "claude-app-folder", "recorded")]);
    expect(two).toEqual([]);
    expect(resolveAccount([partial]).account?.orgKnown).toBe(false);
  });

  test("inferred only: the newest inference, marked inferred", () => {
    const login = ev(ACCT_A, ORG_X, "config-login", "inferred");
    const r = resolveAccount([inferredFrom(login, "config-login", 1)]);
    expect(r.account).toEqual({ id: accountId(ACCT_A, ORG_X), orgKnown: true, source: "config-login", quality: "inferred" });
  });
});

const limit = (kind: string, used: number, observedAt: string, extra: Partial<LimitSnapshot> = {}): LimitSnapshot => ({
  agent: "claude-code",
  kind,
  usedPercent: used,
  observedAt,
  source: "spool",
  ...extra,
});

const NOW_MS = Date.parse("2026-11-01T16:30:00Z");

describe("pickLimits", () => {
  const a = ev(ACCT_A, ORG_X, "claude-app-folder", "recorded").ref;
  const b = ev(ACCT_B, ORG_Y, "claude-app-folder", "recorded").ref;

  test("two accounts never share a gauge", () => {
    const out = pickLimits(
      [
        { snap: limit("five_hour", 40, "2026-11-01T16:00:00Z", { account: a, resetsAt: "2026-11-01T18:00:00Z" }) },
        { snap: limit("five_hour", 90, "2026-11-01T16:05:00Z", { account: b, resetsAt: "2026-11-01T19:00:00Z" }) },
      ],
      NOW_MS,
    );
    expect(out.map((l) => [l.account?.id, l.usedPercent])).toEqual(
      [
        [a.id, 40],
        [b.id, 90],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  });

  test("unknown account is its own group, sorted last", () => {
    const out = pickLimits(
      [
        { snap: limit("five_hour", 10, "2026-11-01T10:00:00Z") },
        { snap: limit("five_hour", 20, "2026-11-01T09:00:00Z", { account: a }) },
      ],
      NOW_MS,
    );
    expect(out.map((l) => l.usedPercent)).toEqual([20, 10]);
    expect(out[1]!.account).toBeUndefined();
  });

  test("a window that hasn't reset beats a newer reading of one that has", () => {
    const out = pickLimits(
      [
        { snap: limit("five_hour", 55, "2026-11-01T14:00:00Z", { account: a, resetsAt: "2026-11-01T18:00:00Z" }) },
        { snap: limit("five_hour", 97, "2026-11-01T16:00:00Z", { account: a, resetsAt: "2026-11-01T15:00:00Z" }) },
      ],
      NOW_MS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.usedPercent).toBe(55);
  });

  test("two current windows in one group (a login changed): the newest reading wins, not the later reset", () => {
    const out = pickLimits(
      [
        { snap: limit("seven_day", 70, "2026-11-01T10:00:00Z", { account: a, resetsAt: "2026-11-06T00:00:00Z" }) },
        { snap: limit("seven_day", 10, "2026-11-01T16:29:00Z", { account: a, resetsAt: "2026-11-03T00:00:00Z" }) },
      ],
      NOW_MS,
    );
    expect(out[0]!.usedPercent).toBe(10);
  });

  test("same window: newest reading, then higher seq", () => {
    const w = { account: a, resetsAt: "2026-11-01T18:00:00Z" };
    expect(
      pickLimits(
        [
          { snap: limit("five_hour", 1, "2026-11-01T16:00:00Z", w) },
          { snap: limit("five_hour", 2, "2026-11-01T16:01:00Z", w) },
        ],
        NOW_MS,
      )[0]!.usedPercent,
    ).toBe(2);
    expect(
      pickLimits(
        [
          { snap: limit("five_hour", 3, "2026-11-01T16:00:00Z", w), seq: 9 },
          { snap: limit("five_hour", 4, "2026-11-01T16:00:00Z", w), seq: 2 },
        ],
        NOW_MS,
      )[0]!.usedPercent,
    ).toBe(3);
  });

  test("readings too old to show are dropped, so an old spool makes no group of its own", () => {
    const out = pickLimits(
      [
        { snap: limit("seven_day", 20, "2026-11-01T16:00:00Z", { account: a, resetsAt: "2026-11-05T00:00:00Z" }) },
        // Its window reset more than a day ago.
        { snap: limit("seven_day", 88, "2026-09-20T10:00:00Z", { resetsAt: "2026-09-25T00:00:00Z" }) },
        // No reset time, and over 8 days old.
        { snap: limit("five_hour", 50, "2026-10-20T10:00:00Z") },
        // Reset an hour ago: still shown, as "reset passed".
        { snap: limit("five_hour", 30, "2026-11-01T10:00:00Z", { account: a, resetsAt: "2026-11-01T15:30:00Z" }) },
      ],
      NOW_MS,
    );
    expect(out.map((l) => [l.kind, l.usedPercent, l.account ? "a" : "unknown"])).toEqual([
      ["five_hour", 30, "a"],
      ["seven_day", 20, "a"],
    ]);
    expect(isExpiredReading({ observedAt: "2026-11-01T16:00:00Z" }, NOW_MS)).toBe(false);
  });
});

describe("labels and the directory", () => {
  const idA = accountId(ACCT_A, ORG_X);
  const idB = accountId(ACCT_B, ORG_Y);

  test("parseAccountLabels keeps valid ids and sanitized labels only", () => {
    const text = JSON.stringify({ v: 1, labels: { [idA]: "  Max\nplan\u0007 ", [idB]: "", "acct-XYZ": "bad id", other: 3 }, extra: true });
    expect(parseAccountLabels(text)).toEqual({ [idA]: "Max plan" });
    expect(parseAccountLabels("{not json")).toEqual({});
    expect(parseAccountLabels("[]")).toEqual({});
    expect(parseAccountLabels(JSON.stringify({ labels: { [idA]: "x".repeat(200) } }))[idA]!.length).toBeLessThanOrEqual(40);
  });

  test("accountDirectory merges sightings, labels and live counts", () => {
    const a = ev(ACCT_A, ORG_X, "claude-app-folder", "recorded").ref;
    const aLogin = ev(ACCT_A, ORG_X, "config-login", "inferred").ref;
    const b = ev(ACCT_B, undefined, "transcript", "recorded").ref;
    const dir = finishAccounts(accountDirectory([{ ref: a, claudeAppFolder: true }, { ref: aLogin, loginConfigDir: "/Users/test/.claude" }, { ref: b }]), {
      labels: { [idA]: "Max" },
      live: [{ account: a }, { account: a }, {}],
    });
    expect(dir).toEqual([
      { id: idA, orgKnown: true, label: "Max", sources: ["claude-app-folder", "config-login"], loginConfigDirs: ["/Users/test/.claude"], claudeAppFolder: true, liveSessions: 2 },
      { id: b.id, orgKnown: false, sources: ["transcript"] },
    ]);
  });

  test("an account only a live session names is still listed", () => {
    const c = ev(ACCT_B, ORG_X, "transcript", "recorded").ref;
    expect(finishAccounts([], { live: [{ account: c }] })).toEqual([{ id: c.id, orgKnown: true, sources: ["transcript"], liveSessions: 1 }]);
  });
});

describe("history carries the account", () => {
  const base: HistorySession = {
    agent: "claude-code",
    sessionId: "11111111-1111-4111-8111-111111111111",
    titleSource: "none",
    startedAt: "2026-11-01T10:00:00Z",
    lastActivityAt: "2026-11-01T11:00:00Z",
    records: [],
  };

  test("an app record's folder joins a transcript session's own evidence", () => {
    const app: AppSessionRecord = {
      agent: "claude-code",
      appSessionId: "local_abc",
      agentSessionId: base.sessionId,
      lastActivityAt: "2026-11-01T11:00:00Z",
      accountEvidence: ev(ACCT_A, ORG_X, "claude-app-folder", "recorded", Date.parse("2026-11-01T11:00:00Z")),
    };
    const merged = mergeAppSessions([{ ...base, accountEvidence: [ev(ACCT_A, undefined, "transcript", "recorded", 1)] }], [app]);
    const snap = buildHistory({ sessions: merged, tables: [] });
    expect(snap.entries[0]!.account?.id).toBe(accountId(ACCT_A, ORG_X));
    expect(snap.entries[0]!.accountConflict).toBeUndefined();
  });

  test("no evidence: no account key at all", () => {
    const snap = buildHistory({ sessions: [base], tables: [] });
    expect("account" in snap.entries[0]!).toBe(false);
  });

  test("app-only session keeps the folder's account", () => {
    const app: AppSessionRecord = {
      agent: "claude-code",
      appSessionId: "local_def",
      createdAt: "2026-11-01T09:00:00Z",
      accountEvidence: ev(ACCT_B, ORG_Y, "claude-app-folder", "recorded"),
    };
    const snap = buildHistory({ sessions: mergeAppSessions([], [app]), tables: [] });
    expect(snap.entries[0]!.account?.id).toBe(accountId(ACCT_B, ORG_Y));
  });
});

describe("resume commands across config dirs", () => {
  test("plain for the default dir, with CLAUDE_CONFIG_DIR (quoted) otherwise", async () => {
    const { claudeResumePrefix, shellQuote } = await import("../src/index.ts");
    const home = "/Users/test/.claude";
    expect(claudeResumePrefix(undefined, home, home)).toBe("claude --resume");
    expect(claudeResumePrefix("/Users/test/.claude/", home, home)).toBe("claude --resume");
    expect(claudeResumePrefix("/Users/test/.claude-team", home, home)).toBe("CLAUDE_CONFIG_DIR='/Users/test/.claude-team' claude --resume");
    // Started with another primary: ~/.claude's sessions need the variable unset, not set to ~/.claude.
    expect(claudeResumePrefix(home, "/Users/test/.claude-work", home)).toBe("env -u CLAUDE_CONFIG_DIR claude --resume");
    expect(shellQuote("/Users/o'reilly/x")).toBe("'/Users/o'\\''reilly/x'");
  });
});
