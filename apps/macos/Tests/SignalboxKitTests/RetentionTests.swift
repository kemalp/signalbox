import Foundation
import Testing
@testable import SignalboxKit

// Transcript retention on the app side: decoding, the status against your threshold, the popover's line and the
// setting. Synthetic folders only.

@Suite("Retention")
@MainActor
struct RetentionTests {
    let t0 = date("2026-10-09T14:30:00Z")

    @Test func theFixturesCarryRetention() throws {
        let snap = try TestPaths.loadSnapshot()
        let rows = try #require(snap.fleet.retention)
        #expect(rows.map(\.configDir) == ["/Users/you/.claude", "/Users/you/.claude-team"])
        #expect(rows.map(\.effectiveDays) == [365, 30])
    }

    @Test func theRealCLIsLineCarriesEveryKindOfRow() throws {
        let text = try String(contentsOf: TestPaths.streamFixture, encoding: .utf8)
        let line = try #require(text.split(separator: "\n").first { $0.contains(#""type":"fleet""#) })
        guard case let .fleet(_, fleet) = try StreamMessage.parse(String(line)) else {
            Issue.record("not a fleet line")
            return
        }
        let rows = try #require(fleet.retention)
        #expect(rows.map { RetentionStatus.of($0, warnBelowDays: 90) } == [.ok, .invalid, .unknown])
        #expect(rows[0].sharesTranscriptsWith?.count == 1 && rows[2].sharesTranscriptsWith?.count == 1)
        #expect(rows[1].invalid == "0")
        #expect(rows[2].problem?.contains("symbolic link") == true)
    }

