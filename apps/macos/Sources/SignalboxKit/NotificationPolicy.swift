import Foundation

// Which notifications to send, decided from what the CLI reported. Pure: no clock, no I/O, no UI. The app
// feeds it each fleet (and the connection state on a timer) and posts whatever it returns.

public enum NotificationKind: String, Sendable, CaseIterable, Codable {
    /// A session is waiting for the user.
    case waiting
    /// A session was busy for a while and is now idle or ended.
    case longTaskFinished = "long-task"
    /// A plan limit passed one of the user's thresholds.
    case limit
    /// The CLI has been failing for a while, so nothing on screen is current.
    case cliFailure = "cli-failure"
    /// "Send test notification" in Settings.
    case test
}

/// What clicking a notification opens.
public enum NotificationTarget: Hashable, Sendable {
    /// A session, by `FleetSession.id` ("agent/sessionId").
    case session(String)
    case limits
    case diagnostics
    /// The main window as it is.
    case app

    /// "session:claude-code/abc", "limits", "diagnostics", "app". Stored in the notification's userInfo.
    public var encoded: String {
        switch self {
        case let .session(id): "session:\(id)"
        case .limits: "limits"
        case .diagnostics: "diagnostics"
        case .app: "app"
        }
    }

    public init?(encoded: String) {
        switch encoded {
        case "limits": self = .limits
        case "diagnostics": self = .diagnostics
        case "app": self = .app
        default:
            guard encoded.hasPrefix("session:") else { return nil }
            let id = String(encoded.dropFirst("session:".count))
            guard !id.isEmpty else { return nil }
            self = .session(id)
        }
    }

    public var sessionID: String? {
        if case let .session(id) = self { return id }
        return nil
    }
}

public struct NotificationRequest: Hashable, Sendable, Identifiable {
    /// Stable for one event, so posting it twice replaces rather than repeats.
    public let id: String
    public let kind: NotificationKind
    public let title: String
    public let body: String
    public let target: NotificationTarget

    public init(id: String, kind: NotificationKind, title: String, body: String, target: NotificationTarget) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.target = target
    }
}

/// The notification settings the policy needs (a projection of `SettingsStore`).
public struct NotificationSettings: Equatable, Sendable {
    public var waiting: Bool
    public var longTask: Bool
    /// A busy stint at least this long counts as a long task.
    public var longTaskMinutes: Double
    public var limits: Bool
    /// Percent thresholds, e.g. [80, 95].
    public var limitThresholds: [Double]
    public var cliFailure: Bool
    /// Skip session notifications while the main window is key and showing that session.
    public var quietWhenViewing: Bool

    public init(waiting: Bool = true, longTask: Bool = true, longTaskMinutes: Double = 3, limits: Bool = true,
                limitThresholds: [Double] = [80, 95], cliFailure: Bool = false, quietWhenViewing: Bool = true) {
        self.waiting = waiting
        self.longTask = longTask
        self.longTaskMinutes = longTaskMinutes
        self.limits = limits
        self.limitThresholds = limitThresholds
        self.cliFailure = cliFailure
        self.quietWhenViewing = quietWhenViewing
    }

    public static let defaults = NotificationSettings()
}

/// What the main window shows right now.
public struct ViewingState: Equatable, Sendable {
    public var mainWindowKey: Bool
    /// The session selected on the Sessions screen, if that screen is showing.
    public var visibleSessionID: String?

    public init(mainWindowKey: Bool = false, visibleSessionID: String? = nil) {
        self.mainWindowKey = mainWindowKey
        self.visibleSessionID = visibleSessionID
    }

    public static let none = ViewingState()
}

public struct NotificationContext: Sendable {
    public var now: Date
    public var settings: NotificationSettings
    /// Muted `FleetSession.id`s.
    public var muted: Set<String>
    public var viewing: ViewingState

    public init(now: Date, settings: NotificationSettings = .defaults, muted: Set<String> = [], viewing: ViewingState = .none) {
        self.now = now
        self.settings = settings
        self.muted = muted
        self.viewing = viewing
    }
}

/// The CLI's state as far as the "can't read data" rule cares.
public enum CLIHealth: Equatable, Sendable {
    /// Connected and sending data.
    case healthy
    /// Restarting or failing to start.
    case failing
    /// Starting (between restart attempts too): keeps a failure timer running but doesn't start one.
    case pending
    /// No CLI involved (a fixture) or none to run: no failure to report.
    case inactive

    public init(_ connection: ConnectionState) {
        switch connection {
        case .connected: self = .healthy
        case .restarting, .failed: self = .failing
        case .idle, .starting: self = .pending
        case .cliMissing, .fixture: self = .inactive
        }
    }
}

