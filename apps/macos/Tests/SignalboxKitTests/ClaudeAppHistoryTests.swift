import Foundation
import Testing
@testable import SignalboxKit

// History with the Claude app's session list: the CLI merges the app's per-session records into the transcript
// sessions (the app's title wins) and adds the sessions the app lists without a transcript on this Mac ("app-only":
// no figures, no resume command). Archived sessions are hidden until asked for, as in the app. Settings ▸ Advanced
// turns the list off by restarting the CLI with --no-claude-app.

private let t0 = date("2026-10-09T14:30:00Z")

private func appOnly(_ id: String, title: String = "Sketch the onboarding checklist", last: Date = t0, archived: Bool = false,
                     models: [String] = [], costUsd: Double? = nil, live: Bool = false, agent: AgentID = .claudeCode) -> SessionHistoryEntry {
    SessionHistoryEntry(agent: agent, sessionId: id, title: title, titleSource: .app, appTitleSource: "auto", project: "/Users/you/code/web-app",
                        startedAt: last.addingTimeInterval(-2400), lastActivityAt: last, durationMs: 2_400_000, live: live, models: models,
                        costUsd: costUsd, appSessionId: id, archived: archived, hasTranscript: false)
}

private func transcript(_ id: String, title: String? = "Fix the build", last: Date = t0, appSessionId: String? = nil, archived: Bool? = nil,
                        cost: Double? = 1.25, responses: Int? = 12, live: Bool = false, agent: AgentID = .claudeCode) -> SessionHistoryEntry {
    SessionHistoryEntry(agent: agent, sessionId: id, title: title, titleSource: appSessionId == nil ? .custom : .app, project: "/Users/you/code/api",
                        startedAt: last.addingTimeInterval(-600), lastActivityAt: last, durationMs: 600_000, live: live,
                        models: ["claude-opus-5-5"], responses: responses, costUsd: cost, resume: HistoryResume(command: "claude --resume \(id)"),
                        transcriptPath: "/Users/you/.claude/projects/x/\(id).jsonl", appSessionId: appSessionId, archived: archived)
}

