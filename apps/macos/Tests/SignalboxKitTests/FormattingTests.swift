import Foundation
import Testing
@testable import SignalboxKit

@Suite("Formatting")
struct FormattingTests {
    @Test func usd() {
        #expect(Fmt.usd(nil) == "—")
        #expect(Fmt.usd(.nan) == "—")
        #expect(Fmt.usd(0) == "$0.00")
        #expect(Fmt.usd(0.004) == "<$0.01")
        #expect(Fmt.usd(3.17) == "$3.17")
        #expect(Fmt.usd(1234.5) == "$1,234.50")
        #expect(Fmt.usdHeadline(1234.5) == "$1,235")
        #expect(Fmt.usdHeadline(42.1) == "$42.10")
        #expect(Fmt.usdHeadlineRange(1697.2, 1920.4) == "$1,697–$1,920")
        #expect(Fmt.usdHeadlineRange(938.32, 938.32) == "$938")
        #expect(Fmt.usdHeadlineRange(49.87, 49.874) == "$49.87")
        #expect(Fmt.usdHeadlineRange(nil, 10) == "—")
    }

    static let tokenCases: [(Double, String)] = [
        (0, "0"), (999, "999"), (1000, "1K"), (1500, "1.5K"), (12_345, "12.3K"),
        (999_960, "1M"), (412_300, "412K"), (1_000_000, "1M"), (88_400_000, "88.4M"),
        (1_880_000_000, "1.88B"), (-12_345, "-12.3K"),
    ]

    @Test(arguments: tokenCases)
    func tokens(value: Double, expected: String) {
        #expect(Fmt.tokens(value) == expected)
    }

    @Test func tokensUnknown() {
        #expect(Fmt.tokens(nil as Double?) == "—")
        #expect(Fmt.tokens(nil as Int?) == "—")
    }

    @Test func percentsAndRatios() {
        #expect(Fmt.percent(41.23) == "41%")
        #expect(Fmt.percent(41.25, digits: 1) == "41.2%" || Fmt.percent(41.25, digits: 1) == "41.3%")
        #expect(Fmt.percent(nil) == "—")
        #expect(Fmt.ratio(0.9681) == "96.8%")
        #expect(Fmt.count(12345) == "12,345")
    }

    static let durationCases: [(Double, String)] = [
        (0, "0s"), (45.9, "45s"), (60, "1m"), (720, "12m"), (7200, "2h"),
        (7500, "2h 5m"), (259_200, "3d"), (273_600, "3d 4h"), (-5, "0s"),
    ]

    @Test(arguments: durationCases)
    func durations(seconds: Double, expected: String) {
        #expect(Fmt.duration(seconds) == expected)
    }

    @Test func relativeTimes() {
        let now = date("2026-10-09T14:30:00Z")
        #expect(Fmt.ago(nil, now: now) == "—")
        #expect(Fmt.ago(now.addingTimeInterval(-2), now: now) == "just now")
        #expect(Fmt.ago(now.addingTimeInterval(10), now: now) == "just now")
        #expect(Fmt.ago(now.addingTimeInterval(-12), now: now) == "12s ago")
        #expect(Fmt.ago(now.addingTimeInterval(-(3 * 3600 + 300)), now: now) == "3h 5m ago")
        let day = 86_400.0
        #expect(Fmt.agoRounded(nil, now: now) == "—")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(3 * 3600 + 300)), now: now) == "3h 5m ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(6 * day + 4 * 3600)), now: now) == "6d 4h ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(25 * day + 14 * 3600)), now: now) == "25d ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(232 * day + 11 * 3600)), now: now) == "7 months ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(60 * day)), now: now) == "2 months ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(730 * day)), now: now) == "2 years ago")
        #expect(Fmt.agoRounded(now.addingTimeInterval(-(800 * day)), now: now) == "2 years ago")
        #expect(Fmt.countdown(nil, now: now) == "reset time unknown")
        #expect(Fmt.countdown(now.addingTimeInterval(-1), now: now) == "reset passed")
        #expect(Fmt.countdown(now.addingTimeInterval(2 * 3600 + 14 * 60), now: now) == "resets in 2h 14m")
    }

    @Test func pathShortening() {
        let home = "/Users/you"
        #expect(Fmt.shortPath("/Users/you/code/api-refactor", home: home) == "~/…/api-refactor")
        #expect(Fmt.shortPath("/Users/you/api", home: home) == "~/api")
        #expect(Fmt.shortPath("/Users/you", home: home) == "~")
        #expect(Fmt.shortPath("/Users/you/", home: home + "/") == "~")
        #expect(Fmt.shortPath("/Users/younger/x/y", home: home) == "/…/y")
        #expect(Fmt.shortPath("/opt/a/b/c", home: home) == "/…/c")
        #expect(Fmt.shortPath("/tmp", home: home) == "/tmp")
        #expect(Fmt.shortPath(nil, home: home) == "—")
        #expect(Fmt.shortPath("relative/dir/name", home: home) == "…/name")
    }

