import Foundation
import Testing
@testable import SignalboxKit

/// Drives a policy through a sequence of fleets, the way the coordinator does (previous = the last fleet).
struct PolicyHarness {
    var policy = NotificationPolicy()
    var previous: FleetSnapshot?
    var settings = NotificationSettings.defaults
    var muted: Set<String> = []
    var viewing = ViewingState.none

    mutating func step(_ sessions: [FleetSession], limits: [LimitSnapshot] = [], at now: Date) -> [NotificationRequest] {
        let current = FleetSnapshot(generatedAt: now, sessions: sessions, limits: limits)
        let out = policy.evaluate(previous: previous, current: current,
                                  context: NotificationContext(now: now, settings: settings, muted: muted, viewing: viewing))
        previous = current
        return out
    }

    mutating func connection(_ health: CLIHealth, at now: Date) -> [NotificationRequest] {
        policy.evaluate(connection: health, context: NotificationContext(now: now, settings: settings, muted: muted, viewing: viewing))
    }
}

func session(_ id: String, _ status: SessionStatus, since: Date? = nil, name: String? = "docs sweep",
             cwd: String? = "/Users/you/code/signalbox", agent: AgentID = .claudeCode) -> FleetSession {
    FleetSession(agent: agent, sessionId: id, cwd: cwd, name: name, status: status, statusSince: since)
}

func limit(_ used: Double, kind: String = "five_hour", observed: Date, resets: Date?, agent: AgentID = .claudeCode, window: Double? = 300) -> LimitSnapshot {
    LimitSnapshot(agent: agent, kind: kind, usedPercent: used, resetsAt: resets, windowMinutes: window, observedAt: observed)
}

@Suite("Notification policy")
struct NotificationPolicyTests {
    let t0 = date("2026-10-09T14:30:00Z")

    func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    // MARK: Waiting

    @Test func waitingTransitionFiresOnceWithNameFolderAndAgent() {
        var h = PolicyHarness()
        #expect(h.step([session("a", .busy)], at: at(0)).isEmpty)
        let out = h.step([session("a", .waiting)], at: at(15))
        #expect(out.count == 1)
        let r = out[0]
        #expect(r.kind == .waiting)
        #expect(r.target == .session("claude-code/a"))
        #expect(r.title == "docs sweep needs you")
        #expect(r.body == "Claude Code is waiting for your input in signalbox.")
        #expect(r.id == "waiting/claude-code/a/\(Int(at(15).timeIntervalSince1970))")
        // Still waiting: the same episode, nothing new.
        #expect(h.step([session("a", .waiting)], at: at(30)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(45)).isEmpty)
    }

    @Test func theWaitingLabelGoesInTheBodyWhenTheAgentGivesOne() {
        var h = PolicyHarness()
        _ = h.step([session("a", .busy)], at: at(0))
        var s = session("a", .waiting)
        s.waitingFor = "permission prompt"
        #expect(h.step([s], at: at(15)).first?.body == "Claude Code is waiting (permission prompt) in signalbox.")
        // Anything that isn't a short one-line label is ignored.
        var long = session("b", .waiting)
        long.waitingFor = String(repeating: "x", count: FleetSession.maxWaitingLabel)
        #expect(long.waitingLabel != nil, "the CLI's own limit fits")
        long.waitingFor = String(repeating: "x", count: FleetSession.maxWaitingLabel + 1)
        #expect(long.waitingLabel == nil)
        long.waitingFor = "two\nlines"
        #expect(long.waitingLabel == nil)
        var idle = session("c", .idle)
        idle.waitingFor = "input needed"
        #expect(idle.waitingLabel == nil, "only while waiting")
    }

    @Test func aSessionAlreadyWaitingAtStartupIsIgnored() {
        var h = PolicyHarness()
        #expect(h.step([session("a", .waiting)], at: at(0)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(15)).isEmpty)
        // A short trip out of waiting is the same (ignored) episode.
        #expect(h.step([session("a", .busy)], at: at(20)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(35)).isEmpty)
        // Away for 30 s or more: a new episode, which fires.
        #expect(h.step([session("a", .busy)], at: at(40)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(70)).map(\.kind) == [.waiting])
    }

