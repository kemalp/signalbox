import Foundation
import Observation

/// The report windows offered in the UI. Calendar days: "Today" starts at local midnight.
public enum UsageRange: Int, CaseIterable, Identifiable, Sendable {
    case today = 1
    case week = 7
    case month = 30

    public var id: Int { rawValue }
    public var days: Int { rawValue }

    public var label: String { Self.describe(days: days) }

    /// "Today" or "N days": calendar days, today included ("7 days" is today and the six days before it).
    public static func describe(days: Int) -> String {
        days == 1 ? "Today" : "\(days) days"
    }
}

public enum ConnectionState: Equatable, Sendable {
    /// Not started yet.
    case idle
    /// Resolving the environment or waiting for the CLI's first line.
    case starting
    /// The CLI is running and has said hello (or sent data).
    case connected
    /// The CLI exited; the next attempt starts at `retryAt`. `reason` says how the last run ended
    /// (its exit status and last stderr line), when known.
    case restarting(attempt: Int, retryAt: Date, reason: String?)
    /// No CLI to run. `reason` says what to do about it.
    case cliMissing(reason: String)
    /// The CLI can't be started, or keeps exiting before it sends anything. The transport keeps
    /// trying; `retryAt` is the next attempt once one is scheduled.
    case failed(reason: String, attempt: Int, retryAt: Date?)
    /// Showing a saved snapshot; nothing is live.
    case fixture(name: String)

    public var isLive: Bool { self == .connected }

    /// Why the CLI isn't running when it should be (restarting or failing), else nil.
    public var failureReason: String? {
        switch self {
        case let .restarting(_, _, reason): reason
        case let .failed(reason, _, _): reason
        default: nil
        }
    }
}

/// A line for the Diagnostics sheet.
public struct DiagnosticLine: Identifiable, Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case stderr, event, warning }
    public let id: Int
    public let date: Date
    public let kind: Kind
    public let text: String
}

/// All app state, fed by the transport. Views read it; only the store mutates it.
@MainActor
@Observable
public final class SignalboxStore {
    public private(set) var fleet: FleetSnapshot?
    public private(set) var report: Report?
    /// The window `report` covers, as reported by the CLI.
    public private(set) var reportDays: Int?
    public private(set) var health: [AdapterHealth]?
    public private(set) var fleetUpdatedAt: Date?
    public private(set) var reportUpdatedAt: Date?
    public private(set) var healthUpdatedAt: Date?
    /// The command guide (catalogs, installed versions, custom commands), from a newer CLI's "commands" line.
    public private(set) var commands: CommandsData?
    public private(set) var commandsUpdatedAt: Date?
    /// Session history (titles, stats, resume commands), from a newer CLI's "history" line.
    public private(set) var history: HistorySnapshot?
    public private(set) var historyUpdatedAt: Date?
    /// When the current CLI run connected (its hello, or its first data line).
    public private(set) var connectedAt: Date?

    public private(set) var connection: ConnectionState = .idle
    public private(set) var cliVersion: String?
    public private(set) var cliProtocolVersion: Int?
    public private(set) var cliPID: Int32?
    public private(set) var cliCommand: String?
    /// Why the last run ended, e.g. "exited with status 1".
    public private(set) var lastExit: String?
    /// How the last run failed, with its last stderr line, e.g. "exited with status 1: signalbox: ENOENT …".
    /// Kept across restarts so the window can say why; cleared once a run connects.
    public private(set) var lastFailure: String?
    /// Runs in a row that ended (or couldn't start) before sending anything; reset when one connects.
    public private(set) var failedStarts = 0
    /// After this many failed starts in a row the window says "The CLI Couldn't Start" instead of "Restarting".
    public static let failedStartThreshold = 3
    /// The latest error per stream; cleared when that stream next delivers data.
    public private(set) var streamErrors: [StreamErrorScope: StreamError] = [:]

