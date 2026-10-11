import Foundation
import Testing
@testable import SignalboxKit

extension TestPaths {
    /// apps/macos/Fixtures/history.json: a synthetic session history (scripts/make-history-fixture.ts).
    static let historyFixture = snapshot.deletingLastPathComponent().appendingPathComponent("history.json")

    static func loadHistory() throws -> HistorySnapshot {
        try HistorySnapshot.decode(Data(contentsOf: historyFixture))
    }
}

/// A Gregorian calendar in `tz` (fixed, so the tests don't depend on the Mac's settings).
private func calendar(_ tz: String, _ id: Calendar.Identifier = .gregorian) -> Calendar {
    var c = Calendar(identifier: id)
    c.timeZone = TimeZone(identifier: tz)!
    c.locale = Locale(identifier: "en_US_POSIX")
    return c
}

/// A wall-clock time in `cal`'s time zone.
private func at(_ cal: Calendar, _ y: Int, _ mo: Int, _ d: Int, _ h: Int = 12, _ mi: Int = 0, _ s: Int = 0) -> Date {
    cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: s))!
}

private func entry(_ id: String, last: Date, started: Date? = nil, agent: AgentID = .claudeCode, title: String? = nil,
                   project: String? = nil, cost: Double? = nil, live: Bool = false, resume: HistoryResume? = nil) -> SessionHistoryEntry {
    SessionHistoryEntry(agent: agent, sessionId: id, title: title, project: project, startedAt: started ?? last.addingTimeInterval(-600),
                        lastActivityAt: last, live: live, costUsd: cost, resume: resume)
}

private let en = Locale(identifier: "en_US")

@Suite("History: decoding")
struct HistoryDecodingTests {
    @Test func decodesTheSyntheticFixture() throws {
        let h = try TestPaths.loadHistory()
        #expect(h.v == 1)
        #expect(h.generatedAt == date("2026-10-09T14:30:00.000Z"))
        #expect(h.entries.count == h.total)
        #expect(h.truncated == false)
        #expect(h.entries.count > 60)
        // Every title source the CLI sends, and live entries for the snapshot fixture's live sessions.
        #expect(Set(h.entries.map(\.titleSource)) == [.custom, .ai, .agentName, .index, .app, .none])
        let snapshot = try TestPaths.loadSnapshot()
        let liveIDs = Set(snapshot.fleet.sessions.filter { $0.status != .ended }.map(\.id))
        #expect(Set(h.entries.filter(\.live).map(\.id)) == liveIDs)
        // Newest first, as the CLI sends it.
        #expect(h.entries.map(\.lastActivityAt) == h.entries.map(\.lastActivityAt).sorted(by: >))
        let api = try #require(h.entries.first { $0.sessionId == "7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10" })
        #expect(api.title == "api-refactor")
        #expect(api.titleSource == .custom)
        #expect(api.resume?.command == "claude --resume 7f3a91c2-0b4e-4d8a-9a51-2c6f1e8d4b10")
        #expect(api.ledgerUsd != nil)
        #expect(api.tokens?.processed ?? 0 > 0)
        // The entry the CLI knows little about keeps its unknowns as nil, never 0.
        let bare = try #require(h.entries.first { $0.hasTranscript && $0.models.isEmpty && $0.responses == nil })
        #expect(bare.costUsd == nil)
        #expect(bare.tokens == nil)
        #expect(bare.resume == nil)
        #expect(bare.title == nil)
        #expect(bare.titleSource == .none)
    }

    @Test func theStreamLineCarriesIt() throws {
        let line = #"{"type":"history","at":"2026-10-09T14:30:05Z","data":{"v":1,"generatedAt":"2026-10-09T14:30:00Z","entries":[{"agent":"claude-code","sessionId":"s1","title":"Fix the build","titleSource":"custom","startedAt":"2026-10-09T10:00:00Z","lastActivityAt":"2026-10-09T11:00:00Z","durationMs":3600000,"live":false,"models":["claude-opus-5-5"],"responses":12,"tokens":{"input":1,"output":2,"cacheRead":3,"cacheWrite5m":4,"cacheWrite1h":5},"costUsd":1.5,"unpricedTokens":0,"placeholderShare":0,"compactions":1,"subagentFiles":0,"workflowRuns":0,"shiny":true}],"total":40,"truncated":true}}"#
        guard case let .history(at, h) = try StreamMessage.parse(line) else {
            Issue.record("not a history line")
            return
        }
        #expect(at == date("2026-10-09T14:30:05Z"))
        #expect(h.total == 40)
        #expect(h.truncated)
        let e = try #require(h.entries.first)
        #expect(e.id == "claude-code/s1")
        #expect(e.duration == 3600)
        #expect(e.tokens?.fresh == 12.0)
        #expect(e.primaryModel == "claude-opus-5-5")
        #expect(e.compactions == 1)
    }

