import Foundation

// The History screen's logic, kept pure so it can be tested: which entries the filters and search keep, how they
// group under day and month headers, what a row's start time reads, where a live entry's pill leads, and the
// resume command the Copy button puts on the clipboard.

/// The History screen's range: calendar days by last activity, today included, or everything.
public enum HistoryRange: String, CaseIterable, Identifiable, Sendable {
    case week, month, all

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .week: "7 days"
        case .month: "30 days"
        case .all: "All"
        }
    }

    public var days: Int? {
        switch self {
        case .week: 7
        case .month: 30
        case .all: nil
        }
    }

    /// The first moment kept: the start of the earliest calendar day in range ("7 days" is today and the six days
    /// before it, as on Usage); nil for All.
    public func since(now: Date, calendar: Calendar = .current) -> Date? {
        guard let days else { return nil }
        let noon = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: now) ?? now
        guard let first = calendar.date(byAdding: .day, value: -(days - 1), to: noon) else { return nil }
        return calendar.startOfDay(for: first)
    }
}

/// The History screen's filters and search.
public struct HistoryFilter: Equatable, Sendable {
    /// nil: every agent.
    public var agent: AgentID?
    /// A project path; nil: every project.
    public var project: String?
    public var range: HistoryRange
    public var query: String
    /// Also list empty sessions (`HistoryBrowser.isEmpty`), which are hidden by default.
    public var showEmpty: Bool
    /// Also list sessions archived in the Claude app (`HistoryBrowser.isHiddenArchived`), hidden by default as in the app.
    public var showArchived: Bool

    public init(agent: AgentID? = nil, project: String? = nil, range: HistoryRange = .all, query: String = "", showEmpty: Bool = false,
                showArchived: Bool = false) {
        self.agent = agent
        self.project = project
        self.range = range
        self.query = query
        self.showEmpty = showEmpty
        self.showArchived = showArchived
    }

    public var isSearching: Bool { !HistoryBrowser.words(query).isEmpty }
    /// True when anything other than the search narrows the list.
    public var hasFilters: Bool { agent != nil || project != nil || range != .all }
}

/// A day or month of entries, under its header.
public struct HistoryDayGroup: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case today, yesterday
        /// Two to six days ago: the header is the weekday's name.
        case weekday
        /// Older: one group per calendar month.
        case month
    }

    /// "day:2026-10-09" or "month:2026-09": from calendar fields, never from formatted text.
    public let id: String
    public let kind: Kind
    /// The start of the day or of the month.
    public let start: Date
    public let title: String
    public var entries: [SessionHistoryEntry]
}

/// A project in the Project menu.
public struct HistoryProject: Identifiable, Hashable, Sendable {
    public let path: String
    /// The folder name, with its parent when another project has the same folder name ("clients/api").
    public let name: String
    public let count: Int

    public var id: String { path }
}

/// Where a row's Live pill leads.
public enum HistoryLiveRoute: Equatable, Sendable {
    /// Sessions, with the session selected.
    case session(FleetSession.ID)
    /// Sessions (no fleet yet to select it in).
    case sessions

    /// The screen it opens.
    public var section: SidebarSection { .sessions }

    /// The session it selects there, if any.
    public var sessionID: FleetSession.ID? {
        if case let .session(id) = self { return id }
        return nil
    }
}

public enum HistoryBrowser {
    // MARK: Order and filters

    /// Newest last activity first; then newest start; then id, so equal times keep a stable order.
    public static func isNewer(_ a: SessionHistoryEntry, _ b: SessionHistoryEntry) -> Bool {
        if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
        if a.startedAt != b.startedAt { return a.startedAt > b.startedAt }
        return a.id < b.id
    }

    /// A session opened and closed with nothing sent: no title, no response, not running. Such sessions have
    /// nothing to show (no title, no model, no cost), so the list hides them unless asked to.
    public static func isEmpty(_ entry: SessionHistoryEntry) -> Bool {
        entry.displayTitle == nil && entry.responses == 0 && !entry.live
    }

    /// Archived in the Claude app and not running now: hidden unless asked for, as the app hides its archived
    /// sessions. A running session stays in the list whatever the app says.
    public static func isHiddenArchived(_ entry: SessionHistoryEntry) -> Bool {
        entry.isArchived && !entry.live
    }

