import Foundation
@testable import SignalboxKit

enum TestPaths {
    static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    static let fakeCLI = testsDir.appendingPathComponent("Fixtures/fake-cli.sh")
    /// apps/macos/Fixtures/snapshot.json (synthetic, generated from apps/web/src/mock.ts).
    static let snapshot = testsDir
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/snapshot.json")
    /// apps/macos/Fixtures/stress-snapshot.json: synthetic, with many sessions, long names and odd limits.
    static let stressSnapshot = snapshot.deletingLastPathComponent().appendingPathComponent("stress-snapshot.json")
    /// apps/macos/Fixtures/stream-v1.ndjson: what the real CLI printed for synthetic agent homes.
    static let streamFixture = snapshot.deletingLastPathComponent().appendingPathComponent("stream-v1.ndjson")
    /// apps/macos/Fixtures/commands.json: the real catalogs plus synthetic installed versions and custom commands
    /// (scripts/make-commands-fixture.ts).
    static let commandsFixture = snapshot.deletingLastPathComponent().appendingPathComponent("commands.json")

    static func loadCommands() throws -> CommandsData {
        try CommandsData.decode(Data(contentsOf: commandsFixture))
    }

    static func loadSnapshot() throws -> Snapshot {
        try Snapshot.decode(Data(contentsOf: snapshot))
    }
}

func date(_ iso: String) -> Date {
    guard let d = ISODate.parse(iso) else { fatalError("bad test date \(iso)") }
    return d
}

/// Consumes a transport's event stream once and lets tests wait for conditions on what arrived.
actor EventRecorder {
    private(set) var events: [TransportEvent] = []
    private var task: Task<Void, Never>?

    func start(_ stream: AsyncStream<TransportEvent>) {
        task = Task {
            for await e in stream { self.append(e) }
        }
    }

    private func append(_ e: TransportEvent) { events.append(e) }

    /// Polls until `predicate` holds or `timeout` passes. Returns whether it held.
    func waitUntil(timeout: Duration = .seconds(10), _ predicate: @Sendable ([TransportEvent]) -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if predicate(events) { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return predicate(events)
    }

    func stop() { task?.cancel() }
}

extension [TransportEvent] {
    var messages: [StreamMessage] {
        compactMap { if case let .message(m) = $0 { m } else { nil } }
    }

    var starts: Int { filter { if case .started = $0 { true } else { false } }.count }

    var stderrLines: [String] {
        compactMap { if case let .stderr(s) = $0 { s } else { nil } }
    }

    var reportDays: [Int] {
        messages.compactMap { if case let .report(_, days, _) = $0 { days } else { nil } }
    }

    var fleetCount: Int {
        messages.filter { if case .fleet = $0 { true } else { false } }.count
    }
}

/// A transport that records commands and lets the test push events.
final class FakeTransport: SignalboxTransport, @unchecked Sendable {
    let events: AsyncStream<TransportEvent>
    let continuation: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [StreamCommand] = []
    private var _startedDays: [Int] = []
    private var _stopped = false

    init() {
        (events, continuation) = AsyncStream<TransportEvent>.makeStream()
    }

    var sent: [StreamCommand] { lock.withLock { _sent } }
    var startedDays: [Int] { lock.withLock { _startedDays } }
    var stopped: Bool { lock.withLock { _stopped } }

    func start(days: Int) async { lock.withLock { _startedDays.append(days) } }
    func send(_ command: StreamCommand) async { lock.withLock { _sent.append(command) } }
    func stop() async {
        lock.withLock { _stopped = true }
        continuation.finish()
    }
}

/// Waits (briefly) for a condition that depends on an unstructured Task having run.
@MainActor
func eventually(timeout: Duration = .seconds(2), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}
