import Foundation
import Testing
@testable import SignalboxKit

/// Collects dry-run lines (the sink is called on the main actor, but must be @Sendable).
final class LineSink: @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    var lines: [String] { lock.withLock { _lines } }
    func append(_ s: String) { lock.withLock { _lines.append(s) } }
}

@MainActor
@Suite("Notifier and routing")
struct NotifierTests {
    let t0 = date("2026-10-09T14:30:00Z")

    // MARK: Dry run

    @Test func dryRunWritesOneLinePerNotification() {
        let sink = LineSink()
        let n = DryRunNotifier(sink: { sink.append($0) })
        #expect(n.authorization == .dryRun)
        #expect(n.authorization.canPost)
        n.post(NotificationRequest(id: "1", kind: .waiting, title: "docs sweep needs you", body: "Claude Code is waiting for your input.", target: .session("claude-code/abc")))
        n.post(NotificationRequest(id: "2", kind: .limit, title: "Claude Code: 5-hour window\nat 82%", body: "b", target: .limits))
        n.post(NotificationRequest(id: "3", kind: .cliFailure, title: "Signalbox can't read data", body: "b", target: .diagnostics))
        #expect(sink.lines == [
            "notify kind=waiting target=session:claude-code/abc title=docs sweep needs you",
            "notify kind=limit target=limits title=Claude Code: 5-hour window at 82%",
            "notify kind=cli-failure target=diagnostics title=Signalbox can't read data",
        ])
        #expect(n.posted.map(\.id) == ["1", "2", "3"])
    }

    @Test func dryRunIsSwitchedByTheEnvironment() {
        #expect(!NotifyDryRun.isEnabled([:]))
        #expect(NotifyDryRun.isEnabled(["SIGNALBOX_NOTIFY_DRYRUN": "1"]))
        #expect(NotifyDryRun.isEnabled(["SIGNALBOX_NOTIFY_DRYRUN": "yes"]))
        for off in ["", "0", "false", "No", "OFF"] {
            #expect(!NotifyDryRun.isEnabled(["SIGNALBOX_NOTIFY_DRYRUN": off]))
        }
    }

    @Test func authorizationStatesThatCanPost() {
        #expect(NotificationAuthorization.authorized.canPost)
        #expect(NotificationAuthorization.provisional.canPost)
        #expect(NotificationAuthorization.dryRun.canPost)
        #expect(!NotificationAuthorization.notDetermined.canPost)
        #expect(!NotificationAuthorization.denied.canPost)
        #expect(!NotificationAuthorization.unavailable("x").canPost)
    }

    // MARK: Click routing

    @Test func targetsRoundTripThroughUserInfo() {
        for target in [NotificationTarget.session("claude-code/7f3a:91"), .limits, .diagnostics, .app] {
            let r = NotificationRequest(id: "x", kind: .waiting, title: "t", body: "b", target: target)
            let info = NotificationRouting.userInfo(for: r)
            #expect(NotificationTarget(encoded: info[NotificationRouting.targetKey]!) == target)
            #expect(info[NotificationRouting.kindKey] == "waiting")
        }
        #expect(NotificationTarget(encoded: "session:") == nil)
        #expect(NotificationTarget(encoded: "bogus") == nil)
    }

    @Test func clicksOpenTheirTarget() {
        let session = ["signalbox.target": "session:claude-code/abc", "signalbox.kind": "waiting"]
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.defaultAction, userInfo: session) == .open(.session("claude-code/abc")))
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.openAction, userInfo: session) == .open(.session("claude-code/abc")))
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.muteAction, userInfo: session) == .mute(sessionID: "claude-code/abc"))
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.dismissAction, userInfo: session) == .ignore)
        let limits = ["signalbox.target": "limits"]
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.defaultAction, userInfo: limits) == .open(.limits))
        // "Mute" on a notification without a session just opens it.
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.muteAction, userInfo: limits) == .open(.limits))
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.defaultAction, userInfo: ["signalbox.target": "diagnostics"]) == .open(.diagnostics))
        // A notification from an older build without our keys opens the window as it is.
        #expect(NotificationRouting.route(actionIdentifier: NotificationRouting.defaultAction, userInfo: [:]) == .open(.app))
        #expect(NotificationRouting.route(actionIdentifier: "something.else", userInfo: session) == .ignore)
    }

    @Test func categoriesFollowTheTarget() {
        let s = NotificationRequest(id: "x", kind: .waiting, title: "t", body: "b", target: .session("a/b"))
        let l = NotificationRequest(id: "y", kind: .limit, title: "t", body: "b", target: .limits)
        #expect(NotificationRouting.category(for: s) == NotificationRouting.sessionCategory)
        #expect(NotificationRouting.category(for: l) == NotificationRouting.generalCategory)
    }

    // MARK: Coordinator (store → policy → notifier), end to end with the dry-run notifier

    @Test func fleetsFromTheCLINotifyImmediately() throws {
        let d = TestDefaults()
        let settings = SettingsStore(defaults: d.defaults)
        let fixed = t0
        let store = SignalboxStore(clock: { fixed })
        let sink = LineSink()
        let notifier = DryRunNotifier(sink: { sink.append($0) })
        let viewing = ViewingBox()
        let clockBox = ClockBox(t0)
        let coordinator = NotificationCoordinator(store: store, settings: settings, notifier: notifier,
                                                  viewing: { viewing.state }, clock: { clockBox.now })
        coordinator.start()
        defer { coordinator.stop() }

        func send(_ sessions: [FleetSession], at seconds: TimeInterval) {
            clockBox.now = t0.addingTimeInterval(seconds)
            store.handle(.message(.fleet(at: clockBox.now, FleetSnapshot(generatedAt: clockBox.now, sessions: sessions))))
        }

        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: 1)))
        // App start: one session already waiting, one busy. Nothing fires.
        send([session("a", .waiting), session("b", .busy, since: t0)], at: 0)
        #expect(sink.lines.isEmpty)
        // b starts waiting: fires at once, from the fleet itself.
        send([session("a", .waiting), session("b", .waiting, name: "api-refactor", cwd: "/Users/you/code/api-refactor")], at: 2)
        #expect(sink.lines == ["notify kind=waiting target=session:claude-code/b title=api-refactor needs you"])
        // Muted from the notification's button: nothing more from b.
        settings.setMuted(true, sessionID: "claude-code/b", now: clockBox.now)
        send([session("a", .waiting), session("b", .busy, since: t0)], at: 60)
        send([session("a", .waiting), session("b", .waiting)], at: 120)
        #expect(sink.lines.count == 1)
        // Looking at a in the window: quiet for a, too.
        viewing.state = ViewingState(mainWindowKey: true, visibleSessionID: "claude-code/a")
        send([session("a", .idle), session("b", .idle)], at: 180)
        send([session("a", .waiting), session("b", .idle)], at: 240)
        #expect(sink.lines.count == 1)
        // Window in the background: a's next wait fires.
        viewing.state = .none
        send([session("a", .idle), session("b", .idle)], at: 300)
        send([session("a", .waiting), session("b", .idle)], at: 360)
        #expect(sink.lines.last == "notify kind=waiting target=session:claude-code/a title=docs sweep needs you")
        #expect(sink.lines.count == 2)
    }

    @Test func aMutedSessionStaysQuietWhenItEnds() {
        let d = TestDefaults()
        let settings = SettingsStore(defaults: d.defaults)
        let clockBox = ClockBox(t0)
        let store = SignalboxStore(clock: { clockBox.now })
        let notifier = DryRunNotifier(sink: { _ in })
        let coordinator = NotificationCoordinator(store: store, settings: settings, notifier: notifier, clock: { clockBox.now })
        coordinator.start()
        defer { coordinator.stop() }

        func send(_ sessions: [FleetSession], at seconds: TimeInterval) {
            clockBox.now = t0.addingTimeInterval(seconds)
            store.handle(.message(.fleet(at: clockBox.now, FleetSnapshot(generatedAt: clockBox.now, sessions: sessions))))
        }

        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: 1)))
        send([session("a", .busy, since: t0), session("b", .busy, since: t0)], at: 0)
        settings.setMuted(true, sessionID: "claude-code/a", now: clockBox.now)
        send([session("a", .busy, since: t0), session("b", .busy, since: t0)], at: 300)
        // Both were busy 10 minutes and end in the same fleet: only the unmuted one notifies.
        let end = t0.addingTimeInterval(600)
        send([session("a", .ended, since: end), session("b", .ended, since: end)], at: 600)
        #expect(notifier.posted.map(\.target) == [.session("claude-code/b")])
        // The mute is spent once the end has been judged.
        #expect(!settings.mutes.contains("claude-code/a"))
    }

    @Test func aLoadedSnapshotNeverNotifies() throws {
        let d = TestDefaults()
        let settings = SettingsStore(defaults: d.defaults)
        let store = SignalboxStore()
        let notifier = DryRunNotifier(sink: { _ in })
        let coordinator = NotificationCoordinator(store: store, settings: settings, notifier: notifier)
        coordinator.start()
        defer { coordinator.stop() }
        store.load(snapshot: try TestPaths.loadSnapshot(), name: "snapshot.json")
        store.load(snapshot: try TestPaths.loadSnapshot(), name: "snapshot.json")
        #expect(notifier.posted.isEmpty)
    }

    @Test func cliFailureGoesThroughTheConnectionCheck() {
        let d = TestDefaults()
        let settings = SettingsStore(defaults: d.defaults)
        settings.notifyCLIFailure = true
        let clockBox = ClockBox(t0)
        let store = SignalboxStore(clock: { clockBox.now })
        let notifier = DryRunNotifier(sink: { _ in })
        let coordinator = NotificationCoordinator(store: store, settings: settings, notifier: notifier, clock: { clockBox.now })
        store.handle(.launchFailed("permission denied"))
        coordinator.checkConnection()
        clockBox.now = t0.addingTimeInterval(121)
        coordinator.checkConnection()
        #expect(notifier.posted.map(\.kind) == [.cliFailure])
        #expect(notifier.posted.first?.target == .diagnostics)
    }

    @Test func theTestNotificationUsesTheSameNotifier() {
        let d = TestDefaults()
        let sink = LineSink()
        let coordinator = NotificationCoordinator(store: SignalboxStore(), settings: SettingsStore(defaults: d.defaults),
                                                  notifier: DryRunNotifier(sink: { sink.append($0) }), clock: { date("2026-10-09T14:30:00Z") })
        coordinator.sendTest()
        #expect(sink.lines == ["notify kind=test target=app title=Signalbox notifications are on"])
    }

    // MARK: Store helpers for the menu bar label

    @Test func weeklyPercentAndTodaysSpend() throws {
        let snapshot = try TestPaths.loadSnapshot()
        let store = SignalboxStore()
        store.load(snapshot: snapshot, name: "f")
        let now = snapshot.generatedAt
        #expect(store.highestWeeklyPercent(now: now) == 58, "Codex's weekly window is the highest fresh one; Fable is stale")
        let calendar = Calendar.current
        let todayKey = DayKey.key(now, calendar: calendar)
        let todayRow = snapshot.report.byDay.first { $0.key == todayKey }
        if let todayRow {
            #expect(store.todaySpendUSD(now: now) == todayRow.cost.total)
        }
        // A day the report doesn't cover is unknown, not zero.
        #expect(store.todaySpendUSD(now: now.addingTimeInterval(30 * 86_400)) == nil)
        #expect(SignalboxStore().todaySpendUSD(now: now) == nil)
    }
}

@MainActor
final class ViewingBox {
    var state = ViewingState.none
}

/// A settable clock for @Sendable clock closures in tests.
final class ClockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _now: Date
    init(_ now: Date) { _now = now }
    var now: Date {
        get { lock.withLock { _now } }
        set { lock.withLock { _now = newValue } }
    }
}