    /// The entries `filter` keeps, newest first. Empty sessions only with `showEmpty`, archived ones only with
    /// `showArchived`; either also when the search is the start of their session id.
    public static func filtered(_ entries: [SessionHistoryEntry], filter: HistoryFilter, now: Date, calendar: Calendar = .current) -> [SessionHistoryEntry] {
        let since = filter.range.since(now: now, calendar: calendar)
        let words = words(filter.query)
        return entries.filter { e in
            if let agent = filter.agent, e.agent != agent { return false }
            if let project = filter.project, e.project != project { return false }
            if let since, e.lastActivityAt < since { return false }
            if !filter.showEmpty, isEmpty(e), !matchesSessionId(e, words: words) { return false }
            if !filter.showArchived, isHiddenArchived(e), !matchesSessionId(e, words: words) { return false }
            return matches(e, words: words)
        }
        .sorted(by: isNewer)
    }

    /// How many empty sessions the other filters would keep: the ones `showEmpty` adds (or added).
    public static func emptyCount(_ entries: [SessionHistoryEntry], filter: HistoryFilter, now: Date, calendar: Calendar = .current) -> Int {
        var all = filter
        all.showEmpty = true
        return filtered(entries, filter: all, now: now, calendar: calendar).filter(isEmpty).count
    }

    /// How many archived sessions the other filters would keep: the ones `showArchived` adds (or added).
    public static func archivedCount(_ entries: [SessionHistoryEntry], filter: HistoryFilter, now: Date, calendar: Calendar = .current) -> Int {
        var all = filter
        all.showArchived = true
        return filtered(entries, filter: all, now: now, calendar: calendar).filter(isHiddenArchived).count
    }

    /// Case-, accent- and width-insensitive words of a search.
    public static func words(_ query: String) -> [String] {
        normalize(query).split(whereSeparator: \.isWhitespace).map(String.init)
    }