    /// The real CLI's line for synthetic homes (scripts/make-stream-fixture.ts): the transcript has a generated title
    /// and then one set with /rename, and the Claude app's list has its own title for the session, which wins. The app
    /// also lists a session whose transcript isn't there and an archived one.
    @Test func theRealCLIsLinePrefersTheClaudeAppsTitle() throws {
        let text = try String(contentsOf: TestPaths.streamFixture, encoding: .utf8)
        let line = try #require(text.split(separator: "\n").first { $0.contains(#""type":"history""#) })
        guard case let .history(at, h) = try StreamMessage.parse(String(line)) else {
            Issue.record("not a history line")
            return
        }
        #expect(at != nil)
        let claude = try #require(h.entries.first { $0.agent == .claudeCode && $0.hasTranscript })
        #expect(claude.title == "Synthetic app title")
        #expect(claude.titleSource == .app)
        #expect(claude.appTitleSource == "user")
        #expect(claude.titleSourceExplanation == "From the Claude app")
        #expect(claude.appSessionId?.hasPrefix("local_") == true)
        #expect(claude.archived == false)
        #expect(claude.effort == "high")
        #expect(claude.live)
        #expect(claude.costUsd != nil)
        #expect(claude.resume?.command == "claude --resume \(claude.sessionId)")
        #expect(HistoryBrowser.resumeLine(claude, directoryExists: { _ in true })?.hasPrefix("cd '/Users/you/code/") == true)
        #expect(h.entries.contains { $0.agent == .codex && $0.titleSource == .index })
        // Every session with a transcript can be resumed; the app-only ones have nothing to resume and no figures.
        #expect(h.entries.filter(\.hasTranscript).allSatisfy { $0.resume != nil })
        let appOnly = h.entries.filter(\.isAppOnly)
        #expect(appOnly.count == 2)
        for e in appOnly {
            #expect(e.resume == nil)
            #expect(e.transcriptPath == nil)
            #expect(e.costUsd == nil && e.responses == nil && e.tokens == nil && e.compactions == nil)
            #expect(e.duration == nil)
            #expect(HistoryBrowser.costLabel(e) == "—")
            #expect(e.titleSourceExplanation == "From the Claude app (generated)")
        }
        #expect(appOnly.filter(\.isArchived).count == 1)
        let app = try #require(h.claudeApp)
        #expect(app.records == 3 && app.merged == 1 && app.appOnly == 2 && app.archived == 1)
        #expect(h.sources?.transcripts == h.entries.filter(\.hasTranscript).count)
        // Nothing but the allow-listed fields reaches the stream: the records' summaries and suggestions are dropped.
        #expect(!text.contains("synthetic summary") && !text.contains("synthetic suggestion"))
    }

