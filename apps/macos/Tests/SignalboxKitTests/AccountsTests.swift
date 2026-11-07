import Foundation
import Testing
@testable import SignalboxKit

// Accounts on the app side: decoding, names and labels, History's account filter, one limit card (and one alert)
// per account, the menu bar's prefix, and the CLI flags for extra config folders. Synthetic ids only.

private let max = "acct-aaaaaaaaaaaa"
private let team = "acct-bbbbbbbbbbbb"
private func ref(_ id: String, inferred: Bool = false) -> AccountRef {
    AccountRef(id: id, orgKnown: true, source: inferred ? "config-login" : "claude-app-folder", quality: inferred ? "inferred" : "recorded")
}

@Suite("Accounts")
@MainActor
struct AccountsTests {
    let t0 = date("2026-10-09T14:30:00Z")

    // MARK: Decoding

    @Test func theFixturesCarryAccounts() throws {
        let snap = try TestPaths.loadSnapshot()
        let accounts = try #require(snap.fleet.accounts)
        #expect(accounts.map(\.label) == ["Max", "Team"])
        #expect(snap.fleet.sessions.compactMap(\.account).count >= 3)
        #expect(snap.fleet.sessions.contains { $0.agent == .claudeCode && $0.account == nil }, "an unknown-account session")
        #expect(Set(snap.fleet.limits.compactMap(\.account?.id)).count == 2)
        let history = try TestPaths.loadHistory()
        #expect(history.entries.contains { $0.accountConflict == true })
        #expect(history.entries.contains { $0.account?.orgKnown == false })
        #expect(history.entries.contains { $0.account?.isInferred == true && $0.configDir?.hasSuffix(".claude-team") == true })
    }

    @Test func aBadAccountReadsAsUnknownQualityAndNeverDropsTheRow() throws {
        let json = #"{"generatedAt":"2026-10-09T14:30:00Z","sessions":[{"agent":"claude-code","sessionId":"s1","status":"idle","account":{"id":"acct-aaaaaaaaaaaa"}}],"limits":[],"compactions":[],"health":[]}"#
        let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        let a = try #require(fleet.sessions.first?.account)
        #expect(a.isInferred, "a missing quality is the weaker claim")
        #expect(a.orgKnown == false)
        #expect(fleet.accounts == nil, "no accounts key: a CLI from before accounts")
    }

    // MARK: Names and labels

    @Test func namesPreferYourLabelThenTheCLIsThenTheShortId() {
        let infos = [AccountInfo(id: max, label: "Max"), AccountInfo(id: team)]
        #expect(AccountNaming.name(max, accounts: infos) == "Max")
        #expect(AccountNaming.name(team, accounts: infos) == "bbbbbb")
        #expect(AccountNaming.name(max, accounts: infos, local: [max: "Personal"]) == "Personal")
        #expect(AccountNaming.compact("Personal Max plan") == "Person…")
        #expect(AccountNaming.compact("Team") == "Team")
        #expect(AccountNaming.sanitize("  Team\n\u{0007}seat \u{202E}x ") == "Team seat x")
        #expect(AccountNaming.sanitize(" \n ") == nil)
        #expect((AccountNaming.sanitize(String(repeating: "a", count: 90)) ?? "").count == AccountNaming.maxLabelLength)
    }

