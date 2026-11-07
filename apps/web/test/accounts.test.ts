import { describe, expect, test } from "bun:test";
import type { LimitSnapshot } from "@signalbox/core";
import { accountName, accountTitle, limitGroups } from "../src/accounts.tsx";
import { MOCK_ACCOUNTS, mockFleet } from "../src/mock.ts";

const NOW = new Date(2026, 9, 9, 15, 30);

describe("accounts on the page", () => {
  const fleet = mockFleet(NOW);

  test("labels when set, short ids otherwise", () => {
    expect(accountName(MOCK_ACCOUNTS.max, fleet.accounts)).toBe("Max");
    expect(accountName(MOCK_ACCOUNTS.team, [])).toBe(MOCK_ACCOUNTS.team.slice(5, 11));
  });

  test("an inferred account says where it was inferred from", () => {
    expect(accountTitle({ id: MOCK_ACCOUNTS.team, orgKnown: true, source: "config-login", quality: "inferred" })).toContain("Inferred from a config dir's current login");
    expect(accountTitle({ id: MOCK_ACCOUNTS.team, orgKnown: false, source: "transcript", quality: "recorded" })).toContain("organization unknown");
  });

  test("limits group per (agent, account), unknown account last", () => {
    const unknown: LimitSnapshot = { agent: "claude-code", kind: "five_hour", usedPercent: 5, observedAt: NOW.toISOString(), source: "synthetic" };
    const groups = limitGroups([...fleet.limits.filter((l) => l.agent === "claude-code"), unknown], fleet.accounts);
    expect(groups.map((g) => [g.account ? accountName(g.account.id, fleet.accounts) : "unknown", g.limits.length])).toEqual([
      ["Max", 2],
      ["Team", 3],
      ["unknown", 1],
    ]);
  });

  test("the mock's live sessions: two under Max, one under Team, one unknown", () => {
    const live = fleet.sessions.filter((s) => s.agent === "claude-code");
    expect(live.map((s) => (s.account ? accountName(s.account.id, fleet.accounts) : "unknown"))).toEqual(["Max", "Max", "Team", "unknown"]);
  });
});