    @Test func unknownTitleSourcesKeepTheTitle() throws {
        let h = try HistorySnapshot.decode(Data(#"{"entries":[{"agent":"claude-code","sessionId":"a","title":"Summarized","titleSource":"summary","lastActivityAt":"2026-10-09T11:00:00Z"},{"agent":"claude-code","sessionId":"b","title":"No source","lastActivityAt":"2026-10-09T11:00:00Z"},{"agent":"claude-code","sessionId":"c","lastActivityAt":"2026-10-09T11:00:00Z"}]}"#.utf8))
        #expect(h.entries.map(\.titleSource) == [.unknown, .unknown, .none])
        #expect(h.entries[0].displayTitle == "Summarized")
        #expect(h.entries[0].titleSource.explanation == "Reported by the CLI")
        #expect(HistoryTitleSource.none.explanation == nil)
        #expect(HistoryTitleSource.custom.explanation == "Set with /rename or in the Claude app")
        #expect(HistoryTitleSource.ai.explanation == "Generated by Claude Code")
        #expect(HistoryTitleSource.agentName.explanation == "Agent name")
        #expect(HistoryTitleSource.index.explanation == "Codex session name")
    }

    @Test func missingFieldsStayUnknown() throws {
        let h = try HistorySnapshot.decode(Data(#"{"entries":[{"agent":"codex","sessionId":"only-last","lastActivityAt":"2026-10-09T11:00:00Z"}]}"#.utf8))
        #expect(h.v == 1)
        #expect(h.generatedAt == nil)
        #expect(h.total == 1)
        #expect(h.truncated == false)
        let e = try #require(h.entries.first)
        #expect(e.startedAt == e.lastActivityAt)
        // One end stood in for the other, so the span isn't a duration.
        #expect(e.durationMs == nil)
        #expect(e.duration == nil)
        #expect(e.live == false)
        #expect(e.models.isEmpty)
        #expect(e.primaryModel == nil)
        #expect(e.costUsd == nil)
        #expect(e.responses == nil)
        #expect(e.tokens == nil)
        #expect(e.compactions == nil)
        #expect(e.resume == nil)
        #expect(e.project == nil)
        #expect(e.projectName == nil)
        #expect(!e.hasUnpriced)
    }

    @Test func bothEndsWithoutADurationGiveTheSpan() throws {
        let h = try HistorySnapshot.decode(Data(#"{"entries":[{"agent":"claude-code","sessionId":"a","startedAt":"2026-10-09T10:00:00Z","lastActivityAt":"2026-10-09T10:30:00Z"},{"agent":"claude-code","sessionId":"b","startedAt":"2026-10-09T11:00:00Z","lastActivityAt":"2026-10-09T10:00:00Z"}]}"#.utf8))
        #expect(h.entries[0].duration == 1800)
        #expect(h.entries[1].duration == nil)
    }

    @Test func malformedRowsAreDroppedAndBadExtrasReadAsUnknown() throws {
        let json = """
        {"total":"many","truncated":"yes","entries":[
          {"agent":"claude-code","sessionId":"no-times"},
          {"sessionId":"no-agent","lastActivityAt":"2026-10-09T11:00:00Z"},
          {"agent":"claude-code","sessionId":"bad-time","lastActivityAt":"yesterday"},
          {"agent":"claude-code","sessionId":"ok","lastActivityAt":"2026-10-09T11:00:00Z","costUsd":"12","tokens":{"input":"x"},
           "models":["a",7,"b"],"resume":{"cwd":"/x"},"live":"true","compactions":2.5,"title":42}
        ]}
        """
        let h = try HistorySnapshot.decode(Data(json.utf8))
        #expect(h.entries.map(\.sessionId) == ["ok"])
        #expect(h.total == 1)
        #expect(h.truncated == false)
        let e = h.entries[0]
        #expect(e.costUsd == nil)
        #expect(e.tokens == nil)
        #expect(e.models == ["a", "b"])
        #expect(e.resume == nil)
        #expect(e.live == false)
        #expect(e.compactions == nil)
        #expect(e.title == nil)
        #expect(e.titleSource == .none)
    }

    @Test func aHistoryLineWithoutDataIsAProtocolError() throws {
        #expect(throws: StreamParseError.self) { try StreamMessage.parse(#"{"type":"history","at":"2026-10-09T14:30:00Z"}"#) }
        guard case let .history(_, empty) = try StreamMessage.parse(#"{"type":"history","data":{}}"#) else {
            Issue.record("not a history line")
            return
        }
        #expect(empty.entries.isEmpty)
        #expect(empty.total == 0)
        guard case let .error(e) = try StreamMessage.parse(#"{"type":"error","scope":"history","message":"scan failed"}"#) else {
            Issue.record("not an error line")
            return
        }
        #expect(e.scope == .history)
    }

    @Test func aSnapshotMayCarryAHistory() throws {
        var snapshot = try TestPaths.loadSnapshot()
        #expect(snapshot.history == nil)
        snapshot.history = try TestPaths.loadHistory()
        let data = try SignalboxJSON.encoder().encode(snapshot)
        let back = try Snapshot.decode(data)
        #expect(back.history?.entries.count == snapshot.history?.entries.count)
    }

    @Test func titlesAreOneShortLine() {
        let base = entry("x", last: date("2026-10-09T11:00:00Z"))
        func shown(_ title: String?) -> String? {
            var e = base
            e.title = title
            return e.displayTitle
        }
        #expect(shown("Fix the build") == "Fix the build")
        #expect(shown("  Fix\nthe\tbuild\r\n ") == "Fix the build")
        #expect(shown("Fix\u{0007}the\u{2028}build") == "Fix the build")
        // A right-to-left override would make the title read differently from what it says.
        #expect(shown("Fix \u{202E}dliub\u{202C} now") == "Fix dliub now")
        #expect(shown("   \n\t") == nil)
        #expect(shown(nil) == nil)
        let long = String(repeating: "word ", count: 40)
        let cut = shown(long)
        #expect(cut?.count == SessionHistoryEntry.maxTitleLength)
        #expect(cut?.hasSuffix("…") == true)
        #expect(shown("日本語のタイトル 🎉") == "日本語のタイトル 🎉")
    }

    @Test func theDebugLogCountsWithoutTitles() throws {
        let h = try TestPaths.loadHistory()
        let line = DebugLog.describe(.history(at: nil, h))
        #expect(line.hasPrefix("history entries=\(h.entries.count) total=\(h.total) truncated=false"))
        #expect(line.contains("live=5"))
        for e in h.entries {
            if let t = e.title { #expect(!line.contains(t)) }
            if let p = e.projectName { #expect(!line.contains(p)) }
        }
    }
}

@Suite("History: day groups")
struct HistoryGroupingTests {
    let london = calendar("Europe/London")

    @Test func todayYesterdayWeekdaysThenMonths() {
        let c = london
        let now = at(c, 2026, 10, 9, 14, 30) // a Friday
        let entries = [
            entry("today-9", last: at(c, 2026, 10, 9, 9)),
            entry("today-midnight", last: at(c, 2026, 10, 9, 0, 0, 0)),
            entry("yesterday-late", last: at(c, 2026, 10, 8, 23, 59, 59)),
            entry("wednesday", last: at(c, 2026, 10, 7, 8)),
            entry("six-days", last: at(c, 2026, 10, 3, 0, 0, 1)),
            entry("seven-days", last: at(c, 2026, 10, 2, 23, 59)),
            entry("september", last: at(c, 2026, 9, 30, 18)),
            entry("last-year", last: at(c, 2025, 12, 31, 23)),
            // A clock that ran ahead: still today, and first.
            entry("tomorrow", last: at(c, 2026, 10, 10, 1)),
            entry("later-today", last: at(c, 2026, 10, 9, 18)),
        ]
        let groups = HistoryBrowser.groups(entries.shuffled(), now: now, calendar: c, locale: en)
        #expect(groups.map(\.id) == ["day:2026-10-09", "day:2026-10-08", "day:2026-10-07", "day:2026-10-03", "month:2026-10", "month:2026-09", "month:2025-12"])
        #expect(groups.map(\.title) == ["Today", "Yesterday", "Wednesday", "Saturday", "October", "September", "December 2025"])
        #expect(groups.map(\.kind) == [.today, .yesterday, .weekday, .weekday, .month, .month, .month])
        #expect(groups[0].entries.map(\.sessionId) == ["tomorrow", "later-today", "today-9", "today-midnight"])
        #expect(groups[1].entries.map(\.sessionId) == ["yesterday-late"])
        #expect(groups[4].entries.map(\.sessionId) == ["seven-days"])
        #expect(groups[0].start == at(c, 2026, 10, 9, 0))
        #expect(groups[5].start == at(c, 2026, 9, 1, 0))
        #expect(HistoryBrowser.groups([], now: now, calendar: c).isEmpty)
    }

    @Test func acrossMidnight() {
        let c = london
        let justAfter = at(c, 2026, 10, 9, 0, 0, 1)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 10, 8, 23, 59, 59), now: justAfter, calendar: c) == 1)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 10, 9, 0, 0, 0), now: justAfter, calendar: c) == 0)
        let justBefore = at(c, 2026, 10, 8, 23, 59, 59)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 10, 8, 0, 0, 0), now: justBefore, calendar: c) == 0)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 10, 9, 0, 0, 1), now: justBefore, calendar: c) == -1)
    }

    @Test func acrossClockChanges() {
        // New York falls back on 1 Nov 2026 (a 25-hour day).
        let ny = calendar("America/New_York")
        let monday = at(ny, 2026, 11, 2, 8)
        #expect(HistoryBrowser.daysAgo(at(ny, 2026, 11, 1, 0, 30), now: monday, calendar: ny) == 1)
        #expect(HistoryBrowser.daysAgo(at(ny, 2026, 11, 1, 23, 59), now: monday, calendar: ny) == 1)
        #expect(HistoryBrowser.daysAgo(at(ny, 2026, 10, 31, 23, 30), now: monday, calendar: ny) == 2)
        let lateSunday = at(ny, 2026, 11, 1, 23, 30)
        #expect(HistoryBrowser.daysAgo(at(ny, 2026, 11, 1, 0, 10), now: lateSunday, calendar: ny) == 0)
        #expect(HistoryBrowser.daysAgo(at(ny, 2026, 10, 31, 23, 50), now: lateSunday, calendar: ny) == 1)
        let groups = HistoryBrowser.groups([entry("sat", last: at(ny, 2026, 10, 31, 23, 30)), entry("sun", last: at(ny, 2026, 11, 1, 0, 30))],
                                           now: monday, calendar: ny, locale: en)
        #expect(groups.map(\.title) == ["Yesterday", "Saturday"])

        // London springs forward on 29 Mar 2026 (a 23-hour day).
        let c = london
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 3, 29, 0, 30), now: at(c, 2026, 3, 29, 23), calendar: c) == 0)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 3, 28, 23, 30), now: at(c, 2026, 3, 29, 23), calendar: c) == 1)
        #expect(HistoryBrowser.daysAgo(at(c, 2026, 3, 29, 23, 59), now: at(c, 2026, 3, 30, 0, 30), calendar: c) == 1)

        // Santiago moves its clocks at midnight (the day starts at 01:00): still one day apart.
        let cl = calendar("America/Santiago")
        #expect(HistoryBrowser.daysAgo(at(cl, 2026, 9, 6, 1, 30), now: at(cl, 2026, 9, 7, 0, 30), calendar: cl) == 1)
        #expect(HistoryBrowser.daysAgo(at(cl, 2026, 9, 5, 23, 30), now: at(cl, 2026, 9, 6, 10), calendar: cl) == 1)
        #expect(HistoryBrowser.daysAgo(at(cl, 2026, 9, 3, 12), now: at(cl, 2026, 9, 10, 12), calendar: cl) == 7)
    }

    /// Group ids, kinds and order come from calendar fields: the same in every locale. Only titles are localized.
    @Test func orderIsTheSameInEveryLocale() {
        let c = london
        let now = at(c, 2026, 10, 9, 14, 30)
        var entries: [SessionHistoryEntry] = []
        for i in 0..<120 { entries.append(entry("e\(i)", last: now.addingTimeInterval(-Double(i) * 7.3 * 3600))) }
        func shape(_ locale: Locale) -> [String] {
            HistoryBrowser.groups(entries, now: now, calendar: c, locale: locale).map { "\($0.id)|\($0.kind)|\($0.entries.map(\.sessionId))" }
        }
        let reference = shape(en)
        for id in ["en_GB", "de_DE", "fr_FR", "ja_JP", "zh_Hans_CN", "ar_SA", "he_IL", "th_TH", "tr_TR"] {
            let locale = Locale(identifier: id)
            #expect(shape(locale) == reference, "\(id)")
            #expect(HistoryBrowser.groups(entries, now: now, calendar: c, locale: locale).allSatisfy { !$0.title.isEmpty })
        }
        let titles = HistoryBrowser.groups(entries, now: now, calendar: c, locale: Locale(identifier: "de_DE")).map(\.title)
        #expect(titles.prefix(3) == ["Today", "Yesterday", "Mittwoch"])
        #expect(titles.contains("September"))
    }

    @Test func groupsFollowTheDateInOtherCalendars() {
        let now = date("2026-10-09T13:30:00Z")
        var entries: [SessionHistoryEntry] = []
        for i in 0..<90 { entries.append(entry("e\(i)", last: now.addingTimeInterval(-Double(i) * 23 * 3600))) }
        for id in [Calendar.Identifier.gregorian, .buddhist, .japanese, .islamicUmmAlQura, .hebrew, .persian] {
            let c = calendar("Europe/London", id)
            let groups = HistoryBrowser.groups(entries, now: now, calendar: c, locale: en)
            #expect(groups.first?.kind == .today, "\(id)")
            #expect(zip(groups, groups.dropFirst()).allSatisfy { $0.start > $1.start }, "\(id)")
            let flat = groups.flatMap(\.entries)
            #expect(flat.map(\.sessionId) == entries.map(\.sessionId), "\(id)")
            #expect(Set(groups.map(\.id)).count == groups.count, "\(id)")
        }
    }

    @Test func startLabels() {
        let c = london
        let now = at(c, 2026, 10, 9, 14, 30)
        let sameDay = entry("a", last: at(c, 2026, 10, 9, 11), started: at(c, 2026, 10, 9, 9, 5))
        #expect(HistoryBrowser.startLabel(sameDay, in: .today, now: now, calendar: c, locale: Locale(identifier: "en_GB")) == "09:05")
        let overnight = entry("b", last: at(c, 2026, 10, 9, 0, 40), started: at(c, 2026, 10, 8, 23, 10))
        #expect(HistoryBrowser.startLabel(overnight, in: .today, now: now, calendar: c, locale: Locale(identifier: "en_GB")) == "Thu 23:10")
        let longRunning = entry("c", last: at(c, 2026, 10, 9, 10), started: at(c, 2026, 9, 28, 16, 0))
        #expect(HistoryBrowser.startLabel(longRunning, in: .today, now: now, calendar: c, locale: Locale(identifier: "en_GB")).contains("28 Sep"))
        let old = entry("d", last: at(c, 2026, 9, 14, 11), started: at(c, 2026, 9, 14, 10, 32))
        #expect(HistoryBrowser.startLabel(old, in: .month, now: now, calendar: c, locale: Locale(identifier: "en_GB")).contains("14 Sep"))
        // A start after now (clock skew) still reads as a time.
        let skewed = entry("e", last: at(c, 2026, 10, 9, 16), started: at(c, 2026, 10, 9, 15))
        #expect(HistoryBrowser.startLabel(skewed, in: .today, now: now, calendar: c, locale: Locale(identifier: "en_GB")) == "15:00")
    }
}