    @Test func flapsAreSuppressedUntilThirtySecondsAway() {
        var h = PolicyHarness()
        _ = h.step([session("a", .idle)], at: at(0))
        #expect(h.step([session("a", .waiting)], at: at(10)).count == 1)
        #expect(h.step([session("a", .busy)], at: at(12)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(41)).isEmpty, "29 s away is a flap")
        #expect(h.step([session("a", .busy)], at: at(50)).isEmpty)
        #expect(h.step([session("a", .waiting)], at: at(80)).count == 1, "30 s away is a new episode")
    }

    @Test func aNewSessionThatAppearsWaitingFires() {
        var h = PolicyHarness()
        _ = h.step([session("a", .busy)], at: at(0))
        let out = h.step([session("a", .busy), session("b", .waiting, name: nil, cwd: "/Users/you/code/infra", agent: .codex)], at: at(15))
        #expect(out.count == 1)
        // No name: the folder is the title, and isn't repeated in the body.
        #expect(out.first?.title == "infra needs you")
        #expect(out.first?.body == "Codex is waiting for your input.")
    }

    @Test func titlesNeverGoBeyondNameFolderOrID() {
        var h = PolicyHarness()
        _ = h.step([], at: at(0))
        let out = h.step([session("0123456789abcdef", .waiting, name: nil, cwd: nil)], at: at(5))
        #expect(out.first?.title == "01234567 needs you")
        #expect(out.first?.body == "Claude Code is waiting for your input.")
    }

    @Test func waitingRespectsTheSettingWithoutFiringLater() {
        var h = PolicyHarness()
        h.settings.waiting = false
        _ = h.step([session("a", .busy)], at: at(0))
        #expect(h.step([session("a", .waiting)], at: at(15)).isEmpty)
        // Turning it on mid-episode doesn't fire for a wait that already started.
        h.settings.waiting = true
        #expect(h.step([session("a", .waiting)], at: at(30)).isEmpty)
    }

    // MARK: Long task

    @Test func longTaskFinishedAfterEnoughBusyTime() {
        var h = PolicyHarness()
        _ = h.step([session("a", .idle)], at: at(0))
        _ = h.step([session("a", .busy, since: at(10))], at: at(15))
        #expect(h.step([session("a", .busy, since: at(10))], at: at(120)).isEmpty)
        let out = h.step([session("a", .idle, since: at(250))], at: at(255))
        #expect(out.count == 1)
        #expect(out[0].kind == .longTaskFinished)
        #expect(out[0].title == "docs sweep finished")
        // From the busy statusSince to the idle statusSince: exactly 4 minutes.
        #expect(out[0].body == "Claude Code was busy for 4m in signalbox and is now idle.")
        #expect(out[0].target == .session("claude-code/a"))
    }

    @Test func shortBusyStintsDontCount() {
        var h = PolicyHarness()
        _ = h.step([session("a", .idle)], at: at(0))
        _ = h.step([session("a", .busy, since: at(0))], at: at(5))
        #expect(h.step([session("a", .idle, since: at(170))], at: at(175)).isEmpty, "2m 50s is under 3 minutes")
        h.settings.longTaskMinutes = 10
        _ = h.step([session("a", .busy, since: at(200))], at: at(205))
        #expect(h.step([session("a", .idle)], at: at(200 + 9 * 60)).isEmpty)
    }

    @Test func aStintRunningAtStartupCountsFromItsStatusSince() {
        var h = PolicyHarness()
        _ = h.step([session("a", .busy, since: at(-600))], at: at(0))
        let out = h.step([session("a", .ended)], at: at(15))
        #expect(out.map(\.kind) == [.longTaskFinished])
        #expect(out.first?.body.contains("busy for 10m") == true)
        #expect(out.first?.body.hasSuffix("and has ended.") == true)
    }