public struct NotificationPolicy: Sendable {
    /// A session that left waiting comes back as the same episode unless it stayed away at least this long.
    public static let flapWindow: TimeInterval = 30
    /// The CLI must fail at least this long before "Signalbox can't read data".
    public static let cliFailureAfter: TimeInterval = 120
    /// Two readings of one limit whose `resetsAt` differ by less than this are the same window.
    public static let resetTolerance: TimeInterval = 10 * 60
    /// Without a reset time, a threshold re-arms once the reading drops this far below it.
    public static let rearmMargin: Double = 5
    /// Forget a session's history after it has been missing from the fleet this long.
    static let forgetSessionAfter: TimeInterval = 10 * 60

    struct SessionMemory: Sendable, Equatable {
        var isWaiting = false
        var leftWaitingAt: Date?
        var busySince: Date?
        var lastSeen: Date
    }

    struct LimitMemory: Sendable, Equatable {
        var resetsAt: Date?
        var fired: Set<Double> = []
        var observedAt: Date
    }

    private(set) var sessions: [String: SessionMemory] = [:]
    private(set) var limits: [String: LimitMemory] = [:]
    private(set) var failingSince: Date?
    private(set) var failureNotified = false

    public init() {}

    // MARK: Fleet

    /// Compares a new fleet with the previous one. `previous == nil` is app start: what's already true then
    /// (a session already waiting, a limit already past a threshold) is recorded, never notified.
    public mutating func evaluate(previous: FleetSnapshot?, current: FleetSnapshot, context: NotificationContext) -> [NotificationRequest] {
        let startup = previous == nil
        let now = context.now
        var out: [NotificationRequest] = []

        for s in current.sessions {
            var m = sessions[s.id] ?? SessionMemory(lastSeen: now)
            m.lastSeen = now
            let quiet = context.muted.contains(s.id)
                || (context.settings.quietWhenViewing && context.viewing.mainWindowKey && context.viewing.visibleSessionID == s.id)

            // Waiting: once per episode; an episode ends only after ≥ 30 s out of waiting.
            if s.status == .waiting {
                if !m.isWaiting {
                    let flap = m.leftWaitingAt.map { now.timeIntervalSince($0) < Self.flapWindow } ?? false
                    if !startup, !flap, context.settings.waiting, !quiet {
                        out.append(Self.waitingRequest(s, now: now))
                    }
                    m.isWaiting = true
                }
                m.leftWaitingAt = nil
            } else if m.isWaiting {
                m.isWaiting = false
                m.leftWaitingAt = now
            }

            // Long task: busy for at least N minutes, then idle or ended.
            switch s.status {
            case .busy:
                if m.busySince == nil {
                    m.busySince = s.statusSince.flatMap { $0 <= now ? $0 : nil } ?? now
                }
            case .idle, .ended:
                if let start = m.busySince {
                    let end = s.statusSince.flatMap { $0 >= start && $0 <= now ? $0 : nil } ?? now
                    let busy = end.timeIntervalSince(start)
                    if !startup, busy >= context.settings.longTaskMinutes * 60, context.settings.longTask, !quiet {
                        out.append(Self.longTaskRequest(s, busy: busy, end: end))
                    }
                    m.busySince = nil
                }
            case .waiting:
                // Waiting has its own notification; whatever runs after it is a new stint.
                m.busySince = nil
            case .unknown:
                // A read that failed this time says nothing about the stint.
                break
            }
            sessions[s.id] = m
        }
        let seen = Set(current.sessions.map(\.id))
        sessions = sessions.filter { seen.contains($0.key) || now.timeIntervalSince($0.value.lastSeen) < Self.forgetSessionAfter }

        out += evaluateLimits(current.limits, startup: startup, context: context)
        return out
    }

    private mutating func evaluateLimits(_ readings: [LimitSnapshot], startup: Bool, context: NotificationContext) -> [NotificationRequest] {
        let now = context.now
        let thresholds = Self.sanitize(context.settings.limitThresholds)
        var out: [NotificationRequest] = []
        for l in readings {
            let state = LimitState.of(l, now: now)
            // A reading from before its window reset says nothing about this window.
            if state == .resetPassed { continue }
            // A stale reading never notifies; at app start it still records what was already passed.
            if state == .stale, !startup { continue }
            var m = limits[l.id] ?? LimitMemory(resetsAt: l.resetsAt, observedAt: l.observedAt)
            if limits[l.id] != nil {
                // An older reading arriving late changes nothing.
                if l.observedAt < m.observedAt { continue }
                if Self.isNewWindow(old: m.resetsAt, new: l.resetsAt) {
                    m.fired = []
                } else if l.resetsAt == nil || m.resetsAt == nil {
                    // No reset time to go by: a threshold re-arms once the reading is well below it.
                    m.fired = m.fired.filter { l.usedPercent > $0 - Self.rearmMargin }
                }
                m.resetsAt = l.resetsAt ?? m.resetsAt
                m.observedAt = l.observedAt
            }
            let passed = thresholds.filter { l.usedPercent >= $0 }
            let fresh = passed.filter { !m.fired.contains($0) }
            if let highest = fresh.max(), !startup, context.settings.limits {
                out.append(Self.limitRequest(l, threshold: highest, now: now))
            }
            m.fired.formUnion(passed)
            limits[l.id] = m
        }
        return out
    }