@Suite("History: filters and search")
struct HistoryFilterTests {
    let c = calendar("Europe/London")
    var now: Date { at(c, 2026, 10, 9, 14, 30) }

    var entries: [SessionHistoryEntry] {
        [
            entry("aaaa1111-2222", last: at(c, 2026, 10, 9, 10), title: "Refactor the API client", project: "/Users/you/code/clients/acme/api", cost: 2),
            entry("bbbb", last: at(c, 2026, 10, 3, 0, 0, 0), title: "Café menu redesign", project: "/Users/you/code/web-app", cost: 1),
            entry("cccc", last: at(c, 2026, 10, 2, 23, 59, 59), agent: .codex, title: "Add retries", project: "/Users/you/code/personal/api"),
            entry("dddd", last: at(c, 2026, 9, 10, 0, 0, 0), project: "/Users/you/code/web-app", cost: 4),
            entry("eeee", last: at(c, 2026, 9, 9, 23, 0), agent: .codex, title: "Old work", project: "/Users/you/code/infra"),
        ]
    }

    func ids(_ f: HistoryFilter) -> [String] {
        HistoryBrowser.filtered(entries.reversed(), filter: f, now: now, calendar: c).map(\.sessionId)
    }

    @Test func rangesAreCalendarDays() {
        #expect(HistoryRange.week.since(now: now, calendar: c) == at(c, 2026, 10, 3, 0))
        #expect(HistoryRange.month.since(now: now, calendar: c) == at(c, 2026, 9, 10, 0))
        #expect(HistoryRange.all.since(now: now, calendar: c) == nil)
        #expect(ids(HistoryFilter()) == ["aaaa1111-2222", "bbbb", "cccc", "dddd", "eeee"])
        #expect(ids(HistoryFilter(range: .week)) == ["aaaa1111-2222", "bbbb"])
        #expect(ids(HistoryFilter(range: .month)) == ["aaaa1111-2222", "bbbb", "cccc", "dddd"])
        #expect(HistoryRange.allCases.map(\.title) == ["7 days", "30 days", "All"])
    }

