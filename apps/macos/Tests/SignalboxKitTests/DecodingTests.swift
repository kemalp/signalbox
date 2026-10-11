import Foundation
import Testing
@testable import SignalboxKit

@Suite("Decoding the contract")
struct DecodingTests {
    @Test func decodesTheSyntheticFixture() throws {
        let s = try TestPaths.loadSnapshot()
        #expect(s.v == 1)
        #expect(s.days == 7)
        #expect(s.generatedAt == date("2026-10-09T14:30:00.000Z"))

        #expect(s.fleet.sessions.count == 6)
        #expect(s.fleet.limits.count == 5)
        #expect(s.fleet.compactions.count == 4)
        #expect(s.health.count == 8)
        // The Claude app's session list (read for History) has its own row, owned by "claude-app", not an agent.
        let app = try #require(s.health.first { $0.name == "claude-app:sessions" })
        #expect(app.stability == .internal)
        #expect(app.agent == "claude-app")
        #expect(app.sourceName == "sessions")
        #expect(Fmt.agentName("claude-app") == "Claude app")

        let busy = try #require(s.fleet.sessions.first)
        #expect(busy.agent == .claudeCode)
        #expect(busy.status == .busy)
        #expect(busy.pid == 48211)
        #expect(busy.context?.quality == .official)
        #expect(busy.context?.effectivePercent == 41.2)
        #expect(busy.statusSince == date("2026-10-09T14:26:48.000Z"))

        // An estimated context whose window is the model's documented size (newer CLIs say where it came from).
        let docs = try #require(s.fleet.sessions.first { $0.name == "docs sweep" })
        #expect(docs.status == .waiting)
        #expect(docs.context?.quality == .estimated)
        #expect(docs.context?.window == 1_000_000)
        #expect(docs.context?.windowSource == "model-table")
        #expect(busy.context?.windowSource == "agent")
        // Without a percent, the fill is tokens over the window.
        let infra = try #require(s.fleet.sessions.first { $0.agent == .codex })
        #expect(infra.context?.percent == nil)
        #expect(abs((infra.context?.effectivePercent ?? 0) - 128_000.0 / 272_000 * 100) < 0.001)

        // A session with no context and no cost stays unknown (nil), never 0.
        let triage = try #require(s.fleet.sessions.first { $0.name == "nightly-triage" })
        #expect(triage.context == nil)
        #expect(triage.costUsd == nil)
        #expect(triage.pid == nil)

        #expect(s.report.byAgent.map(\.key).contains("codex"))
        #expect(s.report.byModel.contains { $0.key == "gpt-5.5-codex" && $0.hasUnpriced })
        #expect(s.report.byDay.count == 7)
        #expect(s.report.byDay.first?.byModel?.isEmpty == false)
        #expect(s.report.totals.unpricedModels == ["gpt-5.5-codex"])
        #expect(s.report.totals.cacheHitRatio > 0.9)
        #expect(s.report.estimate?.recordedUsd ?? 0 > 0)
        #expect(s.report.priceTables.first?.asOf == "2026-10-09")
        #expect(s.health.contains { $0.stability == .internal && $0.ok })
        #expect(s.health.contains { $0.name == "gemini-cli:telemetry" && !$0.ok && $0.stability == .documented })
    }

    @Test func toleratesUnknownEnumValuesAndFields() throws {
        let json = """
        {"generatedAt":"2026-10-09T14:30:00Z","sessions":[
          {"agent":"cursor-agent","sessionId":"x","status":"hibernating","source":"future","shiny":[1,2,3]}
        ],"limits":[],"compactions":[{"agent":"codex","sessionId":"y","ts":"2026-10-09T10:00:00Z","trigger":"scheduled"}],
        "health":[{"name":"x:y","stability":"experimental","ok":true,"detail":""}],"newTopLevel":{}}
        """
        let f = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        #expect(f.sessions.first?.status == .unknown)
        #expect(f.sessions.first?.agent.rawValue == "cursor-agent")
        #expect(f.compactions.first?.trigger == .unknown)
        #expect(f.health.first?.stability == .unknown)
    }

    @Test func dropsMalformedArrayElementsInsteadOfFailing() throws {
        let json = """
        {"generatedAt":"2026-10-09T14:30:00.123Z","sessions":[
          {"agent":"claude-code","sessionId":"good","status":"busy","source":"t"},
          {"agent":"claude-code","status":"busy"},
          42,
          null,
          {"agent":"codex","sessionId":"also-good","status":"idle","source":"t","statusSince":"2026-10-09T14:00:00Z"}
        ],"limits":"not an array"}
        """
        let f = try SignalboxJSON.decoder().decode(FleetSnapshot.self, from: Data(json.utf8))
        #expect(f.sessions.map(\.sessionId) == ["good", "also-good"])
        #expect(f.limits.isEmpty)
        #expect(f.compactions.isEmpty)
        #expect(f.generatedAt == date("2026-10-09T14:30:00.123Z"))
    }

    static let dateCases: [(String, Double)] = [
        ("2026-10-09T14:30:00.000Z", 1_791_556_200),
        ("2026-10-09T14:30:00Z", 1_791_556_200),
        ("2026-10-09T14:30:00.5Z", 1_791_556_200.5),
        ("2026-10-09T16:30:00+02:00", 1_791_556_200),
    ]

    @Test(arguments: dateCases)
    func parsesISODates(input: String, epoch: Double) throws {
        let d = try #require(ISODate.parse(input))
        #expect(abs(d.timeIntervalSince1970 - epoch) < 0.001)
    }

    @Test func rejectsGarbageDates() {
        #expect(ISODate.parse("yesterday") == nil)
        #expect(ISODate.parse("") == nil)
    }

    @Test func roundTripsTheSnapshotThroughTheEncoder() throws {
        let s = try TestPaths.loadSnapshot()
        let data = try SignalboxJSON.encoder().encode(s)
        let again = try Snapshot.decode(data)
        #expect(again == s)
    }

    @Test func healthNameSplitsIntoAgentAndSource() {
        let h = AdapterHealth(name: "claude-code:transcripts", stability: .internal, ok: true, detail: "")
        #expect(h.agent == .claudeCode)
        #expect(h.sourceName == "transcripts")
        let bare = AdapterHealth(name: "pricing", stability: .documented, ok: true, detail: "")
        #expect(bare.agent == nil)
        #expect(bare.sourceName == "pricing")
    }
}