    /// The window the user picked. `report` may still be for the previous one until the CLI answers.
    public private(set) var range: UsageRange
    /// True between asking for a new window and receiving it.
    public private(set) var isAwaitingReport = false

    /// stderr, transport events and warnings, newest last.
    public private(set) var diagnostics = RingBuffer<DiagnosticLine>(capacity: 500)
    private var nextDiagnosticID = 0

    /// When set (fixtures, snapshot rendering), views use this instead of the wall clock.
    public var pinnedNow: Date?

    /// Chart colours per model, kept for the life of the app so a model never changes colour between reports.
    public private(set) var modelSlots = SeriesSlots()

    /// Sees every transport event right after the store applied it, so it can also read the resulting
    /// state (the app's SIGNALBOX_DEBUG log).
    @ObservationIgnored public var eventObserver: ((TransportEvent) -> Void)?

    /// Called with the previous and the new fleet each time the CLI sends one (not for a loaded snapshot).
    /// The previous one is nil for the first fleet of the app's life: notifications treat that as app start.
    @ObservationIgnored public var fleetObserver: ((_ previous: FleetSnapshot?, _ current: FleetSnapshot) -> Void)?
    /// The last fleet the CLI sent, for `fleetObserver` (a loaded snapshot doesn't count).
    @ObservationIgnored private var lastLiveFleet: FleetSnapshot?

    private var transport: (any SignalboxTransport)?
    private var eventTask: Task<Void, Never>?
    /// True once the current run has said hello or sent data.
    private var runConnected = false
    /// The current run's last non-empty stderr line, and its last "signalbox: …" line (the CLI's own
    /// error format, which a usage error follows with a "Run signalbox --help" hint).
    private var runLastStderr: String?
    private var runLastCLIError: String?
    private let clock: @Sendable () -> Date

    public init(range: UsageRange = .week, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.range = range
        self.clock = clock
    }

    public var now: Date { pinnedNow ?? clock() }

    // MARK: Lifecycle