    @Test func waitingInTheMiddleStartsANewStint() {
        var h = PolicyHarness()
        _ = h.step([session("a", .busy, since: at(0))], at: at(0))
        _ = h.step([session("a", .waiting)], at: at(600))
        _ = h.step([session("a", .busy, since: at(620))], at: at(625))
        // Only 40 s busy since the wait.
        #expect(h.step([session("a", .idle, since: at(660))], at: at(665)).isEmpty)
    }

    @Test func anUnknownReadingKeepsTheStint() {
        var h = PolicyHarness()
        _ = h.step([session("a", .idle)], at: at(0))
        _ = h.step([session("a", .busy, since: at(0))], at: at(5))
        _ = h.step([session("a", .unknown)], at: at(100))
        #expect(h.step([session("a", .idle)], at: at(300)).map(\.kind) == [.longTaskFinished])
    }

    // MARK: Mute and quiet

    @Test func mutedSessionsStayQuiet() {
        var h = PolicyHarness()
        h.muted = ["claude-code/a"]
        _ = h.step([session("a", .busy, since: at(0)), session("b", .busy, since: at(0))], at: at(0))
        let out = h.step([session("a", .waiting), session("b", .waiting)], at: at(15))
        #expect(out.map(\.target) == [.session("claude-code/b")])
        _ = h.step([session("a", .busy, since: at(20)), session("b", .busy, since: at(20))], at: at(20))
        let done = h.step([session("a", .idle), session("b", .idle)], at: at(400))
        #expect(done.map(\.target) == [.session("claude-code/b")])
    }

    @Test func quietWhileTheWindowShowsThatSession() {
        var h = PolicyHarness()
        h.viewing = ViewingState(mainWindowKey: true, visibleSessionID: "claude-code/a")
        _ = h.step([session("a", .idle), session("b", .idle)], at: at(0))
        let out = h.step([session("a", .waiting), session("b", .waiting)], at: at(15))
        #expect(out.map(\.target) == [.session("claude-code/b")])

        // The window in the background: no longer "looking at" it.
        var h2 = PolicyHarness()
        h2.viewing = ViewingState(mainWindowKey: false, visibleSessionID: "claude-code/a")
        _ = h2.step([session("a", .idle)], at: at(0))
        #expect(h2.step([session("a", .waiting)], at: at(15)).count == 1)

        // The rule is optional.
        var h3 = PolicyHarness()
        h3.settings.quietWhenViewing = false
        h3.viewing = ViewingState(mainWindowKey: true, visibleSessionID: "claude-code/a")
        _ = h3.step([session("a", .idle)], at: at(0))
        #expect(h3.step([session("a", .waiting)], at: at(15)).count == 1)
    }

    // MARK: Limits

    @Test func eachThresholdOncePerResetPeriod() {
        var h = PolicyHarness()
        let reset1 = at(3 * 3600)
        #expect(h.step([], limits: [limit(50, observed: at(0), resets: reset1)], at: at(0)).isEmpty)
        let first = h.step([], limits: [limit(82, observed: at(60), resets: reset1)], at: at(60))
        #expect(first.count == 1)
        #expect(first[0].kind == .limit)
        #expect(first[0].target == .limits)
        #expect(first[0].title == "Claude Code: 5-hour window at 82%")
        #expect(first[0].body == "Past your 80% alert · resets in 2h 59m.")
        #expect(h.step([], limits: [limit(85, observed: at(120), resets: reset1)], at: at(120)).isEmpty)
        #expect(h.step([], limits: [limit(96, observed: at(180), resets: reset1)], at: at(180)).map(\.body) == ["Past your 95% alert · resets in 2h 57m."])
        #expect(h.step([], limits: [limit(97, observed: at(240), resets: reset1)], at: at(240)).isEmpty)
        // The window resets: thresholds re-arm.
        let reset2 = reset1.addingTimeInterval(5 * 3600)
        #expect(h.step([], limits: [limit(10, observed: reset1.addingTimeInterval(60), resets: reset2)], at: reset1.addingTimeInterval(60)).isEmpty)
        #expect(h.step([], limits: [limit(81, observed: reset1.addingTimeInterval(120), resets: reset2)], at: reset1.addingTimeInterval(120)).count == 1)
    }

