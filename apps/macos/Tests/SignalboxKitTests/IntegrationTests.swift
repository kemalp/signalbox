import Foundation
import Testing
@testable import SignalboxKit

/// Runs the real CLI on this machine's data. Opt-in, because it reads local agent data:
///   SIGNALBOX_INTEGRATION_CLI=/path/to/dist/signalbox swift test --filter Integration
///   SIGNALBOX_INTEGRATION_CLI=bun:/abs/path/apps/cli/src/main.ts swift test --filter Integration
/// Asserts only on protocol shape and decoding; prints counts, never content.
@Suite("Integration with the real CLI", .serialized,
       .enabled(if: ProcessInfo.processInfo.environment["SIGNALBOX_INTEGRATION_CLI"] != nil))
struct IntegrationTests {
    @Test func speaksProtocolV1AndDecodes() async throws {
        let env = ProcessInfo.processInfo.environment
        let resolved = await ShellEnvironment.resolve()
        let location = CLILocator.locate(
            environment: ["SIGNALBOX_CLI": env["SIGNALBOX_INTEGRATION_CLI"]!],
            bundleResources: nil,
            searchPATH: resolved.environment["PATH"] ?? ""
        )
        guard case let .found(launch) = location else {
            Issue.record("CLI not found: \(location)")
            return
        }
        let cli = CLIProcess(configuration: .init(launch: launch, environment: resolved.environment))
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)

        let ready = await rec.waitUntil(timeout: .seconds(120)) { events in
            let m = events.messages
            return m.contains { if case .hello = $0 { true } else { false } }
                && m.contains { if case .fleet = $0 { true } else { false } }
                && m.contains { if case .health = $0 { true } else { false } }
                && events.reportDays.contains(7)
        }
        #expect(ready)

        await cli.send(.report(days: 1))
        #expect(await rec.waitUntil(timeout: .seconds(120)) { $0.reportDays.contains(1) })
        await cli.stop()

        let events = await rec.events
        // Reasons only (what was wrong and the line's size); the previews hold line content.
        let protocolErrors = events.compactMap { if case let .protocolError(reason, _) = $0 { reason } else { nil } }
        #expect(protocolErrors.isEmpty, "undecodable lines: \(protocolErrors.prefix(3))")
        if case let .hello(version, v, _) = events.messages.first {
            #expect(v == streamProtocolVersion)
            print("integration: signalbox \(version), protocol v\(v)")
        } else {
            Issue.record("first line was not hello")
        }
        let fleet = events.messages.compactMap { if case let .fleet(_, f) = $0 { f } else { nil } }.last
        let health = events.messages.compactMap { if case let .health(_, h) = $0 { h } else { nil } }.last
        print("integration: \(fleet?.sessions.count ?? -1) sessions, \(fleet?.limits.count ?? -1) limits, \(health?.count ?? -1) health sources, reports for days \(events.reportDays)")
        await rec.stop()
    }
}