    @Test func agentAndProject() {
        #expect(ids(HistoryFilter(agent: .codex)) == ["cccc", "eeee"])
        #expect(ids(HistoryFilter(project: "/Users/you/code/web-app")) == ["bbbb", "dddd"])
        #expect(ids(HistoryFilter(agent: .codex, project: "/Users/you/code/web-app")).isEmpty)
        #expect(HistoryFilter().hasFilters == false)
        #expect(HistoryFilter(range: .week).hasFilters)
        #expect(HistoryFilter(query: "  ").isSearching == false)
        #expect(HistoryFilter(query: "api").isSearching)
        #expect(HistoryFilter(query: "api").hasFilters == false)
    }

    @Test func searchLooksAtTitlesAndProjectFolders() {
        #expect(ids(HistoryFilter(query: "api")) == ["aaaa1111-2222", "cccc"])
        // Case, accents and word order don't matter; every word has to match somewhere.
        #expect(ids(HistoryFilter(query: "CAFE")) == ["bbbb"])
        #expect(ids(HistoryFilter(query: "retries api")) == ["cccc"])
        #expect(ids(HistoryFilter(query: "retries web")).isEmpty)
        // Untitled sessions are found by their project.
        #expect(ids(HistoryFilter(query: "web-app")) == ["bbbb", "dddd"])
        // The parent folders and the session's other fields aren't searched.
        #expect(ids(HistoryFilter(query: "clients")).isEmpty)
        #expect(ids(HistoryFilter(query: "Users")).isEmpty)
        // A pasted session id (six characters or more) finds its session.
        #expect(ids(HistoryFilter(query: "aaaa1111")) == ["aaaa1111-2222"])
        #expect(ids(HistoryFilter(query: "aaaa")).isEmpty)
        #expect(ids(HistoryFilter(agent: .claudeCode, range: .week, query: "api")) == ["aaaa1111-2222"])
    }