    @Test func aJumpPastBothThresholdsFiresTheHigherOnce() {
        var h = PolicyHarness()
        let reset = at(3600)
        _ = h.step([], limits: [limit(40, observed: at(0), resets: reset)], at: at(0))
        let out = h.step([], limits: [limit(97, observed: at(30), resets: reset)], at: at(30))
        #expect(out.count == 1)
        #expect(out.first?.body.hasPrefix("Past your 95% alert") == true)
        #expect(out.first?.id == "limit/claude-code/five_hour/95/\(Int(reset.timeIntervalSince1970))")
    }

    @Test func thresholdsAlreadyPassedAtStartupAreNotNotified() {
        var h = PolicyHarness()
        let reset = at(3600)
        #expect(h.step([], limits: [limit(88, observed: at(0), resets: reset)], at: at(0)).isEmpty)
        #expect(h.step([], limits: [limit(90, observed: at(60), resets: reset)], at: at(60)).isEmpty)
        #expect(h.step([], limits: [limit(95, observed: at(120), resets: reset)], at: at(120)).count == 1)
    }

    @Test func staleAndResetPassedReadingsAreIgnored() {
        var h = PolicyHarness()
        let reset = at(3 * 3600)
        _ = h.step([], at: at(0))
        // Observed 20 minutes before now: stale.
        #expect(h.step([], limits: [limit(90, observed: at(-1200), resets: reset)], at: at(15)).isEmpty)
        // A reading from before its window reset.
        #expect(h.step([], limits: [limit(99, kind: "seven_day", observed: at(-60), resets: at(-30), window: 10080)], at: at(20)).isEmpty)
        // The same window read fresh: it fires now.
        #expect(h.step([], limits: [limit(90, observed: at(25), resets: reset)], at: at(30)).count == 1)
    }

    @Test func aStaleReadingAtStartupStillRecordsWhatWasPassed() {
        var h = PolicyHarness()
        let reset = at(3 * 3600)
        #expect(h.step([], limits: [limit(85, observed: at(-1800), resets: reset)], at: at(0)).isEmpty)
        // Fresh, same window, nothing new passed.
        #expect(h.step([], limits: [limit(86, observed: at(10), resets: reset)], at: at(15)).isEmpty)
    }

    @Test func aLateOlderReadingChangesNothing() {
        var h = PolicyHarness()
        let reset = at(3600)
        _ = h.step([], limits: [limit(50, observed: at(0), resets: reset)], at: at(0))
        _ = h.step([], limits: [limit(70, observed: at(100), resets: reset)], at: at(100))
        #expect(h.step([], limits: [limit(85, observed: at(50), resets: reset)], at: at(110)).isEmpty)
    }

    @Test func resetTimesThatJitterAreTheSameWindow() {
        var h = PolicyHarness()
        _ = h.step([], limits: [limit(50, observed: at(0), resets: at(3600))], at: at(0))
        #expect(h.step([], limits: [limit(81, observed: at(30), resets: at(3603))], at: at(30)).count == 1)
        #expect(h.step([], limits: [limit(83, observed: at(60), resets: at(3598))], at: at(60)).isEmpty)
    }

    @Test func withoutAResetTimeAThresholdReArmsAfterADrop() {
        var h = PolicyHarness()
        _ = h.step([], limits: [limit(50, observed: at(0), resets: nil)], at: at(0))
        #expect(h.step([], limits: [limit(81, observed: at(30), resets: nil)], at: at(30)).count == 1)
        #expect(h.step([], limits: [limit(77, observed: at(60), resets: nil)], at: at(60)).isEmpty)
        #expect(h.step([], limits: [limit(80, observed: at(90), resets: nil)], at: at(90)).isEmpty, "4 points under isn't a reset")
        #expect(h.step([], limits: [limit(20, observed: at(120), resets: nil)], at: at(120)).isEmpty)
        #expect(h.step([], limits: [limit(80, observed: at(150), resets: nil)], at: at(150)).count == 1)
    }