    static func normalize(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Every word of the search appears in the title or the project's folder name; a single word of six or more
    /// characters also matches the start of a session id (pasted from a terminal).
    public static func matches(_ entry: SessionHistoryEntry, query: String) -> Bool {
        matches(entry, words: words(query))
    }

    static func matches(_ entry: SessionHistoryEntry, words: [String]) -> Bool {
        guard !words.isEmpty else { return true }
        let haystack = normalize([entry.displayTitle, entry.projectName].compactMap { $0 }.joined(separator: " "))
        if words.allSatisfy({ haystack.contains($0) }) { return true }
        return matchesSessionId(entry, words: words)
    }

    /// The search is one word of six or more characters that starts the session id, or the Claude app's id for it.
    static func matchesSessionId(_ entry: SessionHistoryEntry, words: [String]) -> Bool {
        guard words.count == 1, words[0].count >= 6 else { return false }
        return [entry.sessionId, entry.appSessionId].contains { $0.map { normalize($0).hasPrefix(words[0]) } ?? false }
    }

    /// The agents with entries, in the usual agent order.
    public static func agents(_ entries: [SessionHistoryEntry]) -> [AgentID] {
        Set(entries.map(\.agent)).sorted()
    }

    /// The projects with entries, by folder name; a folder name two projects share gets its parent folder too.
    public static func projects(_ entries: [SessionHistoryEntry]) -> [HistoryProject] {
        var counts: [String: Int] = [:]
        for e in entries {
            guard let p = e.project, !p.isEmpty else { continue }
            counts[p, default: 0] += 1
        }
        let byName = Dictionary(grouping: counts.keys) { Fmt.basename($0) ?? $0 }
        return counts.map { path, count in
            let base = Fmt.basename(path) ?? path
            var name = base
            if (byName[base]?.count ?? 0) > 1 {
                let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
                if parts.count >= 2 { name = "\(parts[parts.count - 2])/\(base)" }
            }
            return HistoryProject(path: path, name: name, count: count)
        }
        .sorted { a, b in
            let order = a.name.localizedStandardCompare(b.name)
            return order != .orderedSame ? order == .orderedAscending : a.path < b.path
        }
    }

    // MARK: Day groups

    /// Whole calendar days from `date`'s day to `now`'s (0 today, 1 yesterday). Counted noon to noon and rounded, so
    /// a 23- or 25-hour day (a clock change) or a day that starts at 01:00 (a clock change at midnight) still
    /// counts as one. Negative for days after `now`'s.
    public static func daysAgo(_ date: Date, now: Date, calendar: Calendar = .current) -> Int {
        func noon(_ d: Date) -> Date { calendar.date(bySettingHour: 12, minute: 0, second: 0, of: d) ?? d }
        return Int((noon(now).timeIntervalSince(noon(date)) / 86_400).rounded())
    }

    /// Today, Yesterday, the weekday's name for two to six days ago, then one group per month, newest first.
    /// Entries sit under the day of their last activity (the order the list is sorted in); a date after today (a
    /// clock that ran ahead) counts as today. Group ids and order come from calendar fields, so they are the same
    /// in every locale; only the titles are localized.
    public static func groups(_ entries: [SessionHistoryEntry], now: Date, calendar: Calendar = .current,
                              locale: Locale = .autoupdatingCurrent) -> [HistoryDayGroup] {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let thisYear = calendar.component(.year, from: now)
        var groups: [HistoryDayGroup] = []
        var index: [String: Int] = [:]
        for e in entries.sorted(by: isNewer) {
            let ago = daysAgo(e.lastActivityAt, now: now, calendar: calendar)
            // A day of the last week, or a month; titles are formatted once per group.
            let day = ago <= 0 ? now : e.lastActivityAt
            let month = calendar.dateComponents([.year, .month], from: e.lastActivityAt)
            let id = ago < 7 ? "day:\(DayKey.key(day, calendar: calendar))" : String(format: "month:%04d-%02d", month.year ?? 0, month.month ?? 0)
            if let i = index[id] {
                groups[i].entries.append(e)
                continue
            }
            let group: HistoryDayGroup
            switch ago {
            case ...0:
                group = HistoryDayGroup(id: id, kind: .today, start: calendar.startOfDay(for: day), title: "Today", entries: [e])
            case 1:
                group = HistoryDayGroup(id: id, kind: .yesterday, start: calendar.startOfDay(for: day), title: "Yesterday", entries: [e])
            case 2..<7:
                group = HistoryDayGroup(id: id, kind: .weekday, start: calendar.startOfDay(for: day), title: day.formatted(style.weekday(.wide)), entries: [e])
            default:
                let title = month.year == thisYear ? day.formatted(style.month(.wide)) : day.formatted(style.month(.wide).year())
                group = HistoryDayGroup(id: id, kind: .month, start: calendar.date(from: month) ?? calendar.startOfDay(for: day), title: title, entries: [e])
            }
            index[id] = groups.count
            groups.append(group)
        }
        return groups
    }

    /// When the session started, as its row shows it under `kind`'s header: the time alone when it started on the
    /// day it sits under ("09:30"), with the weekday when it started earlier in the last week ("Wed 23:10"), and
    /// with the date under a month header or when it started longer ago ("14 Sep, 10:32").
    public static func startLabel(_ entry: SessionHistoryEntry, in kind: HistoryDayGroup.Kind, now: Date,
                                  calendar: Calendar = .current, locale: Locale = .autoupdatingCurrent) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let dated = entry.startedAt.formatted(style.day().month(.abbreviated).hour().minute())
        guard kind != .month else { return dated }
        let rowDay = max(0, daysAgo(entry.lastActivityAt, now: now, calendar: calendar))
        let startDay = max(rowDay, daysAgo(entry.startedAt, now: now, calendar: calendar))
        if startDay == rowDay { return entry.startedAt.formatted(style.hour().minute()) }
        if startDay < 7 { return entry.startedAt.formatted(style.weekday(.abbreviated).hour().minute()) }
        return dated
    }

    // MARK: Live sessions

    /// Where the Live pill leads, or nil when the session isn't live. The fleet (every 15 s) is fresher than the
    /// history (every few minutes), so with a fleet the entry is live only while the fleet has it busy, waiting or
    /// idle; without one, the entry's own flag decides.
    public static func liveRoute(_ entry: SessionHistoryEntry, fleet: FleetSnapshot?) -> HistoryLiveRoute? {
        guard let fleet else { return entry.live ? .sessions : nil }
        guard let s = fleet.sessions.first(where: { $0.agent == entry.agent && $0.sessionId == entry.sessionId }) else { return nil }
        switch s.status {
        case .busy, .waiting, .idle: return .session(s.id)
        case .ended, .unknown: return nil
        }
    }

    /// The fleet's status for a live entry (for the pill's colour), else nil.
    public static func liveStatus(_ entry: SessionHistoryEntry, fleet: FleetSnapshot?) -> SessionStatus? {
        guard case .session = liveRoute(entry, fleet: fleet) else { return nil }
        return fleet?.sessions.first { $0.agent == entry.agent && $0.sessionId == entry.sessionId }?.status
    }

    // MARK: Resume

