import Foundation
import Testing
@testable import SignalboxKit

@MainActor
@Suite("Store state")
struct StoreTests {
    let t0 = date("2026-10-09T14:30:00Z")

    func makeStore(range: UsageRange = .week) -> SignalboxStore {
        let fixed = t0
        return SignalboxStore(range: range, clock: { fixed })
    }

    @Test func startsIdleThenStartingOnConnect() async {
        let store = makeStore()
        #expect(store.connection == .idle)
        let fake = FakeTransport()
        store.connect(fake)
        #expect(store.connection == .starting)
        #expect(store.isAwaitingReport)
        #expect(await eventually { fake.startedDays == [7] })
    }

    @Test func helloConnectsAndRecordsVersion() {
        let store = makeStore()
        store.handle(.started(pid: 99, command: "signalbox watch --ndjson --days 7"))
        #expect(store.connection == .starting)
        #expect(store.cliPID == 99)
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: 100)))
        #expect(store.connection == .connected)
        #expect(store.cliVersion == "0.1.0")
        #expect(store.cliPID == 100)
    }

    @Test func dataWithoutHelloStillMeansConnected() throws {
        let store = makeStore()
        store.handle(.started(pid: 1, command: "x"))
        let s = try TestPaths.loadSnapshot()
        store.handle(.message(.fleet(at: t0, s.fleet)))
        #expect(store.connection == .connected)
        #expect(store.fleet == s.fleet)
        #expect(store.fleetUpdatedAt == t0)
    }

    @Test func reportArrivalAndRangeSwitching() async throws {
        let store = makeStore()
        let fake = FakeTransport()
        store.connect(fake)
        let s = try TestPaths.loadSnapshot()

        store.handle(.message(.report(at: t0, days: 7, s.report)))
        #expect(store.reportDays == 7)
        #expect(!store.isAwaitingReport)
        #expect(store.reportForSelectedRange == s.report)

        store.select(range: .today)
        #expect(store.range == .today)
        #expect(store.isAwaitingReport)
        // The old 7-day report is kept but not presented as "Today".
        #expect(store.report == s.report)
        #expect(store.reportForSelectedRange == nil)
        #expect(await eventually { fake.sent == [.report(days: 1)] })

        store.handle(.message(.report(at: t0, days: 1, s.report)))
        #expect(!store.isAwaitingReport)
        #expect(store.reportForSelectedRange != nil)

        // Selecting the current range again sends nothing.
        store.select(range: .today)
        store.refresh()
        #expect(await eventually { fake.sent == [.report(days: 1), .refresh] })
    }

    @Test func rangeIsFixedWithoutATransport() throws {
        let store = makeStore()
        store.load(snapshot: try TestPaths.loadSnapshot(), name: "snapshot.json")
        #expect(store.connection == .fixture(name: "snapshot.json"))
        store.select(range: .month)
        #expect(store.range == .week)
        #expect(store.reportForSelectedRange != nil)
    }

    @Test func exitAfterConnectingRestartsWithTheReason() {
        let store = makeStore()
        store.handle(.started(pid: 4, command: "x"))
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: nil)))
        store.handle(.stderr("signalbox watch: fleet: 12 ms wall"))
        store.handle(.stderr("signalbox: out of memory  "))
        store.handle(.stderr(""))
        store.handle(.exited(status: 1, signaled: false))
        #expect(store.lastExit == "exited with status 1")
        #expect(store.cliPID == nil)
        // The last non-empty stderr line says why.
        #expect(store.lastFailure == "exited with status 1: signalbox: out of memory")
        store.handle(.restarting(attempt: 1, delay: .seconds(1)))
        #expect(store.connection == .restarting(attempt: 1, retryAt: t0.addingTimeInterval(1), reason: "exited with status 1: signalbox: out of memory"))
        #expect(store.connection.failureReason == "exited with status 1: signalbox: out of memory")
        #expect(store.failedStarts == 0)
        store.handle(.started(pid: 5, command: "x"))
        #expect(store.connection == .starting)
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: nil)))
        #expect(store.connection == .connected)
        #expect(store.lastFailure == nil)
        store.handle(.exited(status: 9, signaled: true))
        #expect(store.lastFailure == "was stopped by signal 9")
    }

    @Test func theCLIsOwnErrorLineBeatsATrailingHint() {
        // An older CLI without `watch`: a usage error, then a hint line.
        let store = makeStore()
        store.handle(.started(pid: 4, command: "x"))
        store.handle(.stderr("signalbox: unknown command \"watch\""))
        store.handle(.stderr("Run \"signalbox --help\" for usage."))
        store.handle(.exited(status: 2, signaled: false))
        #expect(store.lastFailure == "exited with status 2: signalbox: unknown command \"watch\"")
    }

    @Test func aLaunchFailureStaysVisibleAcrossTheRestart() {
        let store = makeStore()
        // The order the transport emits: launchFailed, then restarting.
        store.handle(.launchFailed("permission denied"))
        #expect(store.connection == .failed(reason: "couldn't be run: permission denied", attempt: 1, retryAt: nil))
        store.handle(.restarting(attempt: 1, delay: .seconds(1)))
        #expect(store.connection == .failed(reason: "couldn't be run: permission denied", attempt: 1, retryAt: t0.addingTimeInterval(1)))
        #expect(store.lastExit == "could not start: permission denied")
        store.handle(.launchFailed("permission denied"))
        store.handle(.restarting(attempt: 2, delay: .seconds(2)))
        #expect(store.connection == .failed(reason: "couldn't be run: permission denied", attempt: 2, retryAt: t0.addingTimeInterval(2)))
        #expect(store.failedStarts == 2)
        // It recovers as soon as a run connects.
        store.handle(.started(pid: 5, command: "x"))
        #expect(store.connection.failureReason != nil, "a new attempt alone doesn't clear the failure")
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: nil)))
        #expect(store.connection == .connected)
        #expect(store.failedStarts == 0)
        #expect(store.lastFailure == nil)
    }

    @Test func repeatedExitsBeforeHelloBecomeCouldntStart() {
        let store = makeStore()
        let why = "exited with status 1: signalbox: ENOENT: no such file or directory, scandir '/nonexistent'"
        for attempt in 1...SignalboxStore.failedStartThreshold {
            store.handle(.started(pid: Int32(attempt), command: "x"))
            store.handle(.stderr("signalbox: ENOENT: no such file or directory, scandir '/nonexistent'"))
            store.handle(.exited(status: 1, signaled: false))
            store.handle(.restarting(attempt: attempt, delay: .seconds(Int64(attempt))))
            let retryAt = t0.addingTimeInterval(TimeInterval(attempt))
            if attempt < SignalboxStore.failedStartThreshold {
                #expect(store.connection == .restarting(attempt: attempt, retryAt: retryAt, reason: why))
            } else {
                #expect(store.connection == .failed(reason: why, attempt: attempt, retryAt: retryAt))
            }
        }
        // The next attempt doesn't flicker back to "starting" until it connects.
        store.handle(.started(pid: 9, command: "x"))
        #expect(store.connection == .failed(reason: why, attempt: SignalboxStore.failedStartThreshold, retryAt: t0.addingTimeInterval(TimeInterval(SignalboxStore.failedStartThreshold))))
        let s = try? TestPaths.loadSnapshot()
        if let s { store.handle(.message(.fleet(at: t0, s.fleet))) }
        #expect(store.connection == .connected)
        #expect(store.failedStarts == 0)
    }

    @Test func errorsAreKeptPerScopeAndClearedByFreshData() throws {
        let store = makeStore()
        let s = try TestPaths.loadSnapshot()
        store.handle(.message(.error(StreamError(scope: .fleet, message: "agents --json timed out", at: t0))))
        store.handle(.protocolError("line is not a JSON object (4 bytes)", preview: "oops"))
        #expect(store.streamErrors[.fleet]?.message == "agents --json timed out")
        #expect(store.streamErrors[.protocol]?.message == "line is not a JSON object (4 bytes): oops")
        store.handle(.message(.fleet(at: t0, s.fleet)))
        #expect(store.streamErrors[.fleet] == nil)
        #expect(store.streamErrors[.protocol] != nil)
    }

    @Test func diagnosticsCaptureStderrAndEvents() {
        let store = makeStore()
        store.handle(.stderr("signalbox: scanning 312 files"))
        store.handle(.message(.unknown(type: "progress")))
        store.handle(.message(.hello(version: "9", protocolVersion: 2, pid: nil)))
        let texts = store.diagnostics.elements.map(\.text)
        #expect(texts.contains("signalbox: scanning 312 files"))
        #expect(texts.contains { $0.contains("progress") })
        #expect(store.diagnostics.elements.contains { $0.kind == .warning && $0.text.contains("v2") })
        store.clearDiagnostics()
        #expect(store.diagnostics.isEmpty)
    }

    @Test func diagnosticsAreBounded() {
        let store = makeStore()
        for i in 0..<800 { store.handle(.stderr("line \(i)")) }
        #expect(store.diagnostics.count == 500)
        #expect(store.diagnostics.last?.text == "line 799")
    }

    @Test func derivedSessionGroups() throws {
        let store = makeStore()
        store.load(snapshot: try TestPaths.loadSnapshot(), name: "f")
        #expect(store.waitingSessions.map(\.title) == ["docs sweep"])
        let groups = store.activeSessionsByAgent
        #expect(groups.map(\.agent) == [.claudeCode, .codex])
        // Busy before idle within an agent.
        #expect(groups[0].sessions.first?.status == .busy)
        #expect(groups[0].sessions.last?.status == .idle)
        #expect(store.endedSessions.map(\.title) == ["release notes"])
        #expect(store.count(.busy) == 2)
        #expect(store.session(id: "codex/rollout-2026-10-09T08-12-44-019a")?.model == "gpt-5.5-codex")
        #expect(store.limitAgents == [.claudeCode, .codex])
        #expect(store.limits(for: .claudeCode).first?.kind == "five_hour")
    }

    @Test func limitStatesAndMenuBarPercent() throws {
        let store = makeStore()
        let snapshot = try TestPaths.loadSnapshot()
        store.load(snapshot: snapshot, name: "f")
        let now = snapshot.generatedAt
        let five = try #require(store.limits.first { $0.kind == "five_hour" })
        let fable = try #require(store.limits.first { $0.kind == "seven_day_fable" })
        #expect(store.limitState(five, now: now) == .fresh)
        #expect(store.limitState(fable, now: now) == .stale)
        #expect(store.limitState(five, now: now.addingTimeInterval(3 * 3600)) == .resetPassed)
        #expect(store.highestFiveHourPercent(now: now) == 63)
        // After every reading goes stale there is no honest number to show.
        #expect(store.highestFiveHourPercent(now: now.addingTimeInterval(20 * 60)) == nil)
    }

    @Test func menuBarKeepsTheMostPressingLimits() throws {
        let store = makeStore()
        let stress = try Snapshot.decode(Data(contentsOf: TestPaths.stressSnapshot))
        store.load(snapshot: stress, name: "stress")
        let now = stress.generatedAt
        // Three Claude windows fit, so they all show.
        let base = try TestPaths.loadSnapshot()
        let small = makeStore()
        small.load(snapshot: base, name: "f")
        #expect(small.menuBarLimits(for: .claudeCode, now: now).shown.count == 3)
        #expect(small.menuBarLimits(for: .claudeCode, now: now).hidden == 0)
        // Five don't: the three fresh ones with the highest use stay, in window order; the stale one goes.
        let picked = store.menuBarLimits(for: .claudeCode, now: now)
        #expect(picked.hidden == 2)
        #expect(picked.shown.map(\.kind) == ["five_hour", "seven_day_opus", "monthly_overage_credits_pool"])
        #expect(!picked.shown.contains { store.limitState($0, now: now) == .stale })
    }

    @Test func claudeLimitsHintFollowsTheSpoolHealth() {
        let store = makeStore()
        #expect(store.claudeLimitsHint == .unknown)
        store.handle(.message(.health(at: t0, [AdapterHealth(name: "claude-code:spool", stability: .preview, ok: false, detail: "no spool")])))
        #expect(store.claudeLimitsHint == .noTap)
        store.handle(.message(.health(at: t0, [AdapterHealth(name: "claude-code:spool", stability: .preview, ok: true, detail: "loaded")])))
        #expect(store.claudeLimitsHint == .tapWaiting)
        #expect(store.healthUpdatedAt == t0)
    }

    @Test func disconnectStopsTheTransport() async {
        let store = makeStore()
        let fake = FakeTransport()
        store.connect(fake)
        await store.disconnect()
        #expect(fake.stopped)
        #expect(!store.canSendCommands)
    }
}