    @Test func emptySessionsAreHiddenUnlessAsked() {
        func empty(_ id: String, title: String? = nil, responses: Int? = 0, live: Bool = false, agent: AgentID = .claudeCode) -> SessionHistoryEntry {
            SessionHistoryEntry(agent: agent, sessionId: id, title: title, startedAt: at(c, 2026, 10, 9, 9), lastActivityAt: at(c, 2026, 10, 9, 9, 1),
                                live: live, responses: responses)
        }
        let all = entries + [
            empty("ffff0000-empty"),
            empty("ffff1111-empty", agent: .codex),
            empty("gggg-titled", title: "Named but nothing sent"),
            empty("hhhh-live", live: true),
            empty("iiii-unknown", responses: nil),
        ]
        func ids(_ f: HistoryFilter) -> [String] {
            HistoryBrowser.filtered(all, filter: f, now: now, calendar: c).map(\.sessionId)
        }
        #expect(HistoryBrowser.isEmpty(all[5]))
        // A title, a running session or unknown responses keep a session in the list.
        #expect(!HistoryBrowser.isEmpty(all[7]) && !HistoryBrowser.isEmpty(all[8]) && !HistoryBrowser.isEmpty(all[9]))
        #expect(!ids(HistoryFilter()).contains("ffff0000-empty"))
        #expect(ids(HistoryFilter()).contains("gggg-titled"))
        #expect(ids(HistoryFilter()).contains("hhhh-live"))
        #expect(ids(HistoryFilter()).contains("iiii-unknown"))
        #expect(ids(HistoryFilter(showEmpty: true)).filter { $0.hasSuffix("-empty") } == ["ffff0000-empty", "ffff1111-empty"])
        // A pasted session id still finds one.
        #expect(ids(HistoryFilter(query: "ffff0000")) == ["ffff0000-empty"])
        // The count follows the other filters, and stays the same whether they show or not.
        #expect(HistoryBrowser.emptyCount(all, filter: HistoryFilter(), now: now, calendar: c) == 2)
        #expect(HistoryBrowser.emptyCount(all, filter: HistoryFilter(showEmpty: true), now: now, calendar: c) == 2)
        #expect(HistoryBrowser.emptyCount(all, filter: HistoryFilter(agent: .codex), now: now, calendar: c) == 1)
        #expect(HistoryBrowser.emptyCount(all, filter: HistoryFilter(query: "api"), now: now, calendar: c) == 0)
        #expect(HistoryFilter(showEmpty: true).hasFilters == false)
    }

    @Test func projectsAndAgentsForTheMenus() {
        let projects = HistoryBrowser.projects(entries)
        #expect(projects.map(\.name) == ["acme/api", "infra", "personal/api", "web-app"])
        #expect(projects.first { $0.name == "web-app" }?.count == 2)
        #expect(projects.first { $0.name == "acme/api" }?.path == "/Users/you/code/clients/acme/api")
        #expect(HistoryBrowser.agents(entries.reversed()) == [.claudeCode, .codex])
        #expect(HistoryBrowser.projects([entry("x", last: now)]).isEmpty)
    }

    /// The window subtitle agrees with the list: "52 of 59 sessions" while filters or hidden empty sessions narrow it.
    @Test func theSubtitleCountsWhatTheListShows() {
        #expect(HistoryBrowser.countLabel(shown: 59, total: 59) == "59 sessions")
        #expect(HistoryBrowser.countLabel(shown: 1, total: 1) == "1 session")
        #expect(HistoryBrowser.countLabel(shown: 0, total: 0) == "0 sessions")
        #expect(HistoryBrowser.countLabel(shown: 52, total: 59) == "52 of 59 sessions")
        #expect(HistoryBrowser.countLabel(shown: 0, total: 1) == "0 of 1 session")
        // A list can't show more than the CLI matched; if a CLI says otherwise, the list's count wins.
        #expect(HistoryBrowser.countLabel(shown: 3, total: 2) == "3 sessions")
    }

    @Test func totalsAndShortNames() {
        #expect(HistoryBrowser.totalCost(entries) == 7)
        #expect(HistoryBrowser.totalCost([entry("x", last: now)]) == nil)
        #expect(HistoryBrowser.middleTruncated("short", max: 26) == "short")
        let cut = HistoryBrowser.middleTruncated("acme-platform-monorepo-packages-billing-service", max: 26)
        #expect(cut.count == 26)
        #expect(cut == "acme-platfor…lling-service")
        #expect(cut.contains("…"))
    }
}

@Suite("History: resume command")
struct HistoryResumeTests {
    let now = date("2026-10-09T14:30:00Z")

    /// The synthetic folders don't exist on this Mac: every one counts as present unless the test says otherwise.
    func line(_ command: String, cwd: String? = nil, project: String? = nil, exists: @escaping (String) -> Bool = { _ in true }) -> String? {
        HistoryBrowser.resumeLine(entry("s", last: now, project: project, resume: HistoryResume(command: command, cwd: cwd)), directoryExists: exists)
    }