    @Test func decodingIsLenientButNeverGuesses() throws {
        let json = #"""
        {"generatedAt":"2026-10-09T14:30:00Z","sessions":[],"limits":[],"compactions":[],"health":[],"retention":[
          {"agent":"claude-code","configDir":"/a","source":"user","days":0,"invalid":"0","defaultDays":30},
          {"agent":"claude-code","configDir":"/b","source":"user","days":"365","defaultDays":30},
          {"agent":"claude-code","configDir":"/c","source":"default"},
          {"agent":"claude-code","configDir":"/d","source":"something-new","defaultDays":30,"problem":"x"},
          {"agent":"claude-code","configDir":"/e","days":365,"defaultDays":30},
          {"agent":"claude-code","configDir":"/f","source":"managed","defaultDays":30},
          {"agent":"claude-code","configDir":"/g","source":"user","days":1.5,"defaultDays":30},
          {"agent":"claude-code","configDir":"/h","source":"user","days":-3,"defaultDays":30}
        ]}
        """#
        let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        let rows = try #require(fleet.retention)
        #expect(rows.map(\.configDir) == ["/a", "/b", "/d", "/f", "/g", "/h"], "no defaultDays or no source: the row is dropped, not guessed")
        #expect(rows[0].days == nil && rows[0].invalid == "0")
        #expect(rows[1].days == nil, "a days value that isn't a number isn't shown as one")
        // Set in a file, but no valid number of days came through: unknown, never the default.
        for row in rows[1...] {
            #expect(row.effectiveDays == nil, "\(row.configDir)")
            #expect(RetentionStatus.of(row, warnBelowDays: 30) == .unknown, "\(row.configDir)")
            #expect(RetentionText.value(row) == "Unknown", "\(row.configDir)")
        }
        #expect(RetentionText.advice(rows[1], status: .unknown) == "Can't tell: no valid value came through for this folder.")
        let old = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(#"{"generatedAt":"2026-10-09T14:30:00Z","sessions":[],"limits":[],"compactions":[],"health":[]}"#.utf8))
        #expect(old.retention == nil, "a CLI from before retention")
    }

    @Test func statusAgainstYourThreshold() {
        let unset = RetentionInfo(configDir: "/a")
        #expect(RetentionStatus.of(unset, warnBelowDays: 90) == .short)
        #expect(RetentionStatus.of(unset, warnBelowDays: 30) == .ok)
        #expect(RetentionStatus.of(unset, warnBelowDays: 0) == .ok)
        #expect(RetentionStatus.of(RetentionInfo(configDir: "/a", days: 365, source: "user"), warnBelowDays: 365) == .ok)
        #expect(RetentionStatus.of(RetentionInfo(configDir: "/a", source: "user", invalid: "0"), warnBelowDays: 0) == .invalid)
        #expect(RetentionStatus.of(RetentionInfo(configDir: "/a", problem: "x"), warnBelowDays: 90) == .unknown)
        #expect(RetentionText.value(unset) == "30 days")
        #expect(RetentionText.value(RetentionInfo(configDir: "/a", days: 1, source: "user")) == "1 day")
    }

    @Test func whereTheValueComesFrom() {
        #expect(RetentionText.source(RetentionInfo(configDir: "/a")) == "Not set: Claude Code's default")
        #expect(RetentionText.source(RetentionInfo(configDir: "/a", days: 365, source: "user", file: "/a/settings.json")) == "Set in settings.json")
        #expect(RetentionText.source(RetentionInfo(configDir: "/a", days: 14, source: "managed", file: "/m/managed-settings.json")) == "Set by your organization's managed settings")
        #expect(RetentionText.source(RetentionInfo(configDir: "/a", days: 14, source: "something-new")) == "From something-new")
    }

    @Test func whatToDoAboutIt() {
        let managed = RetentionInfo(configDir: "/a", days: 14, source: "managed")
        let managedAdvice = RetentionText.advice(managed, status: .short) ?? ""
        #expect(managedAdvice.contains("only they can change it"))
        #expect(managedAdvice.contains("MDM profile or console-served settings"))
        let unset = RetentionInfo(configDir: "/Users/you/.claude-team")
        let userAdvice = RetentionText.advice(unset, status: .short) ?? ""
        #expect(userAdvice.hasPrefix("Add \"cleanupPeriodDays\": 365 to /…/.claude-team/settings.json"))
        #expect(userAdvice.contains("Desktop app sessions are kept from Claude Code 2.1.248 on"))
        let invalid = RetentionText.advice(RetentionInfo(configDir: "/a", source: "user", invalid: "0"), status: .invalid) ?? ""
        #expect(invalid.contains("pauses its cleanup, so nothing is deleted"))
        #expect(!invalid.contains("fall back"))
        #expect(RetentionText.advice(RetentionInfo(configDir: "/a", problem: "/a/settings.json isn't valid JSON"), status: .unknown) == "Can't tell: /a/settings.json isn't valid JSON.")
        #expect(RetentionText.advice(RetentionInfo(configDir: "/a", days: 365, source: "user"), status: .ok) == nil)
    }

    @Test func rowsFromOtherAgentsDontTalkAboutClaudeCode() {
        let other = RetentionInfo(agent: "aider", configDir: "/Users/you/.aider", defaultDays: 7)
        #expect(RetentionText.source(other) == "Not set: aider's default")
        #expect(RetentionText.warning(other, status: .short, several: true) == "aider deletes transcripts older than 7 days in /…/.aider.")
        #expect(RetentionText.advice(other, status: .short) == nil)
        let bad = RetentionInfo(agent: "aider", configDir: "/x", source: "user", invalid: "\"x\"", defaultDays: 7)
        #expect(RetentionText.warning(bad, status: .invalid, several: false) == "aider's retention setting is invalid (\"x\").")
        #expect(RetentionText.advice(bad, status: .invalid) == nil)
    }

    @Test func thePopoverNamesTheWorstFolder() {
        let store = SignalboxStore(clock: { self.t0 })
        let fleet = FleetSnapshot(generatedAt: t0, retention: [
            RetentionInfo(configDir: "/Users/you/.claude", days: 365, source: "user"),
            RetentionInfo(configDir: "/Users/you/.claude-team"),
            RetentionInfo(configDir: "/Users/you/.claude-x", days: 60, source: "user"),
            RetentionInfo(configDir: "/Users/you/.claude-broken", problem: "unreadable"),
        ])
        store.handle(.message(.fleet(at: t0, fleet)))
        let line = store.retentionWarning(warnBelowDays: 90)
        #expect(line == "Claude Code deletes terminal transcripts older than 30 days in /…/.claude-team.", "the shortest of the short ones")
        #expect(store.retentionWarning(warnBelowDays: 30) == nil)
        #expect(store.retentionWarning(warnBelowDays: 0) == nil, "the check is off")
        // A managed value covers desktop sessions too; one day is singular; one folder alone isn't named.
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, retention: [RetentionInfo(configDir: "/a", days: 1, source: "managed")]))))
        #expect(store.retentionWarning(warnBelowDays: 90) == "Claude Code deletes transcripts older than 1 day.")
    }

    @Test func anInvalidValueBeatsAShortOne() {
        let store = SignalboxStore(clock: { self.t0 })
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, retention: [
            RetentionInfo(configDir: "/Users/you/.claude-short", days: 7, source: "user"),
            RetentionInfo(configDir: "/Users/you/.claude-bad", source: "user", invalid: "\"30\""),
            RetentionInfo(configDir: "/Users/you/.claude-team"),
        ]))))
        #expect(store.retentionWarning(warnBelowDays: 90) == "Claude Code's cleanupPeriodDays in /…/.claude-bad is invalid (\"30\").")
        // Never warn turns the line off, invalid values included; Health still lists them.
        #expect(store.retentionWarning(warnBelowDays: 0) == nil)
        #expect(store.retention(warnBelowDays: 0).map(\.status) == [.ok, .invalid, .ok])
    }

    @Test func theThresholdSettingDefaultsTo90AndRefusesOddValues() {
        let backend = InMemorySettings()
        let settings = SettingsStore(defaults: backend)
        #expect(settings.retentionWarnDays == 90)
        settings.retentionWarnDays = 180
        #expect(SettingsStore(defaults: backend).retentionWarnDays == 180)
        #expect(SettingsStore(defaults: InMemorySettings(["advanced.retentionWarnDays": 17])).retentionWarnDays == 90)
        #expect(SettingsStore(defaults: InMemorySettings(["advanced.retentionWarnDays": 0])).retentionWarnDays == 0)
        settings.resetAll()
        #expect(settings.retentionWarnDays == 90)
    }
}
