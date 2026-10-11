import Foundation
import Observation

// The app-facing side of notifications: what a notifier can do, the dry-run notifier, click routing, and
// the per-session mute list. The UNUserNotificationCenter notifier lives in the app target.

/// Whether notifications can be shown.
public enum NotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    /// Can't use the notification center at all (e.g. not running from an app bundle).
    case unavailable(String)
    /// SIGNALBOX_NOTIFY_DRYRUN: notifications are logged to stderr, never shown.
    case dryRun

    public var canPost: Bool {
        switch self {
        case .authorized, .provisional, .dryRun: true
        default: false
        }
    }
}

@MainActor
public protocol Notifier: AnyObject {
    var authorization: NotificationAuthorization { get }
    /// Re-reads the permission (e.g. when Settings opens; the user may have changed it in System Settings).
    func refreshAuthorization() async
    /// Asks for permission. Only ever called from a user action (the Sessions banner or Settings).
    func requestAuthorization() async
    /// Shows `request` if allowed; otherwise drops it.
    func post(_ request: NotificationRequest)
}

public enum NotifyDryRun {
    public static let environmentKey = "SIGNALBOX_NOTIFY_DRYRUN"

    public static func isEnabled(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        guard let v = environment[environmentKey] else { return false }
        return !DebugLog.offValues.contains(v.trimmingCharacters(in: .whitespaces).lowercased())
    }

    /// `notify kind=waiting target=session:claude-code/abc title=docs sweep needs you`, on one line.
    public static func line(_ r: NotificationRequest) -> String {
        let title = r.title.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        return "notify kind=\(r.kind.rawValue) target=\(r.target.encoded) title=\(title)"
    }
}

/// Logs each notification as one stderr line and never touches the notification center, so automated runs
/// never trigger the permission prompt.
@MainActor
@Observable
public final class DryRunNotifier: Notifier {
    public private(set) var authorization: NotificationAuthorization = .dryRun
    /// Everything "posted", oldest first (tests read it).
    public private(set) var posted: [NotificationRequest] = []
    @ObservationIgnored private let sink: @Sendable (String) -> Void

    public init(sink: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }) {
        self.sink = sink
    }

    public func refreshAuthorization() async {}
    public func requestAuthorization() async {}

    public func post(_ request: NotificationRequest) {
        posted.append(request)
        sink(NotifyDryRun.line(request))
    }
}

// MARK: - Click routing

public enum NotificationRoute: Equatable, Sendable {
    /// Open the main window on this target.
    case open(NotificationTarget)
    /// "Mute this session" from the notification.
    case mute(sessionID: String)
    case ignore
}

public enum NotificationRouting {
    public static let targetKey = "signalbox.target"
    public static let kindKey = "signalbox.kind"
    public static let openAction = "signalbox.open"
    public static let muteAction = "signalbox.mute"
    /// Notifications about one session: Open, Mute this session.
    public static let sessionCategory = "signalbox.session"
    /// Everything else: Open.
    public static let generalCategory = "signalbox.general"
    /// UNNotificationDefaultActionIdentifier and UNNotificationDismissActionIdentifier.
    public static let defaultAction = "com.apple.UNNotificationDefaultActionIdentifier"
    public static let dismissAction = "com.apple.UNNotificationDismissActionIdentifier"

    public static func userInfo(for request: NotificationRequest) -> [String: String] {
        [targetKey: request.target.encoded, kindKey: request.kind.rawValue]
    }

    public static func category(for request: NotificationRequest) -> String {
        request.target.sessionID == nil ? generalCategory : sessionCategory
    }

    /// What a click (or an action button) on a notification should do.
    public static func route(actionIdentifier: String, userInfo: [String: String]) -> NotificationRoute {
        let target = userInfo[targetKey].flatMap(NotificationTarget.init(encoded:)) ?? .app
        switch actionIdentifier {
        case dismissAction:
            return .ignore
        case muteAction:
            if let id = target.sessionID { return .mute(sessionID: id) }
            return .open(target)
        case defaultAction, openAction:
            return .open(target)
        default:
            return .ignore
        }
    }
}

// MARK: - Mutes

/// Sessions the user muted. A mute lasts for the session's lifetime: it goes when the session ends, or after
/// the session has been missing from the fleet for 10 minutes.
public struct MuteList: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var mutedAt: Date
        /// When the session was last in a fleet (refreshed every couple of minutes, not on every fleet).
        public var lastSeen: Date
    }

    public static let absentGrace: TimeInterval = 10 * 60
    static let seenGranularity: TimeInterval = 120

    public private(set) var entries: [String: Entry] = [:]

    public init(entries: [String: Entry] = [:]) {
        self.entries = entries
    }

    public var ids: Set<String> { Set(entries.keys) }
    public var isEmpty: Bool { entries.isEmpty }
    public var count: Int { entries.count }

    public func contains(_ id: String) -> Bool { entries[id] != nil }

    public mutating func mute(_ id: String, now: Date) {
        entries[id] = Entry(mutedAt: now, lastSeen: now)
    }

    public mutating func unmute(_ id: String) {
        entries[id] = nil
    }

    public mutating func removeAll() {
        entries = [:]
    }

    /// Drops mutes of ended or long-gone sessions. Returns whether anything changed (so the caller saves).
    @discardableResult
    public mutating func prune(fleet: FleetSnapshot, now: Date) -> Bool {
        guard !entries.isEmpty else { return false }
        let byID = Dictionary(fleet.sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var changed = false
        for (id, entry) in entries {
            if let s = byID[id] {
                if s.status == .ended {
                    entries[id] = nil
                    changed = true
                } else if now.timeIntervalSince(entry.lastSeen) >= Self.seenGranularity {
                    entries[id]?.lastSeen = now
                    changed = true
                }
            } else if now.timeIntervalSince(entry.lastSeen) >= Self.absentGrace {
                entries[id] = nil
                changed = true
            }
        }
        return changed
    }
}