    /// Starts consuming `transport` and asks it to start the CLI.
    public func connect(_ transport: any SignalboxTransport) {
        self.transport = transport
        connection = .starting
        isAwaitingReport = true
        eventTask?.cancel()
        let events = transport.events
        eventTask = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                // A transport that was disconnected or replaced can still drain lines while it stops. They belong
                // to the old run (and maybe old settings, e.g. a history with the Claude app's list), so drop them.
                guard self.transport === transport else { return }
                self.handle(event)
            }
        }
        let days = range.days
        Task { await transport.start(days: days) }
    }

    /// Stops the current transport. Its events stop counting at once, before the (possibly slow) stop: a `connect`
    /// made while this waits keeps its own event loop.
    public func disconnect() async {
        let t = transport
        transport = nil
        let task = eventTask
        eventTask = nil
        task?.cancel()
        await t?.stop()
    }

    public func markCLIMissing(reason: String) {
        connection = .cliMissing(reason: reason)
        log(.warning, "CLI not found: \(reason)")
    }

    public func markStarting(_ note: String? = nil) {
        connection = .starting
        if let note { log(.event, note) }
    }

    /// Shows a saved snapshot (the `signalbox snapshot --json` shape) without a CLI.
    public func load(snapshot: Snapshot, name: String) {
        fleet = snapshot.fleet
        report = snapshot.report
        assignModelSlots(snapshot.report)
        reportDays = snapshot.days
        health = snapshot.health.isEmpty ? snapshot.fleet.health : snapshot.health
        fleetUpdatedAt = snapshot.fleet.generatedAt
        reportUpdatedAt = snapshot.report.generatedAt
        healthUpdatedAt = snapshot.generatedAt
        if let c = snapshot.commands { load(commands: c) }
        if let h = snapshot.history { load(history: h) }
        range = UsageRange(rawValue: snapshot.days) ?? range
        isAwaitingReport = false
        connection = .fixture(name: name)
        log(.event, "Loaded snapshot \(name) (generated \(ISODate.format(snapshot.generatedAt)))")
    }

    /// Shows a saved command guide (the `signalbox commands --json` shape) without a CLI.
    public func load(commands data: CommandsData) {
        commands = data
        commandsUpdatedAt = data.generatedAt ?? clock()
    }

    /// Shows a saved session history (the `signalbox history --json` shape) without a CLI.
    public func load(history data: HistorySnapshot) {
        history = data
        historyUpdatedAt = data.generatedAt ?? clock()
    }

    /// Forgets the history after a setting changed what it lists (the Claude app's list on or off), so History says
    /// it is reading until the restarted CLI sends the new one, instead of showing the old list as if it were current.
    public func clearHistory() {
        history = nil
        historyUpdatedAt = nil
        streamErrors[.history] = nil
    }

    // MARK: Commands

    /// Switches the report window; the CLI answers with a new report line.
    public func select(range newRange: UsageRange) {
        // Without a CLI (fixtures) there is nobody to ask for another window.
        guard newRange != range, transport != nil else { return }
        range = newRange
        isAwaitingReport = reportDays != newRange.days
        send(.report(days: newRange.days))
    }

    /// Asks for fresh fleet and report lines now.
    public func refresh() {
        send(.refresh)
    }

    public var canSendCommands: Bool { transport != nil && connection.isLive }

    private func send(_ command: StreamCommand) {
        guard let transport else { return }
        Task { await transport.send(command) }
    }

    // MARK: Event handling

    /// Applies one transport event. Internal state machine; public so tests can drive it.
    public func handle(_ event: TransportEvent) {
        defer { eventObserver?(event) }
        let now = clock()
        switch event {
        case let .started(pid, command):
            cliPID = pid
            cliCommand = command
            runConnected = false
            runLastStderr = nil
            runLastCLIError = nil
            switch connection {
            // A failing CLI stays "couldn't start" until a run actually connects, instead of flickering.
            case .connected, .failed: break
            default: connection = .starting
            }
            log(.event, "Started CLI (pid \(pid)): \(command)")

        case let .message(message):
            apply(message, now: now)

        case let .protocolError(reason, preview):
            let text = preview.map { "\(reason): \($0)" } ?? reason
            let e = StreamError(scope: .protocol, message: text, at: now)
            streamErrors[.protocol] = e
            log(.warning, "Protocol: \(text)")

        case let .stderr(line):
            log(.stderr, line)
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let detail = String(trimmed.prefix(Self.failureDetailLimit))
                runLastStderr = detail
                if trimmed.hasPrefix("signalbox: ") { runLastCLIError = detail }
            }

        case let .exited(status, signaled):
            cliPID = nil
            let exit = signaled ? "terminated by signal \(status)" : "exited with status \(status)"
            lastExit = exit
            if !runConnected { failedStarts += 1 }
            let how = signaled ? "was stopped by signal \(status)" : exit
            lastFailure = (runLastCLIError ?? runLastStderr).map { "\(how): \($0)" } ?? how
            log(.event, "CLI \(exit)")

        case let .launchFailed(reason):
            cliPID = nil
            lastExit = "could not start: \(reason)"
            failedStarts += 1
            lastFailure = "couldn't be run: \(reason)"
            connection = .failed(reason: lastFailure!, attempt: failedStarts, retryAt: nil)
            log(.warning, "Could not start the CLI: \(reason)")

        case let .restarting(attempt, delay):
            let seconds = Double(delay.components.seconds) + Double(delay.components.attoseconds) / 1e18
            let retryAt = now.addingTimeInterval(seconds)
            let failing: Bool
            if case .failed = connection { failing = true } else { failing = failedStarts >= Self.failedStartThreshold }
            if failing {
                connection = .failed(reason: lastFailure ?? "keeps exiting", attempt: attempt, retryAt: retryAt)
            } else {
                connection = .restarting(attempt: attempt, retryAt: retryAt, reason: lastFailure)
            }
            log(.event, "Restarting in \(Fmt.duration(seconds.rounded(.up))) (attempt \(attempt))")
        }
    }

    /// How much of a stderr line a failure message keeps.
    static let failureDetailLimit = 300

    private func apply(_ message: StreamMessage, now: Date) {
        switch message {
        case let .hello(version, protocolVersion, pid):
            cliVersion = version
            cliProtocolVersion = protocolVersion
            if let pid { cliPID = Int32(pid) }
            connection = .connected
            markRunConnected()
            if protocolVersion != streamProtocolVersion {
                log(.warning, "CLI speaks protocol v\(protocolVersion); this app expects v\(streamProtocolVersion). Some data may be missing.")
            } else {
                log(.event, "Connected to signalbox \(version)")
            }

        case let .fleet(at, data):
            fleet = data
            fleetUpdatedAt = at ?? now
            streamErrors[.fleet] = nil
            if health == nil, !data.health.isEmpty { health = data.health }
            markLive()
            let previous = lastLiveFleet
            lastLiveFleet = data
            fleetObserver?(previous, data)

        case let .report(at, days, data):
            report = data
            assignModelSlots(data)
            reportDays = days ?? range.days
            reportUpdatedAt = at ?? now
            streamErrors[.report] = nil
            isAwaitingReport = reportDays != range.days
            markLive()

        case let .health(at, list):
            health = list
            healthUpdatedAt = at ?? now
            streamErrors[.health] = nil
            markLive()

        case let .commands(at, data):
            commands = data
            commandsUpdatedAt = at ?? now
            streamErrors[.commands] = nil
            markLive()

        case let .history(at, data):
            history = data
            historyUpdatedAt = at ?? data.generatedAt ?? now
            streamErrors[.history] = nil
            markLive()

        case let .error(e):
            streamErrors[e.scope] = e
            log(.warning, "CLI error (\(e.scope.rawValue)): \(e.message)")

        case let .unknown(type):
            log(.event, "Ignored a \"\(type)\" line (newer CLI?)")
        }
    }

    /// New models take the next free colours, biggest spender first; known ones keep theirs.
    private func assignModelSlots(_ report: Report) {
        let priced = report.byModel.filter { $0.cost.total > 0 }.sorted { $0.cost.total > $1.cost.total }
        var slots = modelSlots
        slots.assign(priced.map(\.key))
        if slots != modelSlots { modelSlots = slots }
    }

    /// Data arriving means the CLI is up, even if its hello was missed.
    private func markLive() {
        switch connection {
        case .connected: markRunConnected()
        case .fixture: break
        default:
            connection = .connected
            markRunConnected()
        }
    }

    private func markRunConnected() {
        if !runConnected || connectedAt == nil { connectedAt = clock() }
        runConnected = true
        failedStarts = 0
        lastFailure = nil
    }

    private func log(_ kind: DiagnosticLine.Kind, _ text: String) {
        diagnostics.append(DiagnosticLine(id: nextDiagnosticID, date: clock(), kind: kind, text: text))
        nextDiagnosticID += 1
    }

    public func clearDiagnostics() {
        diagnostics.removeAll()
    }

    // MARK: Derived data

    public var sessions: [FleetSession] { fleet?.sessions ?? [] }

    /// Status first (waiting, busy, idle, unknown, ended), then most recent activity.
    public static func sortSessions(_ a: FleetSession, _ b: FleetSession) -> Bool {
        if a.status.rank != b.status.rank { return a.status.rank < b.status.rank }
        let ta = a.lastActivity ?? .distantPast
        let tb = b.lastActivity ?? .distantPast
        if ta != tb { return ta > tb }
        return a.id < b.id
    }

    public var waitingSessions: [FleetSession] {
        sessions.filter { $0.status == .waiting }.sorted(by: Self.sortSessions)
    }

    /// Non-ended, non-waiting sessions grouped by agent in display order.
    public var activeSessionsByAgent: [(agent: AgentID, sessions: [FleetSession])] {
        let rest = sessions.filter { $0.status != .waiting && $0.status != .ended }
        return Dictionary(grouping: rest, by: \.agent)
            .map { (agent: $0.key, sessions: $0.value.sorted(by: Self.sortSessions)) }
            .sorted { $0.agent < $1.agent }
    }

    public var endedSessions: [FleetSession] {
        sessions.filter { $0.status == .ended }.sorted(by: Self.sortSessions)
    }

    public func session(id: FleetSession.ID?) -> FleetSession? {
        guard let id else { return nil }
        return sessions.first { $0.id == id }
    }

    public func count(_ status: SessionStatus) -> Int {
        sessions.filter { $0.status == status }.count
    }

    public var limits: [LimitSnapshot] { fleet?.limits ?? [] }

    /// Agents to show limit cards for: Claude Code always, plus any agent with limits or sessions.
    public var limitAgents: [AgentID] {
        var set: Set<AgentID> = [.claudeCode]
        for l in limits { set.insert(l.agent) }
        for s in sessions { set.insert(s.agent) }
        return set.sorted()
    }

    /// Shortest window first.
    public func limits(for agent: AgentID) -> [LimitSnapshot] {
        limits.filter { $0.agent == agent }.sorted {
            let wa = $0.windowMinutes ?? .greatestFiniteMagnitude
            let wb = $1.windowMinutes ?? .greatestFiniteMagnitude
            return wa != wb ? wa < wb : $0.kind < $1.kind
        }
    }

    /// The limits that fit in the menu bar for `agent`: all of them when there are at most `max`;
    /// otherwise the `max - 1` most pressing (fresh before stale before reset-passed, then highest use),
    /// in window order, plus how many were left out (the popover shows "+N" for those).
    public func menuBarLimits(for agent: AgentID, now: Date, max: Int = 4) -> (shown: [LimitSnapshot], hidden: Int) {
        let all = limits(for: agent)
        guard all.count > max, max > 1 else { return (all, 0) }
        func rank(_ l: LimitSnapshot) -> Int {
            switch limitState(l, now: now) {
            case .fresh: 0
            case .stale: 1
            case .resetPassed: 2
            }
        }
        let pressing = all.sorted { a, b in
            rank(a) != rank(b) ? rank(a) < rank(b) : a.usedPercent > b.usedPercent
        }.prefix(max - 1)
        let keep = Set(pressing.map(\.id))
        return (all.filter { keep.contains($0.id) }, all.count - keep.count)
    }

    /// A reading older than this shows no fill (see `LimitState.of`).
    public nonisolated static let limitStaleAfter: TimeInterval = LimitState.staleAfter

    public func limitState(_ limit: LimitSnapshot, now: Date) -> LimitState {
        LimitState.of(limit, now: now)
    }

    /// The highest fresh 5-hour-window reading, for the menu bar label.
    public func highestFiveHourPercent(now: Date) -> Double? {
        limits
            .filter { $0.kind == "five_hour" || $0.windowMinutes == 300 }
            .filter { limitState($0, now: now) == .fresh }
            .map(\.usedPercent)
            .max()
    }

    /// The highest fresh weekly reading (a 7-day window), for the menu bar label.
    public func highestWeeklyPercent(now: Date) -> Double? {
        limits
            .filter { $0.kind == "seven_day" || $0.windowMinutes == 10080 }
            .filter { limitState($0, now: now) == .fresh }
            .map(\.usedPercent)
            .max()
    }

    /// Today's recorded spend in USD from the current report: its row for today, 0 when the report covers today
    /// and has no row for it, nil when the report doesn't cover today (or hasn't arrived).
    public func todaySpendUSD(now: Date, calendar: Calendar = .current) -> Double? {
        guard let report else { return nil }
        let key = DayKey.key(now, calendar: calendar)
        if let row = report.byDay.first(where: { $0.key == key }) { return row.cost.total }
        guard let span = report.daySpan(calendar: calendar) else { return nil }
        let today = calendar.startOfDay(for: now)
        return span.first <= today && today <= span.last ? 0 : nil
    }

    /// The health entry for the Claude Code tap spool, which decides what an unknown Claude limit says.
    public var claudeLimitsHint: ClaudeLimitsHint {
        guard let spool = (health ?? fleet?.health ?? []).first(where: { $0.name == "claude-code:spool" }) else { return .unknown }
        return spool.ok ? .tapWaiting : .noTap
    }

    public var compactions: [CompactionEvent] { fleet?.compactions ?? [] }

    /// When anything last arrived.
    public var lastUpdated: Date? {
        [fleetUpdatedAt, reportUpdatedAt, healthUpdatedAt].compactMap { $0 }.max()
    }

    /// How long after connecting a CLI has to send its command guide before the app says it's too old to.
    public nonisolated static let commandGuideGrace: TimeInterval = 20

    /// What the Commands screen can show now.
    public func commandGuideState(now: Date) -> CommandGuideState {
        if commands != nil { return .ready }
        switch connection {
        case .fixture: return .notInSnapshot
        case .idle, .starting: return .loading
        case .connected:
            guard let since = connectedAt else { return .loading }
            return now.timeIntervalSince(since) >= Self.commandGuideGrace ? .cliTooOld : .loading
        case .restarting, .failed, .cliMissing: return .unavailable
        }
    }

    /// How long after connecting a CLI has to send its first history line before the app says it's too old to. The
    /// first one follows the first full transcript scan, which takes a while on a Mac with years of sessions.
    public nonisolated static let historyGrace: TimeInterval = 120

    /// What the History screen can show now.
    public func historyState(now: Date) -> HistoryState {
        if history != nil { return .ready }
        switch connection {
        case .fixture: return .notInSnapshot
        case .idle, .starting: return .loading
        case .connected:
            guard let since = connectedAt else { return .loading }
            return now.timeIntervalSince(since) >= Self.historyGrace ? .cliTooOld : .loading
        case .restarting, .failed, .cliMissing: return .unavailable
        }
    }

    /// The history entry with this id (`SessionHistoryEntry.id`), if the history has it.
    public func historyEntry(id: SessionHistoryEntry.ID?) -> SessionHistoryEntry? {
        guard let id else { return nil }
        return history?.entries.first { $0.id == id }
    }

    /// The report's window if it matches the selected range; else nil (a new one is on its way).
    public var reportForSelectedRange: Report? {
        reportDays == range.days ? report : nil
    }
}

