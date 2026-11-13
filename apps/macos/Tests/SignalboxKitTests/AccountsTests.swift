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

    @Test func theReportSplitsUsageByAccount() throws {
        let snap = try TestPaths.loadSnapshot()
        let rows = try #require(snap.report.byAccount)
        #expect(snap.report.accountAgents == ["claude-code"])
        #expect(rows.map(\.key).contains(max) == false, "fixture ids are hashes, not the test's ids")
        let ids = Set(try #require(snap.fleet.accounts).map(\.id))
        #expect(rows.filter { $0.key != Report.unknownAccount }.allSatisfy { ids.contains($0.key) })
        let claude = try #require(snap.report.byAgent.first { $0.key == "claude-code" })
        #expect(abs(rows.reduce(0) { $0 + $1.cost.total } - claude.cost.total) < 1e-9)
        #expect(rows.reduce(0) { $0 + $1.responses } == claude.responses)
        #expect(rows.contains { ($0.inferredSessions ?? 0) > 0 })
        #expect(snap.report.byDay.contains { !($0.byAccount ?? []).isEmpty })
    }

    @Test func accountUsageIsTheAccountsRowOrAnEmptyOneAndNilWithoutByAccount() throws {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        var snap = try TestPaths.loadSnapshot()
        store.load(snapshot: snap, name: "fixture")
        let first = try #require(snap.report.byAccount?.first)
        #expect(store.accountUsage(first.key)?.cost.total == first.cost.total)
        let none = try #require(store.accountUsage("acct-cccccccccccc"))
        #expect(none.responses == 0)
        #expect(none.sessions == 0)
        snap.report.byAccount = nil
        store.load(snapshot: snap, name: "old CLI")
        #expect(store.accountUsage(first.key) == nil, "a CLI from before byAccount: unknown, not zero")
    }

    @Test func byAccountIsOptionalAndKeepsItsSessionCounts() throws {
        let json = #"{"generatedAt":"2026-10-09T14:30:00Z","totals":{"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0,"webSearch":0,"total":0},"responses":0,"placeholderResponses":0,"unpricedTokens":0,"unpricedModels":[],"processedTokens":0,"freshTokens":0,"cacheHitRatio":0,"savedByCachingUsd":0},"byAgent":[],"byModel":[],"byProject":[],"byKind":[],"byDay":[],"reconciliation":[],"priceTables":[],"notes":[]}"#
        let old = try SignalboxJSON.decoder().decode(Report.self, from: Data(json.utf8))
        #expect(old.byAccount == nil)
        let row = #"{"key":"unknown","tokens":{"input":1,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0,"webSearch":0,"total":0},"responses":1,"placeholderResponses":0,"unpricedTokens":0,"unpricedModels":[],"sessions":2,"inferredSessions":0,"conflictSessions":1}"#
        let g = try SignalboxJSON.decoder().decode(GroupTotals.self, from: Data(row.utf8))
        #expect(g.key == Report.unknownAccount)
        #expect(g.sessions == 2 && g.inferredSessions == 0 && g.conflictSessions == 1)
    }

    @Test func aBadAccountReadsAsUnknownQualityAndNeverDropsTheRow() throws {
        let json = #"{"generatedAt":"2026-10-09T14:30:00Z","sessions":[{"agent":"claude-code","sessionId":"s1","status":"idle","account":{"id":"acct-aaaaaaaaaaaa"}}],"limits":[],"compactions":[],"health":[]}"#
        let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        let a = try #require(fleet.sessions.first?.account)
        #expect(a.isInferred, "a missing quality is the weaker claim")
        #expect(a.orgKnown == false)
        #expect(fleet.accounts == nil, "no accounts key: a CLI from before accounts")
    }

    @Test func anUnreadableAccountIsUnknownAndKeepsItsRow() throws {
        let json = #"{"generatedAt":"2026-10-09T14:30:00Z","sessions":[{"agent":"claude-code","sessionId":"s1","status":"idle","account":{"source":"transcript"}},{"agent":"claude-code","sessionId":"s2","status":"idle","account":"acct-aaaaaaaaaaaa"}],"limits":[{"agent":"claude-code","kind":"five_hour","usedPercent":40,"observedAt":"2026-10-09T14:29:00Z","account":{"id":7}}],"compactions":[],"health":[]}"#
        let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        #expect(fleet.sessions.map(\.sessionId) == ["s1", "s2"])
        #expect(fleet.sessions.allSatisfy { $0.account == nil })
        #expect(fleet.limits.count == 1)
        #expect(fleet.limits.first?.account == nil)
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

    @Test func renamingSavesTheLabelsAndKeepsTheOnesAnotherCopySaved() throws {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let labels = InMemoryAccountLabels(shared: true)
        store.useAccountLabels(labels)
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, accounts: [AccountInfo(id: max), AccountInfo(id: team)]))))
        // Another copy of the app saves a label after this one loaded the file.
        try labels.save([max: "Max"])
        try store.renameAccount(team, to: "  Team ")
        #expect(labels.labels == [max: "Max", team: "Team"])
        #expect(store.accountName(team) == "Team")
        try store.renameAccount(team, to: "")
        #expect(labels.labels == [max: "Max"])
        #expect(store.accountName(team) == "bbbbbb")
    }

    @Test func aClearedLabelNeitherShowsNorComesBack() throws {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let labels = InMemoryAccountLabels([max: "Max"], shared: true)
        store.useAccountLabels(labels)
        // The CLI read the file before the label was cleared.
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, accounts: [AccountInfo(id: max, label: "Max"), AccountInfo(id: team)]))))
        try store.renameAccount(max, to: nil)
        #expect(store.accountName(max) == "aaaaaa", "the CLI's copy is a fleet behind")
        try store.renameAccount(team, to: "Team")
        #expect(labels.labels == [team: "Team"], "the cleared label isn't written back")
    }

    @Test func aLabelAnotherCopySavedShowsOnTheNextFleet() throws {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let labels = InMemoryAccountLabels(shared: true)
        store.useAccountLabels(labels)
        try labels.save([team: "Team"])
        #expect(store.accountName(team) == "bbbbbb")
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, accounts: [AccountInfo(id: team, label: "Team")]))))
        #expect(store.accountName(team) == "Team")
    }

    @Test func withoutTheSharedFileTheCLIsLabelsFillTheGaps() {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        store.useAccountLabels(InMemoryAccountLabels())
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, accounts: [AccountInfo(id: max, label: "Max")]))))
        #expect(store.accountName(max) == "Max")
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

    @Test func aSaveIntoAnExistingFolderIsPrivateFromTheStart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-labels-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = FileAccountLabels(url: dir.appendingPathComponent("accounts.json"))
        try "{}".write(to: file.url, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.url.path)
        try file.save([team: "Team"])
        #expect((try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? Int) == 0o600)
        #expect(file.load() == [team: "Team"])
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["accounts.json"], "no temporary file left behind")
    }

    @Test func theLabelsFileFollowsHOMELikeTheCLI() {
        #expect(FileAccountLabels.defaultURL(environment: ["HOME": "/tmp/h"]).path == "/tmp/h/Library/Application Support/signalbox/accounts.json")
        #expect(FileAccountLabels.defaultURL(environment: ["HOME": "/tmp/h", "SIGNALBOX_ACCOUNTS_FILE": "/tmp/x.json"]).path == "/tmp/x.json")
    }

    @Test func anIdThatIsntAHashIsUnknown() throws {
        for bad in ["someone@example.invalid", "", "acct-ABCDEFABCDEF", "0a0a0a0a-1111-4111-8111-00000000000a"] {
            let json = #"{"generatedAt":"2026-10-09T14:30:00Z","sessions":[{"agent":"claude-code","sessionId":"s1","status":"idle","account":{"id":"\#(bad)","orgKnown":true,"source":"transcript","quality":"recorded"}}],"limits":[],"compactions":[],"health":[],"accounts":[{"id":"\#(bad)","sources":[]},{"id":"acct-aaaaaaaaaaaa","sources":[]}]}"#
            let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
            #expect(fleet.sessions.count == 1)
            #expect(fleet.sessions.first?.account == nil, "\(bad)")
            #expect(fleet.accounts?.map(\.id) == [max])
        }
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
        #expect(ids(HistoryFilter(account: .unknown)) == ["a3"], "Codex reports no accounts, so it is never unknown")
        #expect(HistoryFilter(account: .unknown).hasFilters)
        let found = HistoryBrowser.accounts(entries)
        #expect(found.ids == [max, team])
        #expect(found.hasUnknown, "a Claude Code session without one; Codex sessions don't count")
        // The short id (as the chip's tooltip shows it) finds an account's sessions.
        #expect(ids(HistoryFilter(query: "bbbbbb")) == ["a2"])
    }

    @Test func anAccountSearchKeepsArchivedSessionsHidden() {
        let entries = [
            SessionHistoryEntry(agent: .claudeCode, sessionId: "a1", title: "one", startedAt: t0, lastActivityAt: t0, responses: 3, account: ref(team)),
            SessionHistoryEntry(agent: .claudeCode, sessionId: "a2", title: "two", startedAt: t0, lastActivityAt: t0, responses: 3, archived: true, account: ref(team)),
        ]
        let ids = { (f: HistoryFilter) in HistoryBrowser.filtered(entries, filter: f, now: self.t0).map(\.sessionId) }
        #expect(ids(HistoryFilter(query: "bbbbbb")) == ["a1"])
        #expect(Set(ids(HistoryFilter(query: "bbbbbb", showArchived: true))) == ["a1", "a2"])
    }

    @Test func unknownAccountsCountLiveSessionsOnce() {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let live = FleetSession(agent: .claudeCode, sessionId: "s1", status: .busy)
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, sessions: [live]))))
        store.load(history: HistorySnapshot(entries: [
            SessionHistoryEntry(agent: .claudeCode, sessionId: "s1", startedAt: t0, lastActivityAt: t0, live: true),
            SessionHistoryEntry(agent: .claudeCode, sessionId: "s2", startedAt: t0, lastActivityAt: t0),
            SessionHistoryEntry(agent: "codex", sessionId: "c1", startedAt: t0, lastActivityAt: t0),
        ]))
        #expect(store.unknownAccountCounts == (live: 1, past: 1))
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

    @Test func aReadingWhoseAccountTurnsUpLaterDoesntAlertAgain() {
        var h = PolicyHarness()
        var r = reading(85, nil)
        r.sessionId = "s1"
        // Already past 80% at app start: recorded, not notified.
        #expect(h.step([], limits: [r], at: t0).isEmpty)
        // The same session's window, now with its account (found, or completed, a moment later).
        var known = r
        known.account = ref(max)
        known.observedAt = r.observedAt.addingTimeInterval(15)
        #expect(h.step([], limits: [known], at: t0.addingTimeInterval(15)).isEmpty)
        // And back again (a partial id the completion no longer applies to): still nothing new.
        var back = known
        back.account = AccountRef(id: max, orgKnown: false, source: "transcript", quality: "recorded")
        back.observedAt = known.observedAt.addingTimeInterval(15)
        #expect(h.step([], limits: [back], at: t0.addingTimeInterval(30)).isEmpty)
        // A threshold not passed yet still alerts, once.
        var higher = back
        higher.usedPercent = 96
        higher.observedAt = back.observedAt.addingTimeInterval(15)
        #expect(h.step([], limits: [higher], at: t0.addingTimeInterval(45)).count == 1)
    }

    @Test func anotherSessionUnderANewAccountStillAlerts() {
        var h = PolicyHarness()
        var a = reading(85, nil)
        a.sessionId = "s1"
        _ = h.step([], limits: [a], at: t0)
        var b = reading(85, ref(team))
        b.sessionId = "s2"
        b.observedAt = a.observedAt.addingTimeInterval(15)
        #expect(h.step([], limits: [a, b], at: t0.addingTimeInterval(15)).count == 1)
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