    @Test func theDirectoryIsSingleQuoted() {
        #expect(line("claude --resume 7f3a", cwd: "/Users/you/code/api") == "cd '/Users/you/code/api' && claude --resume 7f3a")
        #expect(line("claude --resume 7f3a", cwd: "/Users/you/Client Work/site") == "cd '/Users/you/Client Work/site' && claude --resume 7f3a")
        #expect(line("claude --resume 7f3a", cwd: "/Users/you/o'reilly") == #"cd '/Users/you/o'\''reilly' && claude --resume 7f3a"#)
        // Without its own directory the resume runs in the project; without either, the command alone.
        #expect(line("codex resume r1", project: "/Users/you/infra") == "cd '/Users/you/infra' && codex resume r1")
        #expect(line("codex resume r1") == "codex resume r1")
        #expect(line("codex resume r1", cwd: "", project: "/p") == "cd '/p' && codex resume r1")
    }

    @Test func nothingToRunGivesNoLine() {
        #expect(line("") == nil)
        #expect(line("   ") == nil)
        #expect(line("claude --resume x\nrm -rf ~") == nil)
        #expect(line("claude --resume x\r") == nil)
        #expect(line("claude --resume x\u{1B}[2J") == nil)
        #expect(HistoryBrowser.resumeLine(entry("s", last: now, project: "/p")) == nil)
    }

    /// A `cd` into a deleted folder would fail and stop the command after it, so the line leaves it out and the
    /// inspector says why.
    @Test func aFolderThatIsGoneGetsNoCd() {
        let gone: (String) -> Bool = { $0 != "/Users/you/deleted" }
        #expect(line("claude --resume 7f3a", cwd: "/Users/you/deleted", exists: gone) == "claude --resume 7f3a")
        #expect(line("claude --resume 7f3a", cwd: "/Users/you/code/api", exists: gone) == "cd '/Users/you/code/api' && claude --resume 7f3a")
        // The resume's own directory decides; the project isn't a fallback for a folder that's gone.
        #expect(line("codex resume r1", cwd: "/Users/you/deleted", project: "/Users/you/code/api", exists: gone) == "codex resume r1")
        #expect(line("codex resume r1", project: "/Users/you/deleted", exists: gone) == "codex resume r1")

        let e = entry("s", last: now, resume: HistoryResume(command: "claude --resume 7f3a", cwd: "/Users/you/deleted"))
        #expect(HistoryBrowser.missingResumeDirectory(e, directoryExists: gone) == "/Users/you/deleted")
        #expect(HistoryBrowser.missingResumeDirectory(e, directoryExists: { _ in true }) == nil)
        // Nothing to resume, or no folder at all: nothing is missing.
        #expect(HistoryBrowser.missingResumeDirectory(entry("s", last: now, project: "/Users/you/deleted"), directoryExists: gone) == nil)
        #expect(HistoryBrowser.missingResumeDirectory(entry("s", last: now, resume: HistoryResume(command: "codex resume r1")), directoryExists: gone) == nil)
        #expect(HistoryBrowser.missingResumeDirectory(entry("s", last: now, resume: HistoryResume(command: "x\ny", cwd: "/Users/you/deleted")), directoryExists: gone) == nil)
    }

    @Test func theDiskCheckWantsADirectory() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("file.txt")
        try Data().write(to: file)
        #expect(HistoryBrowser.directoryExists(dir.path))
        #expect(!HistoryBrowser.directoryExists(file.path))
        #expect(!HistoryBrowser.directoryExists(dir.appendingPathComponent("gone").path))
        // The default check is the disk's.
        let e = entry("s", last: now, resume: HistoryResume(command: "claude --resume 7f3a", cwd: dir.appendingPathComponent("gone").path))
        #expect(HistoryBrowser.resumeLine(e) == "claude --resume 7f3a")
        #expect(HistoryBrowser.missingResumeDirectory(e) == dir.appendingPathComponent("gone").path)
    }

    /// The quoted string comes back unchanged from sh and zsh: nothing inside is expanded.
    @Test(arguments: ["/bin/sh", "/bin/zsh"])
    func shellsReadTheQuotedPathBack(_ shell: String) throws {
        let samples = [
            "/Users/you/code/Client Work/o'reilly-site",
            #"it's "quoted" $HOME `whoami` $(echo hi) \ back"#,
            "''",
            "",
            "tab\there; ls && echo pwned | cat > /dev/null",
            "ünïcödé/路径/🎉",
            "!history !! ^x^y^ * ? [a] ~ {a,b}",
        ]
        for s in samples {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: shell)
            p.arguments = ["-f", "-c", "printf '%s' " + HistoryBrowser.shellQuote(s)]
            p.environment = ["PATH": "/usr/bin:/bin", "HOME": "/nonexistent"]
            let out = Pipe()
            p.standardOutput = out
            try p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            #expect(p.terminationStatus == 0, "\(shell): \(s)")
            #expect(String(decoding: data, as: UTF8.self) == s, "\(shell): \(s)")
        }
    }
}

@Suite("History: live sessions")
struct HistoryLiveTests {
    let now = date("2026-10-09T14:30:00Z")

    func fleet(_ sessions: [FleetSession]) -> FleetSnapshot {
        FleetSnapshot(generatedAt: now, sessions: sessions)
    }