public enum CommandGuideState: Sendable, Equatable {
    /// The guide arrived.
    case ready
    /// Waiting for the CLI's first "commands" line.
    case loading
    /// Connected for a while and no guide: a CLI from before the command guide.
    case cliTooOld
    /// Showing a saved snapshot without a guide.
    case notInSnapshot
    /// No CLI running (missing, failing or restarting); the usual no-data states apply.
    case unavailable
}

public enum HistoryState: Sendable, Equatable {
    /// The history arrived.
    case ready
    /// Waiting for the CLI's first "history" line (it follows the first transcript scan).
    case loading
    /// Connected for a while and no history: a CLI from before session history.
    case cliTooOld
    /// Showing a saved snapshot without a history.
    case notInSnapshot
    /// No CLI running (missing, failing or restarting); the usual no-data states apply.
    case unavailable
}

public enum LimitState: Sendable, Equatable {
    case fresh
    /// The reading is old; still shown, greyed.
    case stale
    /// The window reset after the reading, so its percentage is known to be out of date.
    case resetPassed
}

public enum ClaudeLimitsHint: Sendable, Equatable {
    /// The tap spool source reports not-ok: the mod isn't loaded anywhere.
    case noTap
    /// The tap is loaded but no reading has arrived yet.
    case tapWaiting
    /// No spool health entry at all.
    case unknown
}