    @Test func renamingSavesTheLabelsAndKeepsTheOnesTheCLIReported() throws {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let labels = InMemoryAccountLabels()
        store.useAccountLabels(labels)
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, accounts: [AccountInfo(id: max, label: "Max"), AccountInfo(id: team)]))))
        try store.renameAccount(team, to: "  Team ")
        #expect(labels.labels == [max: "Max", team: "Team"])
        #expect(store.accountName(team) == "Team")
        try store.renameAccount(team, to: "")
        #expect(labels.labels == [max: "Max"])
        #expect(store.accountName(team) == "bbbbbb")
    }

    @Test func theLabelsFileIsPrivateAndParsedStrictly() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-labels-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = FileAccountLabels(url: dir.appendingPathComponent("sub/accounts.json"))
        try file.save([max: "Max"])
        let attrs = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect((attrs[.posixPermissions] as? Int) == 0o600)
        #expect(file.load() == [max: "Max"])
        let messy = #"{"v":1,"labels":{"acct-aaaaaaaaaaaa":" Max\n","acct-XYZ":"bad","other":"x","acct-bbbbbbbbbbbb":""}}"#
        #expect(FileAccountLabels.parse(Data(messy.utf8)) == [max: "Max"])
        #expect(FileAccountLabels.parse(Data("{nope".utf8)).isEmpty)
    }

    // MARK: History

    @Test func historyFiltersByAccountAndByUnknown() {
        let entries = [
            SessionHistoryEntry(agent: .claudeCode, sessionId: "a1", title: "one", startedAt: t0, lastActivityAt: t0, account: ref(max)),
            SessionHistoryEntry(agent: .claudeCode, sessionId: "a2", title: "two", startedAt: t0, lastActivityAt: t0, account: ref(team, inferred: true)),
            SessionHistoryEntry(agent: .claudeCode, sessionId: "a3", title: "three", startedAt: t0, lastActivityAt: t0),
            SessionHistoryEntry(agent: "codex", sessionId: "c1", title: "codex", startedAt: t0, lastActivityAt: t0),
        ]
        let ids = { (f: HistoryFilter) in HistoryBrowser.filtered(entries, filter: f, now: self.t0).map(\.sessionId) }
        #expect(ids(HistoryFilter(account: .account(team))) == ["a2"])
        #expect(Set(ids(HistoryFilter(account: .unknown))) == ["a3", "c1"])
        #expect(HistoryFilter(account: .unknown).hasFilters)
        let found = HistoryBrowser.accounts(entries)
        #expect(found.ids == [max, team])
        #expect(found.hasUnknown, "a Claude Code session without one; Codex sessions don't count")
        // The short id (as the chip's tooltip shows it) finds an account's sessions.
        #expect(ids(HistoryFilter(query: "bbbbbb")) == ["a2"])
    }

    // MARK: Limits

    private func reading(_ used: Double, _ account: AccountRef?, kind: String = "five_hour", window: Double = 300) -> LimitSnapshot {
        LimitSnapshot(agent: .claudeCode, kind: kind, usedPercent: used, resetsAt: t0.addingTimeInterval(7200), windowMinutes: window,
                      observedAt: t0.addingTimeInterval(-60), account: account)
    }

    @Test func oneGroupPerAccountUnknownLast() {
        let limits = [reading(10, nil), reading(40, ref(team)), reading(70, ref(max), kind: "seven_day", window: 10080), reading(20, ref(max))]
        let groups = LimitGroup.groups(limits) { id in id == max ? "Max" : "Team" }
        #expect(groups.map { $0.account?.id } == [max, team, nil])
        #expect(groups[0].limits.map(\.kind) == ["five_hour", "seven_day"], "shortest window first")
        #expect(Set(limits.map(\.id)).count == 4, "ids are per account")
    }

    @Test func eachAccountAlertsOnItsOwn() {
        var h = PolicyHarness()
        _ = h.step([], limits: [reading(10, ref(max)), reading(10, ref(team))], at: t0)
        let out = h.step([], limits: [reading(85, ref(max)), reading(86, ref(team))], at: t0.addingTimeInterval(15))
        #expect(out.count == 2, "one account passing 80% doesn't hide the other")
        #expect(Set(out.map(\.title)) == ["Claude Code (aaaaaa): 5-hour window at 85%", "Claude Code (bbbbbb): 5-hour window at 86%"])
    }

    @Test func oneAccountAlertsWithoutAName() {
        var h = PolicyHarness()
        _ = h.step([], limits: [reading(10, ref(max))], at: t0)
        let out = h.step([], limits: [reading(85, ref(max))], at: t0.addingTimeInterval(15))
        #expect(out.map(\.title) == ["Claude Code: 5-hour window at 85%"])
    }

    @Test func theMenuBarNamesTheAccountOnlyWhenThereAreSeveral() {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let one = FleetSnapshot(generatedAt: t0, limits: [reading(40, ref(max))], accounts: [AccountInfo(id: max, label: "Max")])
        store.handle(.message(.fleet(at: t0, one)))
        let h1 = store.highestFiveHour(now: t0)
        #expect(h1?.percent == 40)
        #expect(h1.flatMap { store.menuBarAccountPrefix($0.limit) } == nil)
        let two = FleetSnapshot(generatedAt: t0, limits: [reading(40, ref(max)), reading(72, ref(team))],
                                accounts: [AccountInfo(id: max, label: "Max"), AccountInfo(id: team, label: "Team seat")])
        store.handle(.message(.fleet(at: t0, two)))
        let h2 = store.highestFiveHour(now: t0)
        #expect(h2?.percent == 72)
        #expect(h2.flatMap { store.menuBarAccountPrefix($0.limit) } == "Team s…")
    }

    // MARK: Config folders

    @Test func extraConfigFoldersBecomeCLIFlags() {
        #expect(CLIWatchOptions().arguments.isEmpty)
        #expect(CLIWatchOptions(includeClaudeApp: false, claudeConfigDirs: ["/Users/you/.claude-team"]).arguments
            == ["--no-claude-app", "--claude-config-dir", "/Users/you/.claude-team"])
        let backend = InMemorySettings()
        let settings = SettingsStore(defaults: backend)
        settings.claudeConfigDirs = ["/Users/you/.claude-team"]
        #expect(SettingsStore(defaults: backend).watchOptions.claudeConfigDirs == ["/Users/you/.claude-team"])
        let relative = InMemorySettings(["advanced.claudeConfigDirs": ["relative/dir", "/abs"]])
        #expect(SettingsStore(defaults: relative).claudeConfigDirs == ["/abs"])
    }
}
