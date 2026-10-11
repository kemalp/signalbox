import Foundation
import Testing
@testable import SignalboxKit

func context(tokens: Double, window: Double? = nil, percent: Double? = nil, autoCompact: Double? = nil, quality: ContextQuality = .official, windowSource: String? = nil) -> ContextSnapshot {
    ContextSnapshot(agent: .claudeCode, sessionId: "s", tokens: tokens, window: window, percent: percent, autoCompactAtPercent: autoCompact,
                    observedAt: date("2026-10-09T14:29:00Z"), quality: quality, source: "tap", windowSource: windowSource)
}

@Suite("Context gauge")
struct ContextGaugeTests {
    @Test func fillsByPercentWithTheAutoCompactTick() {
        let m = ContextGaugeModel(context(tokens: 319_000, window: 1_000_000, autoCompact: 97))
        #expect(m.caption == "319K of 1M (32%)")
        #expect(abs((m.fraction ?? 0) - 0.319) < 1e-9)
        #expect(m.tickFraction == 0.97)
        #expect(m.tickLabel == "auto-compact at 97%")
        #expect(m.severity == .ok)
        #expect(m.quality == .official)
        #expect(m.accessibilityValue.contains("auto-compact at 97%"))
        #expect(m.accessibilityValue.contains("reported by the agent"))
    }

    @Test func theAgentsOwnPercentWins() {
        // 96.7 rounds to "97%" in the tick label, as on screen.
        let m = ContextGaugeModel(context(tokens: 412_300, window: 1_000_000, percent: 41.2, autoCompact: 96.7))
        #expect(m.percent == 41.2)
        #expect(m.caption == "412K of 1M (41%)")
        #expect(m.tickLabel == "auto-compact at 97%")
        #expect(abs((m.tickFraction ?? 0) - 0.967) < 1e-9)
    }

    static let thresholdCases: [(percent: Double, autoCompact: Double?, expected: Fmt.Severity)] = [
        (74.9, 96.7, .ok),
        (75, 96.7, .warn),
        (89.9, 96.7, .warn),
        (90, 96.7, .crit),   // min(90, 96.7 - 5) = 90
        (74, nil, .ok),
        (80, nil, .warn),
        (90, nil, .crit),
        (76, 80, .crit),     // auto-compaction at 80% turns red at 75%, so amber never shows
        (74.9, 80, .ok),
        (82, 88, .warn),     // red from 83%
        (83, 88, .crit),
    ]

    @Test(arguments: thresholdCases)
    func colourThresholds(percent: Double, autoCompact: Double?, expected: Fmt.Severity) {
        let m = ContextGaugeModel(context(tokens: percent * 10_000, window: 1_000_000, percent: percent, autoCompact: autoCompact))
        #expect(m.severity == expected)
        #expect(m.warnAt <= m.critAt)
    }

    @Test func redStartsFivePointsBeforeAutoCompaction() {
        #expect(ContextGaugeModel(context(tokens: 1, window: 10, autoCompact: 96.7)).critAt == 90)
        #expect(ContextGaugeModel(context(tokens: 1, window: 10, autoCompact: 88)).critAt == 83)
        #expect(ContextGaugeModel(context(tokens: 1, window: 10)).critAt == 90)
    }

    @Test func unknownWindowDrawsAnEmptyTrack() {
        let m = ContextGaugeModel(context(tokens: 88_400, quality: .estimated))
        #expect(m.fraction == nil)
        #expect(m.percent == nil)
        #expect(m.caption == "88.4K · window unknown")
        #expect(m.tickFraction == nil)
        #expect(m.accessibilityValue == "88.4K tokens, window size unknown, estimated")
    }

    @Test func noContextIsUnknownNotZero() {
        let m = ContextGaugeModel(nil)
        #expect(m.fraction == nil)
        #expect(m.caption == "Context unknown")
        #expect(m.quality == nil)
        #expect(m.accessibilityValue == "unknown")
    }

    @Test func percentWithoutAWindow() {
        let m = ContextGaugeModel(context(tokens: 412_000, percent: 41))
        #expect(m.caption == "412K (41%)")
        #expect(m.fraction == 0.41)
    }

    @Test func overfullClampsTheBarButNotTheText() {
        let m = ContextGaugeModel(context(tokens: 1_034_000, window: 1_000_000, percent: 103.4, autoCompact: 96.7))
        #expect(m.fraction == 1)
        #expect(m.caption == "1.03M of 1M (103%)")
        #expect(m.severity == .crit)
    }

    @Test func aZeroWindowIsUnknown() {
        let m = ContextGaugeModel(context(tokens: 5_000, window: 0))
        #expect(m.fraction == nil)
        #expect(m.caption == "5K · window unknown")
    }
}

@Suite("Limits honesty")
struct LimitPresentationTests {
    let now = date("2026-10-09T14:30:00Z")

    func limit(used: Double = 63, observedAgo: TimeInterval = 60, resetsIn: TimeInterval? = 2 * 3600 + 14 * 60) -> LimitSnapshot {
        LimitSnapshot(agent: .claudeCode, kind: "five_hour", usedPercent: used, resetsAt: resetsIn.map { now.addingTimeInterval($0) },
                      windowMinutes: 300, observedAt: now.addingTimeInterval(-observedAgo), source: "tap")
    }