    @Test func labels() {
        #expect(Fmt.agentName(.claudeCode) == "Claude Code")
        #expect(Fmt.agentName(.codex) == "Codex")
        #expect(Fmt.agentName(.geminiCLI) == "Gemini")
        #expect(Fmt.agentName("cursor-agent") == "cursor-agent")
        #expect(Fmt.windowLabel(300) == "5h")
        #expect(Fmt.windowLabel(10080) == "7d")
        #expect(Fmt.windowLabel(45) == "45m")
        #expect(Fmt.windowLabel(nil) == nil)
        #expect(Fmt.windowLabel(0) == nil)
        let l = LimitSnapshot(agent: .claudeCode, kind: "seven_day_fable", usedPercent: 1, observedAt: Date())
        #expect(Fmt.limitLabel(l) == "Weekly · Fable")
        let custom = LimitSnapshot(agent: .codex, kind: "new.kind", usedPercent: 1, observedAt: Date())
        #expect(Fmt.limitLabel(custom) == "new.kind")
        #expect(Fmt.limitShortLabel(l) == "Fable")
        #expect(Fmt.limitShortLabel(LimitSnapshot(agent: .claudeCode, kind: "five_hour", usedPercent: 1, windowMinutes: 300, observedAt: Date())) == "5h")
        #expect(Fmt.limitShortLabel(custom) == "new.kind")
        // Unknown snake_case kinds read as words; a per-model label's model becomes the ring caption.
        let pool = LimitSnapshot(agent: .claudeCode, kind: "monthly_overage_pool", usedPercent: 104, observedAt: Date())
        #expect(Fmt.limitLabel(pool) == "Monthly overage pool")
        #expect(Fmt.limitShortLabel(pool) == "Monthly")
        let perModel = LimitSnapshot(agent: .codex, kind: "codex.primary.10080m", label: "Weekly (gpt-reserve)", usedPercent: 5, windowMinutes: 10080, observedAt: Date())
        #expect(Fmt.limitLabel(perModel) == "Weekly (gpt-reserve)")
        #expect(Fmt.limitShortLabel(perModel) == "gpt-reserve")
        let weekly = LimitSnapshot(agent: .codex, kind: "codex.secondary", label: "Weekly", usedPercent: 5, windowMinutes: 10080, observedAt: Date())
        #expect(Fmt.limitShortLabel(weekly) == "7d")
        #expect(Fmt.providerName("openai") == "OpenAI")
        #expect(Fmt.providerName("anthropic") == "Anthropic")
        #expect(Fmt.providerName("mistral") == "Mistral")
        #expect(Fmt.basename("/a/b/c") == "c")
        #expect(Fmt.basename(nil) == nil)
        #expect(Fmt.shortID("7f3a91c2-0b4e") == "7f3a91c2")
    }

    @Test func priceTablesReadLikeTheHealthScreen() {
        let us = Locale(identifier: "en_US")
        #expect(Fmt.priceDate("2026-10-09", locale: us) == "Oct 9, 2026")
        // A UTC date, whatever the local zone: late on the 9th UTC is still the 9th.
        #expect(Fmt.priceDate("2026-10-09T23:30:00Z", locale: us) == "Oct 9, 2026")
        #expect(Fmt.priceDate("autumn") == "autumn")
        let tables = [PriceTableInfo(provider: "anthropic", asOf: "2026-10-09"), PriceTableInfo(provider: "openai", asOf: "2026-10-09")]
        #expect(Fmt.priceTablesNote(tables, locale: us) == "Anthropic list prices as of Oct 9, 2026; OpenAI list prices as of Oct 9, 2026")
    }

    @Test func sentences() {
        #expect(Fmt.sentence("exited with status 1") == "exited with status 1.")
        #expect(Fmt.sentence("no such file.") == "no such file.")
        #expect(Fmt.sentence("  done?  ") == "done?")
        #expect(Fmt.sentence("") == "")
    }

    @Test func severities() {
        #expect(Fmt.severity(nil) == .ok)
        #expect(Fmt.severity(74.9) == .ok)
        #expect(Fmt.severity(75) == .warn)
        #expect(Fmt.severity(90) == .crit)
    }

    @Test func sessionTitleFallsBack() {
        var s = FleetSession(agent: .codex, sessionId: "rollout-2026-10-09", status: .idle)
        #expect(s.title == "rollout-")
        s.cwd = "/Users/you/code/infra"
        #expect(s.title == "infra")
        s.name = "night run"
        #expect(s.title == "night run")
    }
}

@Suite("Ring buffer")
struct RingBufferTests {
    @Test func dropsTheOldest() {
        var r = RingBuffer<Int>(capacity: 3)
        for i in 1...5 { r.append(i) }
        #expect(r.elements == [3, 4, 5])
        #expect(r.count == 3)
        #expect(r.last == 5)
        #expect(r.droppedCount == 2)
        r.removeAll()
        #expect(r.isEmpty)
        r.append(9)
        #expect(Array(r) == [9])
    }
}