@Suite("History: the Claude app's list, decoding")
struct ClaudeAppDecodingTests {
    @Test func decodesEveryNewField() throws {
        let json = #"""
        {"v":1,"generatedAt":"2026-10-09T14:30:00Z","total":2,"truncated":false,
         "sources":{"transcripts":1,"claudeApp":{"enabled":true,"records":2,"merged":1,"appOnly":1,"archived":1}},
         "entries":[
          {"agent":"claude-code","sessionId":"s1","title":"Desktop title","titleSource":"app","appTitleSource":"user","startedAt":"2026-10-09T10:00:00Z","lastActivityAt":"2026-10-09T11:00:00Z","durationMs":3600000,"live":false,"hasTranscript":true,"appSessionId":"local_aaa","archived":false,"models":["claude-opus-5-5"],"effort":"high","responses":12,"tokens":{"input":1,"output":2,"cacheRead":3,"cacheWrite5m":4,"cacheWrite1h":5},"costUsd":1.5,"unpricedTokens":0,"placeholderShare":0,"compactions":0,"subagentFiles":0,"workflowRuns":0,"resume":{"command":"claude --resume s1"}},
          {"agent":"claude-code","sessionId":"local_bbb","title":"Only in the app","titleSource":"app","appTitleSource":"auto","startedAt":"2026-10-08T10:00:00Z","lastActivityAt":"2026-10-08T10:30:00Z","durationMs":1800000,"live":false,"hasTranscript":false,"appSessionId":"local_bbb","archived":true,"models":[]}
         ]}
        """#
        let h = try HistorySnapshot.decode(Data(json.utf8))
        let merged = try #require(h.entries.first)
        #expect(merged.titleSource == .app)
        #expect(merged.appTitleSource == "user")
        #expect(merged.titleSourceExplanation == "From the Claude app")
        #expect(merged.appSessionId == "local_aaa")
        #expect(merged.archived == false && !merged.isArchived)
        #expect(merged.hasTranscript && !merged.isAppOnly && merged.isInClaudeApp)
        #expect(merged.effort == "high")
        #expect(merged.duration == 3600)

        let only = try #require(h.entries.last)
        #expect(only.isAppOnly && only.isArchived && only.isInClaudeApp)
        #expect(only.titleSourceExplanation == "From the Claude app (generated)")
        // No transcript: every figure is unknown, never 0, and there's no duration, resume command or transcript.
        #expect(only.responses == nil && only.tokens == nil && only.costUsd == nil && only.unpricedTokens == nil)
        #expect(only.placeholderShare == nil && only.compactions == nil && only.subagentFiles == nil && only.workflowRuns == nil)
        #expect(only.durationMs == 1_800_000)
        #expect(only.duration == nil)
        #expect(only.resume == nil && only.transcriptPath == nil)
        #expect(!only.hasUnpriced)

        let app = try #require(h.claudeApp)
        #expect(app == ClaudeAppSource(enabled: true, records: 2, merged: 1, appOnly: 1, archived: 1))
        #expect(h.sources?.transcripts == 1)
    }

    @Test func olderCLIsAndOddValuesStayLenient() throws {
        // A CLI from before the app's list: no flags, no sources. Every entry has a transcript.
        let old = try HistorySnapshot.decode(Data(#"{"entries":[{"agent":"claude-code","sessionId":"a","lastActivityAt":"2026-10-09T11:00:00Z"}]}"#.utf8))
        #expect(old.sources == nil && old.claudeApp == nil)
        let a = try #require(old.entries.first)
        #expect(a.hasTranscript && a.appSessionId == nil && a.archived == nil && !a.isArchived && a.effort == nil && a.appTitleSource == nil)

        // Without the flag, an app entry with no sign of a transcript is app-only; with a path or responses it isn't.
        let h = try HistorySnapshot.decode(Data(#"""
        {"entries":[
          {"agent":"claude-code","sessionId":"b","appSessionId":"local_b","lastActivityAt":"2026-10-09T11:00:00Z"},
          {"agent":"claude-code","sessionId":"c","appSessionId":"local_c","transcriptPath":"/x/c.jsonl","lastActivityAt":"2026-10-09T11:00:00Z"},
          {"agent":"claude-code","sessionId":"d","appSessionId":"local_d","responses":3,"lastActivityAt":"2026-10-09T11:00:00Z"},
          {"agent":"claude-code","sessionId":"e","hasTranscript":"yes","archived":"no","appSessionId":7,"effort":2,"lastActivityAt":"2026-10-09T11:00:00Z"}
        ],
        "sources":{"transcripts":"many","claudeApp":{"records":4}}}
        """#.utf8))
        #expect(h.entries.map(\.hasTranscript) == [false, true, true, true])
        // Wrong types read as unknown and never cost the row.
        let e = try #require(h.entries.last)
        #expect(e.archived == nil && e.appSessionId == nil && e.effort == nil)
        #expect(h.sources?.transcripts == nil)
        // A source block without the flag still means the CLI read the list.
        #expect(h.claudeApp?.records == 4 && h.claudeApp?.enabled == true)

        // Turned off (--no-claude-app): the block says so, and the history has no app list.
        let off = try HistorySnapshot.decode(Data(#"{"entries":[],"sources":{"transcripts":0,"claudeApp":{"enabled":false,"records":0,"merged":0,"appOnly":0,"archived":0}}}"#.utf8))
        #expect(off.sources?.claudeApp?.enabled == false)
        #expect(off.claudeApp == nil)
    }

    @Test func theFixtureHasMergedAppOnlyAndArchivedSessions() throws {
        let h = try TestPaths.loadHistory()
        let app = try #require(h.claudeApp)
        let listed = h.entries.filter(\.isInClaudeApp)
        #expect(app.records == listed.count)
        #expect(app.merged == listed.filter(\.hasTranscript).count)
        #expect(app.appOnly == h.entries.filter(\.isAppOnly).count)
        #expect(app.archived == h.entries.filter(\.isArchived).count)
        #expect(h.sources?.transcripts == h.entries.filter(\.hasTranscript).count)
        #expect((app.merged ?? 0) > 0 && (app.appOnly ?? 0) > 0 && (app.archived ?? 0) > 0)
        // Only sessions in the app's list are archived, and the app's title is theirs.
        #expect(h.entries.filter { $0.archived != nil }.allSatisfy { $0.isInClaudeApp })
        #expect(listed.allSatisfy { $0.titleSource == .app })
        for e in h.entries.filter(\.isAppOnly) {
            #expect(e.costUsd == nil && e.responses == nil && e.tokens == nil && e.resume == nil && e.transcriptPath == nil)
            #expect(!e.live)
        }
        // The transcript sessions keep their figures.
        #expect(h.entries.filter { $0.hasTranscript && $0.isInClaudeApp }.allSatisfy { $0.costUsd != nil && $0.resume != nil })
    }

    @Test func theDebugLogCountsTheAppList() throws {
        let h = try TestPaths.loadHistory()
        let line = DebugLog.describe(.history(at: nil, h))
        #expect(line.contains("claudeApp=on appOnly=\(h.entries.filter(\.isAppOnly).count) archived=\(h.entries.filter(\.isArchived).count)"))
        for e in h.entries {
            if let t = e.title { #expect(!line.contains(t)) }
        }
        let off = HistorySnapshot(entries: [], sources: HistorySources(transcripts: 0, claudeApp: ClaudeAppSource(enabled: false)))
        #expect(DebugLog.describe(.history(at: nil, off)).contains("claudeApp=off"))
        #expect(DebugLog.describe(.history(at: nil, HistorySnapshot(entries: []))).contains("claudeApp=absent"))
    }

    @Test func decodesWhyTheListIsOff() throws {
        func source(_ json: String) throws -> ClaudeAppSource {
            let h = try HistorySnapshot.decode(Data(#"{"v":1,"entries":[],"total":0,"truncated":false,"sources":{"transcripts":0,"claudeApp":\#(json)}}"#.utf8))
            return try #require(h.sources?.claudeApp)
        }
        #expect(try source(#"{"enabled":false,"off":"flag","records":0}"#).offReason == .flag)
        #expect(try source(#"{"enabled":false,"off":"claude-config-dir","records":0}"#).offReason == .claudeConfigDir)
        // Older CLIs send no reason: the only one was the Settings switch.
        #expect(try source(#"{"enabled":false,"records":0}"#).offReason == .flag)
        // A reason from a newer CLI decodes, unnamed; a wrong type is dropped, never fatal.
        let newer = try source(#"{"enabled":false,"off":"something-new"}"#)
        #expect(newer.off == "something-new" && newer.offReason == nil)
        #expect(try source(#"{"enabled":false,"off":7}"#).off == nil)
        // On: no reason, whatever the field says.
        #expect(try source(#"{"enabled":true,"off":"flag"}"#).offReason == nil)
    }
}

@Suite("History: the Claude app's list, rows")
struct ClaudeAppRowTests {
    @Test func appOnlyRowsNeverShowZeroDollars() {
        let money = Money.usd
        // A dash where the cost goes and "No transcript" where the duration goes: never $0.00 or "cost unknown".
        let e = appOnly("local_a", models: ["claude-opus-5-5"])
        #expect(HistoryBrowser.costLabel(e, money: money) == "—")
        #expect(HistoryBrowser.durationLabel(e) == "No transcript")
        #expect(HistoryBrowser.modelLabel(e) == "claude-opus-5-5")
        // Even a CLI that sent a 0 for a session without a transcript reads as no usage.
        let zero = appOnly("local_z", costUsd: 0)
        #expect(HistoryBrowser.costLabel(zero, money: money) == "—")
        #expect(!HistoryBrowser.costLabel(zero, money: Money(currency: .gbp, rate: 0.79, rateAsOf: nil)).contains("0.00"))
        // Without a model, the row leaves it out (the marker says why) rather than "model unknown".
        #expect(HistoryBrowser.modelLabel(appOnly("local_b")) == nil)

        // A transcript session keeps its figures: a real 0 is $0.00, a missing one "cost unknown".
        #expect(HistoryBrowser.costLabel(transcript("t1", cost: 0), money: money) == "$0.00")
        #expect(HistoryBrowser.costLabel(transcript("t2", cost: nil), money: money) == "cost unknown")
        #expect(HistoryBrowser.costLabel(transcript("t3", cost: 1.25), money: money) == "$1.25")
        #expect(HistoryBrowser.durationLabel(transcript("t4")) == "10m")
        #expect(HistoryBrowser.modelLabel(transcript("t5")) == "claude-opus-5-5")
        var noModel = transcript("t6")
        noModel.models = []
        #expect(HistoryBrowser.modelLabel(noModel) == "model unknown")
    }

    @Test func totalsLeaveOutSessionsWithoutATranscript() {
        #expect(HistoryBrowser.totalCost([appOnly("local_a"), appOnly("local_z", costUsd: 0)]) == nil)
        #expect(HistoryBrowser.totalCost([appOnly("local_z", costUsd: 3), transcript("t1", cost: 1.25)]) == 1.25)
    }

    @Test func appOnlySessionsAreNotEmptyAndHaveNoResumeLine() {
        // No responses is unknown here, not zero: an app-only session with a title is never an "empty session".
        #expect(!HistoryBrowser.isEmpty(appOnly("local_a")))
        #expect(HistoryBrowser.resumeLine(appOnly("local_a"), directoryExists: { _ in true }) == nil)
        #expect(HistoryBrowser.missingResumeDirectory(appOnly("local_a"), directoryExists: { _ in false }) == nil)
    }

    @Test func searchFindsTheAppsIdToo() {
        let e = transcript("5e1f0c2a-3b4d", appSessionId: "local_0a1b2c3d")
        #expect(HistoryBrowser.matches(e, query: "local_0a1b"))
        #expect(HistoryBrowser.matches(e, query: "5e1f0c2a"))
        #expect(!HistoryBrowser.matches(e, query: "local"))
        #expect(HistoryBrowser.matches(appOnly("local_99887766"), query: "onboarding"))
    }
}

@Suite("History: archived sessions")
struct ArchivedFilterTests {
    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    var entries: [SessionHistoryEntry] {
        [
            transcript("t-plain"),
            transcript("t-in-app", appSessionId: "local_in", archived: false),
            transcript("t-archived", appSessionId: "local_ta", archived: true),
            transcript("t-archived-live", appSessionId: "local_tl", archived: true, live: true),
            transcript("t-archived-codex", archived: true, agent: .codex),
            appOnly("local_only"),
            appOnly("local_only-archived", archived: true),
            appOnly("local_old-archived", last: t0.addingTimeInterval(-40 * 86_400), archived: true),
        ]
    }

    func ids(_ f: HistoryFilter) -> [String] {
        HistoryBrowser.filtered(entries, filter: f, now: t0, calendar: utc).map(\.sessionId)
    }

    @Test func hiddenByDefaultLikeTheApp() {
        let shown = ids(HistoryFilter())
        #expect(Set(shown) == ["t-plain", "t-in-app", "t-archived-live", "local_only"])
        // A running session stays in the list whatever the app says.
        #expect(!HistoryBrowser.isHiddenArchived(entries[3]))
        #expect(HistoryBrowser.isHiddenArchived(entries[2]))
        #expect(!HistoryBrowser.isHiddenArchived(entries[1]))
        #expect(!HistoryBrowser.isHiddenArchived(entries[0]))
        // Asked for, they come back.
        #expect(ids(HistoryFilter(showArchived: true)).count == entries.count)
        // It isn't a filter the "Clear Filters" button resets, like the empty sessions.
        #expect(HistoryFilter(showArchived: true).hasFilters == false)
    }

    @Test func theCountFollowsTheOtherFilters() {
        func count(_ f: HistoryFilter) -> Int { HistoryBrowser.archivedCount(entries, filter: f, now: t0, calendar: utc) }
        #expect(count(HistoryFilter()) == 4)
        // The same whether they show or not, so the link reads "Show archived (4)" and then "Hide archived".
        #expect(count(HistoryFilter(showArchived: true)) == 4)
        #expect(count(HistoryFilter(agent: .codex)) == 1)
        #expect(count(HistoryFilter(range: .month)) == 3)
        #expect(count(HistoryFilter(query: "onboarding")) == 2)
        #expect(count(HistoryFilter(query: "nothing like it")) == 0)
    }

    @Test func aPastedIdStillFindsOne() {
        #expect(ids(HistoryFilter(query: "t-archived-codex")) == ["t-archived-codex"])
        #expect(ids(HistoryFilter(query: "local_ta")) == ["t-archived"])
        // A title search doesn't reach into the archive without the switch.
        #expect(ids(HistoryFilter(query: "onboarding")) == ["local_only"])
    }

    @Test func emptyAndArchivedAreSeparateSwitches() {
        var emptyArchived = transcript("t-empty-archived", title: nil, appSessionId: "local_e", archived: true, cost: 0, responses: 0)
        emptyArchived.models = []
        let all = entries + [emptyArchived]
        func filtered(_ f: HistoryFilter) -> [String] { HistoryBrowser.filtered(all, filter: f, now: t0, calendar: utc).map(\.sessionId) }
        #expect(!filtered(HistoryFilter(showArchived: true)).contains("t-empty-archived"))
        #expect(!filtered(HistoryFilter(showEmpty: true)).contains("t-empty-archived"))
        #expect(filtered(HistoryFilter(showEmpty: true, showArchived: true)).contains("t-empty-archived"))
        #expect(HistoryBrowser.emptyCount(all, filter: HistoryFilter(showArchived: true), now: t0, calendar: utc) == 1)
        #expect(HistoryBrowser.archivedCount(all, filter: HistoryFilter(showEmpty: true), now: t0, calendar: utc) == 5)
    }

    @Test func theFixturesArchivedSessions() throws {
        let h = try TestPaths.loadHistory()
        let now = try #require(h.generatedAt)
        let archived = h.entries.filter(\.isArchived)
        #expect(!archived.isEmpty)
        let shown = HistoryBrowser.filtered(h.entries, filter: HistoryFilter(), now: now)
        #expect(shown.allSatisfy { !HistoryBrowser.isHiddenArchived($0) })
        #expect(HistoryBrowser.archivedCount(h.entries, filter: HistoryFilter(), now: now) == archived.filter { !$0.live }.count)
        let all = HistoryBrowser.filtered(h.entries, filter: HistoryFilter(showEmpty: true, showArchived: true), now: now)
        #expect(all.count == h.entries.count)
        // The default list shows app-only sessions (they aren't hidden), with the archived ones left out.
        #expect(shown.contains { $0.isAppOnly })
    }
}

@MainActor
@Suite("History: the Claude app's list, setting and CLI")
struct ClaudeAppSettingTests {
    func launch() -> CLILaunch {
        CLILaunch(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [TestPaths.fakeCLI.path])
    }

    @Test func onByDefaultAndNothingWritten() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        #expect(s.includeClaudeAppSessions)
        #expect(s.watchOptions == CLIWatchOptions(includeClaudeApp: true))
        #expect(s.watchOptions.arguments.isEmpty)
        #expect(d.defaults.object(forKey: SettingsStore.Key.includeClaudeApp) == nil)
    }

    @Test func turningItOffAddsTheFlagToTheCLIsArgv() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        let on = CLIProcess.Configuration(launch: launch(), options: s.watchOptions).arguments(days: 7)
        #expect(on == [TestPaths.fakeCLI.path, "watch", "--ndjson", "--days", "7"])
        #expect(!on.contains("--no-claude-app"))

        s.includeClaudeAppSessions = false
        let off = CLIProcess.Configuration(launch: launch(), options: s.watchOptions).arguments(days: 30)
        #expect(off == [TestPaths.fakeCLI.path, "watch", "--ndjson", "--days", "30", "--no-claude-app"])
        #expect(launch().watchArguments(days: 1, options: s.watchOptions).last == CLIWatchOptions.noClaudeAppFlag)

        // It persists, and Reset All Settings turns it back on.
        #expect(d.defaults.object(forKey: SettingsStore.Key.includeClaudeApp) as? Bool == false)
        let reloaded = SettingsStore(defaults: d.defaults)
        #expect(!reloaded.includeClaudeAppSessions)
        #expect(reloaded.watchOptions.arguments == ["--no-claude-app"])
        reloaded.resetAll()
        #expect(reloaded.includeClaudeAppSessions)
        #expect(d.defaults.object(forKey: SettingsStore.Key.includeClaudeApp) == nil)
    }

    @Test func aWrongTypeFallsBackToOn() {
        let d = TestDefaults()
        d.defaults.set("no", forKey: SettingsStore.Key.includeClaudeApp)
        #expect(SettingsStore(defaults: d.defaults).includeClaudeAppSessions)
    }

    @Test func clearingTheHistoryShowsReadingUntilTheNewOne() throws {
        let store = SignalboxStore(clock: { t0 })
        store.handle(.started(pid: 1, command: "x"))
        store.handle(.message(.hello(version: "0.5.0", protocolVersion: 1, pid: 1)))
        let h = try TestPaths.loadHistory()
        store.handle(.message(.history(at: t0, h)))
        #expect(store.historyState(now: t0) == .ready)
        store.clearHistory()
        #expect(store.history == nil)
        #expect(store.historyUpdatedAt == nil)
        #expect(store.historyState(now: t0.addingTimeInterval(5)) == .loading)
        store.handle(.message(.history(at: t0, h)))
        #expect(store.history == h)
    }
}

/// The real transport starts the CLI with the flag, so the setting reaches the process, not just a struct.
@Suite("History: the Claude app's list, transport", .serialized)
struct ClaudeAppTransportTests {
    @Test(arguments: [true, false])
    func theSpawnedCLIGetsTheFlagOnlyWhenOff(_ include: Bool) async throws {
        var config = CLIProcess.Configuration(
            launch: CLILaunch(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [TestPaths.fakeCLI.path]),
            environment: ProcessInfo.processInfo.environment,
            options: CLIWatchOptions(includeClaudeApp: include),
            initialBackoff: .milliseconds(50),
            maxBackoff: .milliseconds(200),
            terminateGrace: .milliseconds(500)
        )
        config.stableAfter = .seconds(60)
        let cli = CLIProcess(configuration: config)
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)
        #expect(await rec.waitUntil { events in events.contains { if case .started = $0 { true } else { false } } })
        let command = await rec.events.compactMap { if case let .started(_, command) = $0 { command } else { nil } }.first
        let argv = try #require(command)
        #expect(argv.hasSuffix(include ? "watch --ndjson --days 7" : "watch --ndjson --days 7 --no-claude-app"))
        // The fake CLI ignores flags it doesn't know and still streams.
        #expect(await rec.waitUntil { $0.fleetCount >= 1 })
        await cli.stop()
        await rec.stop()
    }
}

/// A transport whose stop takes a while, like a CLI child given its grace period before SIGTERM.
private final class SlowStopTransport: SignalboxTransport, @unchecked Sendable {
    let events: AsyncStream<TransportEvent>
    let continuation: AsyncStream<TransportEvent>.Continuation
    private let delay: Duration

    init(stopDelay: Duration) {
        delay = stopDelay
        (events, continuation) = AsyncStream<TransportEvent>.makeStream()
    }

    func start(days: Int) async {}
    func send(_ command: StreamCommand) async {}
    func stop() async {
        try? await Task.sleep(for: delay)
        continuation.finish()
    }
}

/// Toggling the setting restarts the CLI; quick toggles must not leave a second child running or let the old
/// child's lines refill History.
@Suite("History: the Claude app's list, restarts")
@MainActor
struct ClaudeAppRestartTests {
    @Test func aConnectDuringASlowDisconnectKeepsItsEventsAndDropsTheOldOnes() async throws {
        let store = SignalboxStore(clock: { t0 })
        let old = SlowStopTransport(stopDelay: .milliseconds(200))
        store.connect(old)
        old.continuation.yield(.started(pid: 1, command: "old"))
        #expect(await eventually { store.cliPID == 1 })
        let stopping = Task { await store.disconnect() }
        try await Task.sleep(for: .milliseconds(30)) // the old CLI is inside its stop
        let new = FakeTransport()
        store.connect(new)
        // A history the old CLI drains while it stops is from the old setting: dropped.
        old.continuation.yield(.message(.history(at: t0, try TestPaths.loadHistory())))
        old.continuation.yield(.started(pid: 99, command: "old again"))
        await stopping.value
        // The disconnect that finished late must not have cancelled the new connection's event loop.
        new.continuation.yield(.started(pid: 2, command: "new"))
        #expect(await eventually { store.cliPID == 2 })
        #expect(store.history == nil)
        #expect(store.cliCommand == "new")
        await store.disconnect()
        #expect(new.stopped)
    }

    @Test func restartsRunOneAtATimeAndOnlyTheLatestWaitingOneRuns() async {
        let queue = LatestJobQueue()
        var ran: [Int] = []
        var running = 0
        var maxRunning = 0
        func job(_ n: Int) -> @MainActor @Sendable () async -> Void {
            { @MainActor in
                running += 1
                maxRunning = max(maxRunning, running)
                try? await Task.sleep(for: .milliseconds(40))
                ran.append(n)
                running -= 1
            }
        }
        // off, on, off while the first restart is still stopping the old CLI.
        let first = Task { await queue.run(job(1)) }
        try? await Task.sleep(for: .milliseconds(10))
        let second = Task { await queue.run(job(2)) }
        let third = Task { await queue.run(job(3)) }
        await first.value
        await second.value
        await third.value
        #expect(maxRunning == 1)
        #expect(ran == [1, 3])
        // A later request after the queue drained runs as usual.
        await queue.run(job(4))
        #expect(ran == [1, 3, 4])
    }
}