    @Test func thePillLeadsToTheSessionWhileTheFleetHasItRunning() {
        let e = entry("s1", last: now, live: true)
        for status in [SessionStatus.busy, .waiting, .idle] {
            let route = HistoryBrowser.liveRoute(e, fleet: fleet([FleetSession(agent: .claudeCode, sessionId: "s1", status: status)]))
            #expect(route == .session("claude-code/s1"))
            #expect(route?.sessionID == "claude-code/s1")
            #expect(route?.section == .sessions)
            #expect(HistoryBrowser.liveStatus(e, fleet: fleet([FleetSession(agent: .claudeCode, sessionId: "s1", status: status)])) == status)
        }
        // The fleet is fresher than the history: an ended or vanished session has no pill, whatever the entry says.
        #expect(HistoryBrowser.liveRoute(e, fleet: fleet([FleetSession(agent: .claudeCode, sessionId: "s1", status: .ended)])) == nil)
        #expect(HistoryBrowser.liveRoute(e, fleet: fleet([FleetSession(agent: .claudeCode, sessionId: "s1", status: .unknown)])) == nil)
        #expect(HistoryBrowser.liveRoute(e, fleet: fleet([])) == nil)
        // The same id from another agent is another session.
        #expect(HistoryBrowser.liveRoute(e, fleet: fleet([FleetSession(agent: .codex, sessionId: "s1", status: .busy)])) == nil)
        // And a session the entry calls ended but the fleet has running is live.
        let stale = entry("s2", last: now, live: false)
        #expect(HistoryBrowser.liveRoute(stale, fleet: fleet([FleetSession(agent: .claudeCode, sessionId: "s2", status: .busy)])) == .session("claude-code/s2"))
    }

    @Test func withoutAFleetTheEntryDecides() {
        #expect(HistoryBrowser.liveRoute(entry("s1", last: now, live: true), fleet: nil) == .sessions)
        #expect(HistoryBrowser.liveRoute(entry("s1", last: now, live: true), fleet: nil)?.sessionID == nil)
        #expect(HistoryBrowser.liveRoute(entry("s1", last: now, live: false), fleet: nil) == nil)
        #expect(HistoryBrowser.liveStatus(entry("s1", last: now, live: true), fleet: nil) == nil)
    }

    @Test func theFixturesLiveEntriesFindTheirSessions() throws {
        let snapshot = try TestPaths.loadSnapshot()
        let history = try TestPaths.loadHistory()
        let routes = history.entries.compactMap { HistoryBrowser.liveRoute($0, fleet: snapshot.fleet) }
        #expect(routes.count == history.entries.filter(\.live).count)
        for route in routes {
            #expect(snapshot.fleet.sessions.contains { $0.id == route.sessionID })
        }
    }
}

@MainActor
@Suite("History: store")
struct HistoryStoreTests {
    let t0 = date("2026-10-09T14:30:00Z")

    @Test func theLineFillsTheHistory() throws {
        let store = SignalboxStore(clock: { [t0] in t0 })
        #expect(store.historyState(now: t0) == .loading)
        store.handle(.started(pid: 1, command: "x"))
        store.handle(.message(.hello(version: "0.5.0", protocolVersion: 1, pid: 1)))
        #expect(store.historyState(now: t0.addingTimeInterval(60)) == .loading)
        store.handle(.message(.error(StreamError(scope: .history, message: "scan failed", at: t0))))
        #expect(store.streamErrors[.history]?.message == "scan failed")
        let h = try TestPaths.loadHistory()
        store.handle(.message(.history(at: t0, h)))
        #expect(store.history == h)
        #expect(store.historyUpdatedAt == t0)
        #expect(store.streamErrors[.history] == nil)
        #expect(store.historyState(now: t0.addingTimeInterval(500)) == .ready)
        let first = try #require(h.entries.first)
        #expect(store.historyEntry(id: first.id) == first)
        #expect(store.historyEntry(id: "claude-code/nope") == nil)
        #expect(store.historyEntry(id: nil) == nil)
    }

    @Test func aCLIThatNeverSendsItIsTooOld() {
        let store = SignalboxStore(clock: { [t0] in t0 })
        store.handle(.started(pid: 1, command: "x"))
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: 1)))
        #expect(store.historyState(now: t0.addingTimeInterval(SignalboxStore.historyGrace - 1)) == .loading)
        #expect(store.historyState(now: t0.addingTimeInterval(SignalboxStore.historyGrace)) == .cliTooOld)
        // The first scan takes longer than the command guide: the history waits longer before giving up.
        #expect(SignalboxStore.historyGrace > SignalboxStore.commandGuideGrace)
        store.handle(.exited(status: 1, signaled: false))
        store.handle(.restarting(attempt: 1, delay: .seconds(1)))
        #expect(store.historyState(now: t0.addingTimeInterval(60)) == .unavailable)
    }

    @Test func fixturesWithAndWithoutAHistory() throws {
        let store = SignalboxStore(clock: { [t0] in t0 })
        var snapshot = try TestPaths.loadSnapshot()
        store.load(snapshot: snapshot, name: "snapshot.json")
        #expect(store.historyState(now: t0) == .notInSnapshot)
        store.load(history: try TestPaths.loadHistory())
        #expect(store.historyState(now: t0) == .ready)
        #expect(store.historyUpdatedAt == date("2026-10-09T14:30:00.000Z"))

        let other = SignalboxStore(clock: { [t0] in t0 })
        snapshot.history = HistorySnapshot(entries: [])
        other.load(snapshot: snapshot, name: "with-history.json")
        #expect(other.historyState(now: t0) == .ready)
        #expect(other.history?.entries.isEmpty == true)
    }
}