    @Test func aFreshReadingFills() {
        let p = LimitPresentation(limit(), now: now)
        #expect(p.state == .fresh)
        #expect(p.fillFraction == 0.63)
        #expect(p.valueText == "63%")
        #expect(p.lastValueText == nil)
        #expect(p.statusText == "resets in 2h 14m")
        #expect(p.shortStatus == nil)
    }

    @Test func aStaleReadingShowsNoFill() {
        let p = LimitPresentation(limit(used: 88, observedAgo: 8 * 86_400, resetsIn: 3 * 3600), now: now)
        #expect(p.state == .stale)
        #expect(p.fillFraction == nil)
        #expect(p.valueText == "—")
        #expect(p.lastValueText == "was 88%")
        #expect(p.statusText == "stale · as of 8d ago")
        #expect(p.shortStatus == "stale")
        #expect(p.accessibilityValue.hasPrefix("Unknown"))
    }

    @Test func aPassedResetShowsNoFill() {
        let p = LimitPresentation(limit(observedAgo: 120, resetsIn: -60), now: now)
        #expect(p.state == .resetPassed)
        #expect(p.fillFraction == nil)
        #expect(p.valueText == "—")
        #expect(p.statusText == "reset passed")
        #expect(p.lastValueText == "was 63%")
    }

    @Test func resetPassedBeatsStale() {
        #expect(LimitState.of(limit(observedAgo: 86_400, resetsIn: -1), now: now) == .resetPassed)
    }

    @Test func staleAfterFifteenMinutes() {
        #expect(LimitState.of(limit(observedAgo: 15 * 60), now: now) == .fresh)
        #expect(LimitState.of(limit(observedAgo: 15 * 60 + 1), now: now) == .stale)
        // No reset time: only age decides.
        #expect(LimitState.of(limit(observedAgo: 60, resetsIn: nil), now: now) == .fresh)
        #expect(LimitPresentation(limit(observedAgo: 60, resetsIn: nil), now: now).statusText == "reset time unknown")
    }

    @Test func overHundredClampsTheFill() {
        #expect(LimitPresentation(limit(used: 104), now: now).fillFraction == 1)
        #expect(LimitPresentation(limit(used: 104), now: now).valueText == "104%")
    }
}

@Suite("Decoding newer context fields")
struct ContextDecodingTests {
    func decode(_ json: String) throws -> FleetSnapshot {
        try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
    }

    func fleet(context: String) -> String {
        """
        {"generatedAt":"2026-10-09T14:30:00Z","sessions":[{"agent":"claude-code","sessionId":"s","status":"busy","source":"t",
          "context":\(context)}],"limits":[],"compactions":[],"health":[]}
        """
    }

    @Test func readsWindowSourceWhenPresent() throws {
        let f = try decode(fleet(context: #"{"agent":"claude-code","sessionId":"s","tokens":88400,"window":1000000,"windowSource":"model-table","percent":8.8,"autoCompactAtPercent":96.7,"observedAt":"2026-10-09T14:26:00Z","quality":"estimated","source":"transcript"}"#))
        let c = try #require(f.sessions.first?.context)
        #expect(c.windowSource == "model-table")
        #expect(Fmt.windowSourceLabel(c.windowSource) == "documented size for the model")
        #expect(c.percent == 8.8)
        // And writes it back (the contract tests compare key paths).
        let census = try KeyPathCensus(encoding: f)
        #expect(census.counts["sessions[].context.windowSource"] == 1)
    }

    @Test func toleratesItsAbsence() throws {
        let f = try decode(fleet(context: #"{"agent":"codex","sessionId":"s","tokens":128000,"window":272000,"observedAt":"2026-10-09T14:21:00Z","quality":"estimated","source":"rollout"}"#))
        let c = try #require(f.sessions.first?.context)
        #expect(c.windowSource == nil)
        #expect(c.autoCompactAtPercent == nil)
        let census = try KeyPathCensus(encoding: f)
        #expect(census.counts["sessions[].context.windowSource"] == nil)
    }

    @Test func aMalformedOptionalFieldDoesNotCostTheContext() throws {
        let f = try decode(fleet(context: #"{"agent":"claude-code","sessionId":"s","tokens":5,"window":"big","windowSource":{"kind":"agent"},"autoCompactAtPercent":"soon","observedAt":"2026-10-09T14:26:00Z","quality":"psychic","source":"x"}"#))
        let c = try #require(f.sessions.first?.context)
        #expect(c.window == nil)
        #expect(c.windowSource == nil)
        #expect(c.autoCompactAtPercent == nil)
        #expect(c.quality == .unknown)
        #expect(c.tokens == 5)
    }

    @Test func windowSourceLabels() {
        #expect(Fmt.windowSourceLabel("agent") == "reported by the agent")
        #expect(Fmt.windowSourceLabel("model-table") == "documented size for the model")
        #expect(Fmt.windowSourceLabel("something-new") == "something-new")
        #expect(Fmt.windowSourceLabel(nil) == nil)
        #expect(Fmt.windowSourceLabel("") == nil)
    }
}