    static func isNewWindow(old: Date?, new: Date?) -> Bool {
        guard let old, let new else { return false }
        return abs(new.timeIntervalSince(old)) >= resetTolerance
    }

    /// Thresholds in 1...100, each once, ascending.
    public static func sanitize(_ thresholds: [Double]) -> [Double] {
        Array(Set(thresholds.filter { $0.isFinite && $0 > 0 && $0 <= 100 })).sorted()
    }

    // MARK: CLI

    /// Called on a timer and on connection changes: fires once per failure episode, after 2 minutes.
    public mutating func evaluate(connection: CLIHealth, context: NotificationContext) -> [NotificationRequest] {
        let now = context.now
        switch connection {
        case .healthy, .inactive:
            failingSince = nil
            failureNotified = false
            return []
        case .failing:
            if failingSince == nil { failingSince = now }
        case .pending:
            break
        }
        guard let since = failingSince, !failureNotified, context.settings.cliFailure,
              now.timeIntervalSince(since) >= Self.cliFailureAfter
        else { return [] }
        failureNotified = true
        return [Self.cliFailureRequest(since: since, now: now)]
    }

    // MARK: Text (session name or folder plus agent; never message content)

    static func place(_ s: FleetSession) -> String {
        // The title is the name when there is one; then the folder adds where it is.
        guard let name = s.name, !name.isEmpty, let base = Fmt.basename(s.cwd), base != name else { return "" }
        return " in \(base)"
    }

    static func waitingRequest(_ s: FleetSession, now: Date) -> NotificationRequest {
        NotificationRequest(
            id: "waiting/\(s.id)/\(Int(now.timeIntervalSince1970))",
            kind: .waiting,
            title: "\(s.title) needs you",
            body: s.waitingLabel.map { "\(Fmt.agentName(s.agent)) is waiting (\($0))\(place(s))." }
                ?? "\(Fmt.agentName(s.agent)) is waiting for your input\(place(s)).",
            target: .session(s.id)
        )
    }

    static func longTaskRequest(_ s: FleetSession, busy: TimeInterval, end: Date) -> NotificationRequest {
        let after = s.status == .ended ? "has ended" : "is now idle"
        return NotificationRequest(
            id: "long-task/\(s.id)/\(Int(end.timeIntervalSince1970))",
            kind: .longTaskFinished,
            title: "\(s.title) finished",
            body: "\(Fmt.agentName(s.agent)) was busy for \(Fmt.duration(busy))\(place(s)) and \(after).",
            target: .session(s.id)
        )
    }

    static func limitRequest(_ l: LimitSnapshot, threshold: Double, now: Date) -> NotificationRequest {
        let period = l.resetsAt.map { String(Int($0.timeIntervalSince1970)) } ?? "none"
        return NotificationRequest(
            id: "limit/\(l.id)/\(Int(threshold))/\(period)",
            kind: .limit,
            title: "\(Fmt.agentName(l.agent)): \(Fmt.limitLabel(l)) at \(Fmt.percent(l.usedPercent))",
            body: "Past your \(Fmt.percent(threshold)) alert · \(Fmt.countdown(l.resetsAt, now: now)).",
            target: .limits
        )
    }

    static func cliFailureRequest(since: Date, now: Date) -> NotificationRequest {
        NotificationRequest(
            id: "cli-failure/\(Int(since.timeIntervalSince1970))",
            kind: .cliFailure,
            title: "Signalbox can't read data",
            body: "The signalbox CLI has been failing for \(Fmt.duration(now.timeIntervalSince(since))), so sessions and limits aren't current. Open Diagnostics for details.",
            target: .diagnostics
        )
    }

    static func testRequest(now: Date) -> NotificationRequest {
        NotificationRequest(
            id: "test/\(Int(now.timeIntervalSince1970))",
            kind: .test,
            title: "Signalbox notifications are on",
            body: "This is a test. You'll hear from Signalbox when a session needs you.",
            target: .app
        )
    }
}