    @Test func limitsArePerAgentAndKind() {
        var h = PolicyHarness()
        let reset = at(3600)
        _ = h.step([], limits: [limit(10, observed: at(0), resets: reset), limit(10, kind: "codex.primary", observed: at(0), resets: reset, agent: .codex)], at: at(0))
        let out = h.step([], limits: [limit(81, observed: at(30), resets: reset), limit(81, kind: "codex.primary", observed: at(30), resets: reset, agent: .codex)], at: at(30))
        #expect(out.map(\.title) == ["Claude Code: 5-hour window at 81%", "Codex: Primary window at 81%"])
    }

    @Test func disabledLimitAlertsStillTrackSoTheyDontFireLate() {
        var h = PolicyHarness()
        h.settings.limits = false
        let reset = at(3600)
        _ = h.step([], limits: [limit(10, observed: at(0), resets: reset)], at: at(0))
        #expect(h.step([], limits: [limit(85, observed: at(30), resets: reset)], at: at(30)).isEmpty)
        h.settings.limits = true
        #expect(h.step([], limits: [limit(86, observed: at(60), resets: reset)], at: at(60)).isEmpty)
        #expect(h.step([], limits: [limit(95, observed: at(90), resets: reset)], at: at(90)).count == 1)
    }

    @Test func customThresholds() {
        var h = PolicyHarness()
        h.settings.limitThresholds = [50, 50, 120, -3]
        #expect(NotificationPolicy.sanitize(h.settings.limitThresholds) == [50])
        let reset = at(3600)
        _ = h.step([], limits: [limit(10, observed: at(0), resets: reset)], at: at(0))
        #expect(h.step([], limits: [limit(55, observed: at(30), resets: reset)], at: at(30)).count == 1)
    }

    // MARK: CLI failure

    @Test func cliFailureIsOffByDefault() {
        var h = PolicyHarness()
        #expect(h.connection(.failing, at: at(0)).isEmpty)
        #expect(h.connection(.failing, at: at(600)).isEmpty)
    }

    @Test func cliFailureFiresOnceAfterTwoMinutesOfFailing() {
        var h = PolicyHarness()
        h.settings.cliFailure = true
        #expect(h.connection(.healthy, at: at(0)).isEmpty)
        #expect(h.connection(.failing, at: at(10)).isEmpty)
        // Restart attempts in between don't reset the clock.
        #expect(h.connection(.pending, at: at(40)).isEmpty)
        #expect(h.connection(.failing, at: at(70)).isEmpty)
        #expect(h.connection(.failing, at: at(129)).isEmpty)
        let out = h.connection(.pending, at: at(131))
        #expect(out.count == 1)
        #expect(out.first?.kind == .cliFailure)
        #expect(out.first?.target == .diagnostics)
        #expect(out.first?.title == "Signalbox can't read data")
        #expect(h.connection(.failing, at: at(400)).isEmpty, "once per failure")
        // Recovery ends the episode; a new failure needs another 2 minutes.
        #expect(h.connection(.healthy, at: at(500)).isEmpty)
        #expect(h.connection(.failing, at: at(510)).isEmpty)
        #expect(h.connection(.failing, at: at(629)).isEmpty)
        #expect(h.connection(.failing, at: at(631)).count == 1)
    }

    @Test func startingAloneNeverStartsTheFailureClock() {
        var h = PolicyHarness()
        h.settings.cliFailure = true
        #expect(h.connection(.pending, at: at(0)).isEmpty)
        #expect(h.connection(.pending, at: at(600)).isEmpty)
    }

    @Test func cliHealthFromConnectionState() {
        #expect(CLIHealth(.connected) == .healthy)
        #expect(CLIHealth(.restarting(attempt: 1, retryAt: t0, reason: nil)) == .failing)
        #expect(CLIHealth(.failed(reason: "x", attempt: 3, retryAt: nil)) == .failing)
        #expect(CLIHealth(.starting) == .pending)
        #expect(CLIHealth(.idle) == .pending)
        #expect(CLIHealth(.cliMissing(reason: "x")) == .inactive)
        #expect(CLIHealth(.fixture(name: "f")) == .inactive)
    }
}
