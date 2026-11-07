import Foundation

// Transcript retention (core RetentionInfo and retentionStatus): how long each Claude Code config folder keeps
// session transcripts before Claude Code deletes them (`cleanupPeriodDays`, default 30 days, a whole number of days,
// 1 or more). Once deleted, History and the cost figures lose them too. The CLI sends raw values; whether a period
// is too short is judged here, against your threshold (Settings ▸ Advanced), so changing it needs no CLI restart.

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
        source = (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0 } ?? "default"
        file = (try? c.decodeIfPresent(String.self, forKey: .file)).flatMap { $0 }
        invalid = (try? c.decodeIfPresent(String.self, forKey: .invalid)).flatMap { $0 }
        // Without the agent's default, a period can't be judged: decode fails and the row is dropped, not guessed.
        defaultDays = try c.decode(Int.self, forKey: .defaultDays)
        problem = (try? c.decodeIfPresent(String.self, forKey: .problem)).flatMap { $0 }
        sharesTranscriptsWith = (try? c.decodeIfPresent([String].self, forKey: .sharesTranscriptsWith)).flatMap { $0 }
    }

    /// The days in force (the value set, else the default); nil when invalid or unknown.
    public var effectiveDays: Int? { problem != nil || invalid != nil ? nil : (days ?? defaultDays) }
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
        let days = r.days ?? r.defaultDays
        return warnBelowDays > 0 && days < warnBelowDays ? .short : .ok
    }
}

public enum RetentionText {
    /// "365 days (settings.json)", "30 days (not set: the default)", "14 days (managed settings)".
    public static func value(_ r: RetentionInfo) -> String {
        if r.problem != nil { return "Unknown" }
        if let bad = r.invalid { return "Invalid: \(bad)" }
        let days = r.days ?? r.defaultDays
        return "\(days) \(days == 1 ? "day" : "days")"
    }

    public static func source(_ r: RetentionInfo) -> String {
        switch r.source {
        case "managed": "Set by your organization's managed settings"
        case "user": "Set in settings.json"
        case "default": "Not set: Claude Code's default"
        default: "From \(r.source)"
        }
    }

    /// The popover's line for the worst folder, or nil when none needs one.
    public static func warning(_ r: RetentionInfo, status: RetentionStatus, several: Bool) -> String? {
        let place = several ? " in \(Fmt.shortPath(r.configDir))" : ""
        switch status {
        case .short:
            let days = r.days ?? r.defaultDays
            return "Claude Code deletes transcripts older than \(days) days\(place)."
        case .invalid:
            return "Claude Code's cleanupPeriodDays\(place) is invalid (\(r.invalid ?? "?"))."
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
            return r.problem.map { Fmt.sentence("Can't tell: \($0)") }
        case .invalid:
            return "Claude Code takes a whole number of days, 1 or more. Interactive sessions report a settings error; runs that skip the broken value fall back to \(r.defaultDays) days."
        case .short:
            if r.source == "managed" { return "Your organization's managed settings set this, so only they can change it." }
            return "Add \"cleanupPeriodDays\": 365 to \(Fmt.shortPath(r.configDir))/settings.json to keep them for a year. Signalbox never edits it."
        }
    }
}
