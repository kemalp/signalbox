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

    @Test func decodingIsLenientButNeverGuesses() throws {
        let json = #"""
        {"generatedAt":"2026-10-09T14:30:00Z","sessions":[],"limits":[],"compactions":[],"health":[],"retention":[
          {"agent":"claude-code","configDir":"/a","source":"user","days":0,"invalid":"0","defaultDays":30},
          {"agent":"claude-code","configDir":"/b","source":"user","days":"365","defaultDays":30},
          {"agent":"claude-code","configDir":"/c","source":"default"},
          {"agent":"claude-code","configDir":"/d","source":"something-new","defaultDays":30,"problem":"x"}
        ]}
        """#
        let fleet = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        let rows = try #require(fleet.retention)
        #expect(rows.map(\.configDir) == ["/a", "/b", "/d"], "no defaultDays: the row is dropped, not guessed")
        #expect(rows[0].days == nil && rows[0].invalid == "0")
        #expect(rows[1].days == nil, "a days value that isn't a number isn't shown as one")
        #expect(rows[1].effectiveDays == 30)
        #expect(rows[2].effectiveDays == nil)
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
        #expect(RetentionText.source(unset) == "Not set: Claude Code's default")
        #expect(RetentionText.advice(RetentionInfo(configDir: "/a", days: 14, source: "managed"), status: .short)?.contains("only they can change it") == true)
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
        #expect(line?.hasPrefix("Claude Code deletes transcripts older than 30 days in ") == true, "the shortest of the short ones")
        #expect(line?.hasSuffix(".claude-team.") == true)
        #expect(store.retentionWarning(warnBelowDays: 30) == nil)
        #expect(store.retentionWarning(warnBelowDays: 0) == nil, "the check is off")
        // An invalid value beats a short one; one folder alone isn't named.
        store.handle(.message(.fleet(at: t0, FleetSnapshot(generatedAt: t0, retention: [RetentionInfo(configDir: "/a", source: "user", invalid: "\"30\"")]))))
        #expect(store.retentionWarning(warnBelowDays: 90) == "Claude Code's cleanupPeriodDays is invalid (\"30\").")
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
