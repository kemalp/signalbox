import Foundation
import os

/// Something the transport saw. The store turns these into UI state.
public enum TransportEvent: Sendable, Equatable {
    /// The child process started.
    case started(pid: Int32, command: String)
    /// A decoded protocol line.
    case message(StreamMessage)
    /// A stdout line that wasn't a valid protocol line. The stream keeps going. `reason` carries no line
    /// content (what went wrong and the line's size); `preview` is the start of the line, for Diagnostics only.
    case protocolError(String, preview: String? = nil)
    /// One line of the CLI's stderr.
    case stderr(String)
    /// The child exited (status, or the signal number when `signaled`).
    case exited(status: Int32, signaled: Bool)
    /// The child couldn't be started at all.
    case launchFailed(String)
    /// Waiting `delay` before restart attempt `attempt`.
    case restarting(attempt: Int, delay: Duration)
}

/// The store's view of a transport, so tests can substitute a fake.
public protocol SignalboxTransport: AnyObject, Sendable {
    var events: AsyncStream<TransportEvent> { get }
    /// Starts the child (and keeps restarting it) with the given report window.
    func start(days: Int) async
    func send(_ command: StreamCommand) async
    /// Stops for good: closes stdin, then terminates the child if it doesn't exit.
    func stop() async
}

