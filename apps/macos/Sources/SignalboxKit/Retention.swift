import Foundation

// Transcript retention (core RetentionInfo and retentionStatus): how long each Claude Code config folder keeps
// session transcripts before Claude Code deletes them (`cleanupPeriodDays`, default 30 days, a whole number of days,
// 1 or more). Once deleted, History and the cost figures lose them too. The CLI sends raw values; whether a period
// is too short is judged here, against your threshold (Settings ▸ Advanced), so changing it needs no CLI restart.
// From Claude Code 2.1.248 on, desktop app sessions are kept at any age unless managed settings set the period or
// desktopSessionCleanupPeriodDays is set; while the period is invalid or can't be read, Claude Code pauses the cleanup.

/// One config folder's retention, as far as the managed settings and the folder's settings.json say.
public struct RetentionInfo: Codable, Hashable, Sendable, Identifiable {
    public var agent: AgentID
    public var configDir: String
    /// The value in force, in days; nil when nothing sets it (the default applies) or when it is invalid.
    public var days: Int?
    /// "managed", "user" or "default"; anything newer passes through.
    public var source: String
    public var file: String?
    /// The value as written when it isn't a whole number of days, 1 or more.
    public var invalid: String?
    public var defaultDays: Int
    /// A file that could have set it couldn't be read: the value in force can't be told.
    public var problem: String?
    public var sharesTranscriptsWith: [String]?

    public var id: String { "\(agent.rawValue)/\(configDir)" }

    public init(agent: AgentID = .claudeCode, configDir: String, days: Int? = nil, source: String = "default", file: String? = nil,
                invalid: String? = nil, defaultDays: Int = 30, problem: String? = nil, sharesTranscriptsWith: [String]? = nil) {
        self.agent = agent
        self.configDir = configDir
        self.days = days
        self.source = source
        self.file = file
        self.invalid = invalid
        self.defaultDays = defaultDays
        self.problem = problem
        self.sharesTranscriptsWith = sharesTranscriptsWith
    }

    enum CodingKeys: String, CodingKey { case agent, configDir, days, source, file, invalid, defaultDays, problem, sharesTranscriptsWith }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        configDir = try c.decode(String.self, forKey: .configDir)
        // A days value that isn't a whole number of days, 1 or more, is never shown as one.
        days = (try? c.decodeIfPresent(Int.self, forKey: .days)).flatMap { $0 }.flatMap { $0 >= 1 ? $0 : nil }
        // Without a source, a missing `days` can't be told apart from "not set": decode fails and the row is dropped.
        source = try c.decode(String.self, forKey: .source)
        file = (try? c.decodeIfPresent(String.self, forKey: .file)).flatMap { $0 }
        invalid = (try? c.decodeIfPresent(String.self, forKey: .invalid)).flatMap { $0 }
        // Without the agent's default, a period can't be judged: decode fails and the row is dropped, not guessed.
        defaultDays = try c.decode(Int.self, forKey: .defaultDays)
        problem = (try? c.decodeIfPresent(String.self, forKey: .problem)).flatMap { $0 }
        sharesTranscriptsWith = (try? c.decodeIfPresent([String].self, forKey: .sharesTranscriptsWith)).flatMap { $0 }
    }

    /// No value can be told: a file couldn't be read, or a file set it but no valid number of days came through.
    public var isUndetermined: Bool { problem != nil || (invalid == nil && days == nil && source != "default") }

    /// The days in force (the value set, else the default); nil when invalid or unknown.
    public var effectiveDays: Int? { isUndetermined || invalid != nil ? nil : (days ?? defaultDays) }
}

public enum RetentionStatus: String, Sendable, Comparable {
    /// Kept at least as long as you asked for.
    case ok
    /// Kept for fewer days than your threshold.
    case short
    /// The setting isn't a whole number of days, 1 or more: Claude Code reports a settings error.
    case invalid
    /// A settings file couldn't be read.
    case unknown

    /// For "the worst one": invalid, then short, then unknown, then ok.
    private var rank: Int {
        switch self {
        case .ok: 0
        case .unknown: 1
        case .short: 2
        case .invalid: 3
        }
    }

    public static func < (a: Self, b: Self) -> Bool { a.rank < b.rank }

    /// core retentionStatus. `warnBelowDays` 0 turns the "short" check off.
    public static func of(_ r: RetentionInfo, warnBelowDays: Int) -> Self {
        if r.problem != nil { return .unknown }
        if r.invalid != nil { return .invalid }
        guard let days = r.effectiveDays else { return .unknown }
        return warnBelowDays > 0 && days < warnBelowDays ? .short : .ok
    }
}

public enum RetentionText {
    /// The version from which Claude Code keeps desktop app sessions unless told otherwise (core CLAUDE_CODE_DESKTOP_KEPT_SINCE).
    public static let desktopKeptSince = "2.1.248"

    static func days(_ n: Int) -> String { "\(n) \(n == 1 ? "day" : "days")" }

    /// "365 days", "1 day", "Invalid: 0", "Unknown".
    public static func value(_ r: RetentionInfo) -> String {
        if let bad = r.invalid, r.problem == nil { return "Invalid: \(bad)" }
        guard let n = r.effectiveDays else { return "Unknown" }
        return days(n)
    }

    public static func source(_ r: RetentionInfo) -> String {
        switch r.source {
        case "managed": "Set by your organization's managed settings"
        case "user": "Set in \(r.file.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "a settings file")"
        case "default": "Not set: \(Fmt.agentName(r.agent))'s default"
        default: "From \(r.source)"
        }
    }

    /// The popover's line for the worst folder, or nil when none needs one.
    public static func warning(_ r: RetentionInfo, status: RetentionStatus, several: Bool) -> String? {
        let place = several ? " in \(Fmt.shortPath(r.configDir))" : ""
        let name = Fmt.agentName(r.agent)
        switch status {
        case .short:
            guard let n = r.effectiveDays else { return nil }
            // Unless managed settings set it, Claude Code keeps desktop app sessions (from 2.1.248 on).
            let what = r.agent == .claudeCode && r.source != "managed" ? "terminal transcripts" : "transcripts"
            return "\(name) deletes \(what) older than \(days(n))\(place)."
        case .invalid:
            let setting = r.agent == .claudeCode ? "cleanupPeriodDays" : "retention setting"
            return "\(name)'s \(setting)\(place) is invalid (\(r.invalid ?? "?"))."
        case .ok, .unknown:
            return nil
        }
    }

    /// What to do about it, for the Health screen.
    public static func advice(_ r: RetentionInfo, status: RetentionStatus) -> String? {
        switch status {
        case .ok:
            return nil
        case .unknown:
            return Fmt.sentence("Can't tell: \(r.problem ?? "no valid value came through for this folder")")
        case .invalid:
            guard r.agent == .claudeCode else { return nil }
            return "Claude Code takes a whole number of days, 1 or more. Until it's fixed, interactive sessions report a settings error and Claude Code pauses its cleanup, so nothing is deleted."
        case .short:
            guard r.agent == .claudeCode else { return nil }
            if r.source == "managed" {
                return "Your organization's managed settings set this, so only they can change it. An MDM profile or console-served settings, if your organization uses them, replace the managed files; Signalbox can't see those."
            }
            return "Add \"cleanupPeriodDays\": 365 to \(Fmt.shortPath(r.configDir))/settings.json to keep them for a year. Signalbox never edits it. Desktop app sessions are kept from Claude Code \(desktopKeptSince) on, unless desktopSessionCleanupPeriodDays is set."
        }
    }
}