    /// The whole resume line for a terminal: `cd '<dir>' && <command>`, the directory single-quoted for a POSIX
    /// shell (the resume's own directory, else the project's), or the command alone without one, or when that
    /// directory no longer exists (a `cd` into it would fail, and the command after it would never run). nil when
    /// there is no command, or when it spans lines (a paste must never run more than the one command).
    public static func resumeLine(_ entry: SessionHistoryEntry,
                                  directoryExists: (String) -> Bool = HistoryBrowser.directoryExists) -> String? {
        guard let resume = entry.resume else { return nil }
        let command = resume.command.trimmingCharacters(in: .whitespaces)
        guard !command.isEmpty, !command.contains(where: { $0.isNewline }),
              !command.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
        else { return nil }
        guard let dir = resumeDirectory(entry), directoryExists(dir) else { return command }
        return "cd \(shellQuote(dir)) && \(command)"
    }

    /// The directory a resume runs in: the resume's own, else the project's; nil without either.
    public static func resumeDirectory(_ entry: SessionHistoryEntry) -> String? {
        [entry.resume?.cwd, entry.project].compactMap { $0 }.first { !$0.isEmpty }
    }

    /// The resume directory when it is gone from this Mac (the resume line then leaves out the `cd`), else nil.
    public static func missingResumeDirectory(_ entry: SessionHistoryEntry,
                                              directoryExists: (String) -> Bool = HistoryBrowser.directoryExists) -> String? {
        guard resumeLine(entry, directoryExists: { _ in true }) != nil, let dir = resumeDirectory(entry), !directoryExists(dir) else { return nil }
        return dir
    }

    /// True when `path` is a directory on this Mac. Only its existence is checked; nothing in it is listed or read.
    public static func directoryExists(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    /// `s` in single quotes for sh/zsh/bash, each `'` written as `'\''`: nothing inside is expanded.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    /// `s` cut in the middle to at most `max` characters ("acme-platform…-service"), so both ends stay readable.
    public static func middleTruncated(_ s: String, max: Int) -> String {
        guard s.count > max, max >= 3 else { return s }
        let keep = max - 1
        let head = keep / 2
        return "\(s.prefix(head))…\(s.suffix(keep - head))"
    }

    // MARK: Totals

    /// The window subtitle's count: "59 sessions" when the list shows every session the CLI matched, else
    /// "52 of 59 sessions", so it agrees with the list's own count while filters or hidden empty sessions narrow it.
    public static func countLabel(shown: Int, total: Int) -> String {
        if shown >= total { return shown == 1 ? "1 session" : "\(shown) sessions" }
        return "\(shown) of \(total) \(total == 1 ? "session" : "sessions")"
    }

    /// The recorded cost of `entries`, nil when none has a cost. Sessions only in the Claude app's list have no
    /// figures, so they never add to it (nor turn a group of them into "$0.00").
    public static func totalCost(_ entries: [SessionHistoryEntry]) -> Double? {
        let costs = entries.filter(\.hasTranscript).compactMap(\.costUsd)
        return costs.isEmpty ? nil : costs.reduce(0, +)
    }

    // MARK: Row figures

    /// What a row's cost slot reads: the recorded cost, "cost unknown" for a transcript with none, and a dash for a
    /// session only in the Claude app's list (no transcript, so no usage: never "$0.00").
    public static func costLabel(_ entry: SessionHistoryEntry, money: Money = .usd) -> String {
        guard entry.hasTranscript else { return Fmt.dash }
        return entry.costUsd.map { money.amount($0) } ?? "cost unknown"
    }

    /// What a row's duration slot reads: how long it ran, a dash when unknown, and "No transcript" for a session only
    /// in the Claude app's list.
    public static func durationLabel(_ entry: SessionHistoryEntry) -> String {
        guard entry.hasTranscript else { return noTranscriptLabel }
        return entry.duration.map { Fmt.duration($0) } ?? Fmt.dash
    }

    /// The marker on a row whose session is only in the Claude app's list.
    public static let noTranscriptLabel = "No transcript"

    /// The model part of a row's second line: the main model ("claude-opus-5-5 +1"), "model unknown" for a
    /// transcript that names none, and nothing for a session only in the Claude app's list that names none (its
    /// row says "No transcript" instead).
    public static func modelLabel(_ entry: SessionHistoryEntry) -> String? {
        if let m = entry.primaryModel { return entry.models.count > 1 ? "\(m) +\(entry.models.count - 1)" : m }
        return entry.hasTranscript ? "model unknown" : nil
    }
}