/// Supervises `signalbox watch --ndjson`: spawns it with an argv array (never a shell string),
/// parses stdout line by line off the main actor, writes commands to stdin, collects stderr,
/// and restarts with exponential backoff when the child exits.
public actor CLIProcess: SignalboxTransport {
    public struct Configuration: Sendable {
        public var launch: CLILaunch
        public var environment: [String: String]?
        /// Flags from Settings (e.g. --no-claude-app), added to every start.
        public var options: CLIWatchOptions
        public var initialBackoff: Duration
        public var maxBackoff: Duration
        /// A run at least this long resets the backoff to `initialBackoff`.
        public var stableAfter: Duration
        /// How long to wait after closing stdin before SIGTERM, and again before SIGKILL.
        public var terminateGrace: Duration

        public init(
            launch: CLILaunch,
            environment: [String: String]? = nil,
            options: CLIWatchOptions = CLIWatchOptions(),
            initialBackoff: Duration = .seconds(1),
            maxBackoff: Duration = .seconds(30),
            stableAfter: Duration = .seconds(60),
            terminateGrace: Duration = .seconds(2)
        ) {
            self.launch = launch
            self.environment = environment
            self.options = options
            self.initialBackoff = initialBackoff
            self.maxBackoff = maxBackoff
            self.stableAfter = stableAfter
            self.terminateGrace = terminateGrace
        }

        /// The argv after the executable for a run with this report window.
        public func arguments(days: Int) -> [String] {
            launch.watchArguments(days: days, options: options)
        }
    }

    public nonisolated let events: AsyncStream<TransportEvent>
    private nonisolated let continuation: AsyncStream<TransportEvent>.Continuation
    /// The running child's pid, readable synchronously at app termination.
    private nonisolated let livePID = OSAllocatedUnfairLock<Int32?>(initialState: nil)

    private let config: Configuration
    private var days = 7
    private var supervisor: Task<Void, Never>?
    private var process: Process?
    private var stdin: FileHandle?
    private var stopped = false

    public init(configuration: Configuration) {
        config = configuration
        (events, continuation) = AsyncStream<TransportEvent>.makeStream(bufferingPolicy: .bufferingNewest(512))
        _ = Self.ignoreSIGPIPE
    }

    /// Writing to a pipe whose reader died raises SIGPIPE, which would kill the app. With the signal
    /// ignored the write fails with EPIPE instead, which `send` handles.
    private static let ignoreSIGPIPE: Void = { signal(SIGPIPE, SIG_IGN) }()

    /// 1s, 2s, 4s, … capped at `max`.
    public static func backoff(attempt: Int, initial: Duration, max: Duration) -> Duration {
        let exponent = Swift.max(0, Swift.min(attempt - 1, 30))
        let delay = initial * (1 << exponent)
        return delay > max ? max : delay
    }

    public func start(days: Int) {
        guard supervisor == nil, !stopped else { return }
        self.days = StreamCommand.clampDays(days)
        supervisor = Task { await self.supervise() }
    }

    public func send(_ command: StreamCommand) {
        if case let .report(d) = command { days = StreamCommand.clampDays(d) }
        guard let stdin else { return }
        do {
            try stdin.write(contentsOf: command.encodedLine())
        } catch {
            continuation.yield(.stderr("signalbox app: could not write to the CLI's stdin: \(error.localizedDescription)"))
        }
    }

    public func stop() async {
        guard !stopped else { return }
        stopped = true
        // Let the child exit on stdin EOF and its last lines drain before tearing anything down.
        await terminateChild()
        supervisor?.cancel()
        await supervisor?.value
        supervisor = nil
        continuation.finish()
    }

    /// Synchronous last resort for `applicationWillTerminate`: SIGTERM the child. (It also exits
    /// on its own when our end of its stdin closes as the app process goes away.)
    public nonisolated func terminateImmediately() {
        if let pid = livePID.withLock({ $0 }), pid > 0 { kill(pid, SIGTERM) }
    }

    // MARK: Supervision

    private func supervise() async {
        var attempt = 0
        while !stopped, !Task.isCancelled {
            let began = ContinuousClock.now
            do {
                let (status, signaled) = try await runOnce()
                if stopped { break }
                continuation.yield(.exited(status: status, signaled: signaled))
            } catch is CancellationError {
                break
            } catch {
                if stopped { break }
                continuation.yield(.launchFailed(error.localizedDescription))
            }
            if ContinuousClock.now - began >= config.stableAfter { attempt = 0 }
            attempt += 1
            let delay = Self.backoff(attempt: attempt, initial: config.initialBackoff, max: config.maxBackoff)
            continuation.yield(.restarting(attempt: attempt, delay: delay))
            do {
                try await Task.sleep(for: delay)
            } catch {
                break
            }
        }
    }

    /// Runs one child to completion and returns its exit status.
    private func runOnce() async throws -> (Int32, Bool) {
        try Task.checkCancellation()
        let p = Process()
        p.executableURL = config.launch.executable
        p.arguments = config.arguments(days: days)
        if let env = config.environment { p.environment = env }
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp

        let (exit, exitContinuation) = AsyncStream<(Int32, Bool)>.makeStream()
        p.terminationHandler = { proc in
            exitContinuation.yield((proc.terminationStatus, proc.terminationReason == .uncaughtSignal))
            exitContinuation.finish()
        }
        let stdoutReader = PipeReader(out.fileHandleForReading)
        let stderrReader = PipeReader(err.fileHandleForReading)

        do {
            try p.run()
        } catch {
            stdoutReader.stop()
            stderrReader.stop()
            throw error
        }
        process = p
        stdin = inp.fileHandleForWriting
        livePID.withLock { $0 = p.processIdentifier }
        continuation.yield(.started(pid: p.processIdentifier, command: ([config.launch.executable.path] + (p.arguments ?? [])).joined(separator: " ")))
        defer {
            process = nil
            try? stdin?.close()
            stdin = nil
            livePID.withLock { $0 = nil }
        }

        let events = continuation
        let result: (Int32, Bool) = await withTaskGroup(of: (Int32, Bool)?.self) { group in
            group.addTask {
                // Decoding happens here, off the main actor.
                let decoder = SignalboxJSON.decoder()
                var splitter = LineSplitter()
                func handle(_ line: Data) {
                    do {
                        events.yield(.message(try StreamMessage.parse(line, decoder: decoder)))
                    } catch {
                        let preview = String(decoding: line.prefix(120), as: UTF8.self)
                        events.yield(.protocolError("\(error) (\(line.count) bytes)", preview: preview))
                    }
                }
                for await chunk in stdoutReader.chunks {
                    for line in splitter.append(chunk) { handle(line) }
                }
                if let tail = splitter.finish() { handle(tail) }
                if splitter.droppedOversizeLines > 0 {
                    events.yield(.protocolError("dropped \(splitter.droppedOversizeLines) oversize stdout line(s)"))
                }
                return nil
            }
            group.addTask {
                var splitter = LineSplitter(maxLineBytes: 64 * 1024)
                for await chunk in stderrReader.chunks {
                    for line in splitter.append(chunk) {
                        events.yield(.stderr(String(decoding: line, as: UTF8.self)))
                    }
                }
                if let tail = splitter.finish() { events.yield(.stderr(String(decoding: tail, as: UTF8.self))) }
                return nil
            }
            group.addTask {
                var status: (Int32, Bool) = (-1, false)
                for await s in exit { status = s }
                // Give the readers a moment to drain what the child wrote before it exited, then stop
                // them even if a grandchild still holds the pipes open.
                try? await Task.sleep(for: .milliseconds(500))
                stdoutReader.stop()
                stderrReader.stop()
                return status
            }
            var status: (Int32, Bool) = (-1, false)
            for await r in group {
                if let r { status = r }
            }
            return status
        }
        return result
    }

    /// Close stdin (the CLI exits on EOF), then SIGTERM, then SIGKILL.
    private func terminateChild() async {
        guard let p = process else { return }
        try? stdin?.close()
        stdin = nil
        let pid = p.processIdentifier
        if await waitForExit(p, within: config.terminateGrace) { return }
        p.terminate()
        if await waitForExit(p, within: config.terminateGrace) { return }
        kill(pid, SIGKILL)
    }

    private func waitForExit(_ p: Process, within limit: Duration) async -> Bool {
        let deadline = ContinuousClock.now + limit
        while p.isRunning {
            if ContinuousClock.now >= deadline { return false }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return true
    }
}

extension StreamCommand {
    static func clampDays(_ days: Int) -> Int {
        min(max(days, dayRange.lowerBound), dayRange.upperBound)
    }
}
