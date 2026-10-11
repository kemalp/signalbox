import Foundation
import Testing
@testable import SignalboxKit

@Suite("SIGNALBOX_DEBUG log")
struct DebugLogTests {
    @Test func isEnabledByAnyValueButOffValues() {
        #expect(DebugLog.isEnabled(["SIGNALBOX_DEBUG": "1"]))
        #expect(DebugLog.isEnabled(["SIGNALBOX_DEBUG": "yes"]))
        for off in ["", "0", "false", "OFF", "no", " 0 "] {
            #expect(!DebugLog.isEnabled(["SIGNALBOX_DEBUG": off]))
        }
        #expect(!DebugLog.isEnabled([:]))
    }

    @Test func fleetAndReportLinesCarryCountsNotContent() throws {
        let s = try TestPaths.loadSnapshot()
        let fleet = DebugLog.describe(.message(.fleet(at: nil, s.fleet)))
        #expect(fleet.hasPrefix("fleet sessions=6 "))
        #expect(fleet.contains("limits=5"))
        #expect(fleet.hasSuffix(" contexts=4 windowed=4"))
        for session in s.fleet.sessions {
            if let name = session.name { #expect(!fleet.contains(name)) }
            if let cwd = session.cwd { #expect(!fleet.contains(cwd)) }
        }
        let report = DebugLog.describe(.message(.report(at: nil, days: 7, s.report)))
        #expect(report.hasPrefix("report days=7 responses="))
        #expect(!report.contains(s.report.byProject.first?.key ?? "\u{0}"))
        #expect(DebugLog.describe(.message(.hello(version: "1.2.3", protocolVersion: 1, pid: 9))) == "hello v=1 version=1.2.3 pid=9")
    }

    @Test func appLinesCarryNoPathsOrLineContent() {
        let started = DebugLog.describe(.started(pid: 7, command: "/Users/you/Applications/Signalbox.app/Contents/Resources/signalbox watch --ndjson --days 7"))
        #expect(started == "started pid=7 args=watch --ndjson --days 7")
        let dev = DebugLog.describe(.started(pid: 8, command: "/Users/you/.bun/bin/bun /Users/you/src/apps/cli/src/main.ts watch --ndjson --days 1"))
        #expect(dev == "started pid=8 args=watch --ndjson --days 1")
        let bad = DebugLog.describe(.protocolError("malformed \"fleet\" line: wrong type at sessions.0.cwd (512 bytes)", preview: "{\"type\":\"fleet\",\"data\":{\"sessions\":[{\"cwd\":\"/Users/you/secret-project\""))
        #expect(bad == "protocol-error malformed \"fleet\" line: wrong type at sessions.0.cwd (512 bytes)")
        #expect(!bad.contains("secret-project"))
    }

    @MainActor
    @Test func theStoreShowsEveryEventToItsObserver() {
        let store = SignalboxStore()
        var seen: [TransportEvent] = []
        var states: [String] = []
        store.eventObserver = { [weak store] in
            seen.append($0)
            if let store { states.append(DebugLog.describe(store.connection)) }
        }
        store.handle(.stderr("x"))
        store.handle(.exited(status: 0, signaled: false))
        store.handle(.launchFailed("gone"))
        #expect(seen == [.stderr("x"), .exited(status: 0, signaled: false), .launchFailed("gone")])
        // The observer runs after the event is applied, so it sees the new state; reasons stay out of the log.
        #expect(states.last?.hasPrefix("failed attempt=2") == true)
        #expect(states.allSatisfy { !$0.contains("gone") })
    }
}
