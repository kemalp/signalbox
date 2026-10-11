import AppKit
import SignalboxKit
import SwiftUI

/// `Signalbox --render-snapshots <outDir> --fixture <snapshot.json>`: renders every screen into PNGs
/// from an offscreen window, so layouts can be checked without screen-recording permission.
/// Uses NSHostingView + cacheDisplay rather than ImageRenderer, which drops AppKit-backed List/Table.
/// `--redact` renders every view marked `.privacySensitive()` as placeholder bars, for shots that are shared.
@MainActor
enum SnapshotRenderer {
    static let windowSize = CGSize(width: 1280, height: 820)
    /// The popover's width, and the height its natural height is compared with (capped at twice this).
    static let popoverSize = CGSize(width: 360, height: 520)
    /// Whether a session's folder exists, for the History resume line. Synthetic fixtures name folders such as
    /// /Users/you/code/api: a path whose first two levels don't exist here counts as present. Others (real data)
    /// are checked on disk, so a folder that's gone renders as it would in the app.
    static let directoryExists: @Sendable (String) -> Bool = { path in
        let top = "/" + path.split(separator: "/").prefix(2).joined(separator: "/")
        return HistoryBrowser.directoryExists(path) || !HistoryBrowser.directoryExists(top)
    }

    /// Set by `run(redact:)`: every scene is rendered under `.redacted(reason: .privacy)`.
    private(set) static var redact = false

    static func run(outDir: URL, fixture: URL, today todayFixture: URL? = nil, month monthFixture: URL? = nil, commands commandsFixture: URL? = nil,
                    history historyFixture: URL? = nil, redact: Bool = false) -> Int32 {
        self.redact = redact
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()

        func read(_ url: URL) -> Snapshot? {
            do {
                return try Snapshot.decode(Data(contentsOf: url))
            } catch {
                FileHandle.standardError.write(Data("Could not read \(url.path): \(error)\n".utf8))
                return nil
            }
        }
        guard let snapshot = read(fixture) else { return 1 }
        // The command guide (synthetic: Fixtures/commands.json, or the one a `signalbox snapshot --json` carries);
        // the Commands shots need one.
        var commands: CommandsData? = snapshot.commands
        if let commandsFixture {
            do {
                commands = try CommandsData.decode(Data(contentsOf: commandsFixture))
            } catch {
                FileHandle.standardError.write(Data("Could not read \(commandsFixture.path): \(error)\n".utf8))
                return 1
            }
        } else if commands == nil {
            FileHandle.standardError.write(Data("note: no --fixture-commands (or commands.json beside the fixture): the Commands shots show the no-guide state\n".utf8))
        }
        // The session history (synthetic: Fixtures/history.json, or the one a `signalbox snapshot --json` may carry);
        // the History shots need one.
        var history: HistorySnapshot? = snapshot.history
        if let historyFixture {
            do {
                history = try HistorySnapshot.decode(Data(contentsOf: historyFixture))
            } catch {
                FileHandle.standardError.write(Data("Could not read \(historyFixture.path): \(error)\n".utf8))
                return 1
            }
        } else if history == nil {
            FileHandle.standardError.write(Data("note: no --fixture-history (or history.json beside the fixture): the History shots show the no-history state\n".utf8))
        }
        // Real Today / 30-day snapshots when given, else scaled copies of the main fixture's days.
        var todaySnapshot = SyntheticReports.today(snapshot)
        var monthSnapshot = SyntheticReports.month(snapshot)
        if let todayFixture {
            guard let s = read(todayFixture) else { return 1 }
            todaySnapshot = s
        }
        if let monthFixture {
            guard let s = read(monthFixture) else { return 1 }
            monthSnapshot = s
        }
        // Derived windows are fake numbers: say so in the file name too, not only inside the image.
        let todayTag = todayFixture == nil ? "-synthetic" : ""
        let monthTag = monthFixture == nil ? "-synthetic" : ""
        if todayFixture == nil || monthFixture == nil {
            FileHandle.standardError.write(Data("note: Today/30-day renders without --fixture-today/--fixture-30d are scaled copies (files end in -synthetic)\n".utf8))
        }
        do {
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("Could not create \(outDir.path): \(error)\n".utf8))
            return 1
        }

        // Every controller gets its own in-memory settings: nothing is written to any defaults domain (the app's
        // or a throwaway one), and no notification or login-item service is touched.
        func preview(clock: @escaping @Sendable () -> Date = { Date() }, notifications: NotificationAuthorization = .authorized,
                     loginItem: LoginItemStatus = .notRegistered, location: AppLocation = .applications,
                     configure: (SettingsStore) -> Void = { _ in }) -> AppController {
            let settings = SettingsStore(defaults: InMemorySettings())
            configure(settings)
            return AppController.preview(clock: clock, settings: settings, notifications: notifications, loginItem: loginItem, location: location)
        }

        let controller = preview()
        let store = controller.store
        let nav = controller.navigation
        store.load(snapshot: snapshot, name: fixture.lastPathComponent)
        if let commands { store.load(commands: commands) }
        if let history { store.load(history: history) }
        // "Updated 12s ago" reads naturally; all relative times are computed against this.
        store.pinnedNow = snapshot.generatedAt.addingTimeInterval(12)
        let compactID = CommandEntry(agent: .claudeCode, kind: .slash, command: CatalogCommand(name: "/compact", summary: "")).id

        let selected = store.sessions.sorted(by: SignalboxStore.sortSessions).first { $0.status == .busy } ?? store.sessions.first
        var written: [URL] = []

        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            for section in SidebarSection.allCases {
                nav.section = section
                nav.selectedSessionID = section == .sessions ? selected?.id : nil
                nav.selectedCommandID = section == .commands ? compactID : nil
                nav.showInspector = section == .sessions
                nav.showHistoryInspector = false
                nav.showEnded = true
                let view = ContentView()
                    .environment(store)
                    .environment(nav)
                    .environment(controller).environment(controller.settings)
                    .environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
                    .environment(\.directoryExists, directoryExists)
                let url = outDir.appendingPathComponent("\(section.rawValue)-\(suffix).png")
                if render(view, size: windowSize, appearance: appearance, titled: true, to: url) { written.append(url) }
            }
            // The real popover is as tall as its content, so render it at its natural height.
            let content = MenuBarContent()
                .environment(store)
                .environment(nav)
                .environment(controller).environment(controller.settings)
            let size = CGSize(width: popoverSize.width, height: min(popoverSize.height * 2, max(200, naturalHeight(content, width: popoverSize.width))))
            let popover = content
                .frame(width: size.width, height: size.height, alignment: .top)
                .background(.regularMaterial)
            let url = outDir.appendingPathComponent("menubar-\(suffix).png")
            if render(popover, size: size, appearance: appearance, titled: false, to: url) { written.append(url) }
        }

        // Usage variants. "Tall" shots show the whole page (chart, table and notes) without scrolling.
        let tall = CGSize(width: windowSize.width, height: 1240)
        func usage(_ name: String, _ snap: Snapshot = snapshot, dark: Bool = false, breakdown: ChartBreakdown = .model,
                   grouping: UsageGrouping = .agent, hover: String? = nil, size: CGSize = windowSize, live: Bool = false,
                   configure: (SettingsStore) -> Void = { _ in }) {
            let c = preview(configure: configure)
            c.store.load(snapshot: snap, name: fixture.lastPathComponent)
            if live { goLive(c.store, snap) }
            c.store.pinnedNow = store.pinnedNow
            c.navigation.section = .usage
            c.navigation.showInspector = false
            c.navigation.chartBreakdown = breakdown
            c.navigation.usageGrouping = grouping
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, dark ? .dark : .light)
                .environment(\.snapshotChartSelection, hover)
            let url = outDir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            if render(view, size: size, appearance: dark ? .darkAqua : .aqua, titled: true, to: url) { written.append(url) }
        }
        let keys = snapshot.report.byDay.map(\.key)
        // The busiest day (callout to the right of the bar) and the last day (callout flips to the left).
        let peak = snapshot.report.byDay.max { $0.cost.total < $1.cost.total }?.key
        usage("usage-by-model-tall", grouping: .model, size: tall)
        usage("usage-by-project-tall", grouping: .project, size: tall)
        usage("usage-chart-kind", breakdown: .kind, grouping: .kind, hover: peak, size: tall)
        usage("usage-chart-tokentype", dark: true, breakdown: .tokenType, hover: keys.last, size: tall)
        usage("usage-hover", hover: peak)
        usage("usage-hover", dark: true, hover: keys.last)
        usage("usage-today\(todayTag)", todaySnapshot, hover: todaySnapshot.report.byDay.last?.key)
        usage("usage-30d\(monthTag)", monthSnapshot)
        usage("usage-30d\(monthTag)", monthSnapshot, dark: true, breakdown: .tokenType)
        // The popover for a 30-day window (sparkline over the whole span) and for Today (no sparkline).
        for (name, snap) in [("menubar-30d\(monthTag)", monthSnapshot), ("menubar-today\(todayTag)", todaySnapshot)] {
            let c = preview()
            c.store.load(snapshot: snap, name: fixture.lastPathComponent)
            c.store.pinnedNow = store.pinnedNow
            let content = MenuBarContent().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
            let size = CGSize(width: popoverSize.width, height: min(popoverSize.height * 2, max(200, naturalHeight(content, width: popoverSize.width))))
            let url = outDir.appendingPathComponent("\(name)-light.png")
            if render(content.frame(width: size.width, height: size.height, alignment: .top).background(.regularMaterial),
                      size: size, appearance: .aqua, titled: false, to: url) { written.append(url) }
        }

        // Milestone 3: GBP at a user rate, the plan value tile, the notification banner and the Settings panes.
        let rateDate = snapshot.generatedAt.addingTimeInterval(-9 * 86_400)
        let gbp: (SettingsStore) -> Void = { s in
            s.currency = .gbp
            s.setRate(0.79, for: .gbp)
            s.setRateAsOf(rateDate, for: .gbp)
        }
        usage("usage-gbp", configure: gbp)
        usage("usage-gbp-30d\(monthTag)", monthSnapshot, dark: true, hover: monthSnapshot.report.byDay.last?.key, configure: gbp)
        usage("usage-plan-30d\(monthTag)", monthSnapshot) { s in
            s.planPrice = 200
            s.planCurrency = .usd
        }
        usage("usage-plan-30d\(monthTag)", monthSnapshot, dark: true) { s in
            gbp(s)
            s.planPrice = 180
            s.planCurrency = .gbp
        }
        // Live (not a fixture), so the tile shows its "Switch to 30 days" button as the running app does.
        usage("usage-plan-7d", live: true) { s in
            s.planPrice = 200
            s.planCurrency = .usd
        }
        usage("usage-plan-7d", dark: true, live: true) { s in
            gbp(s)
            s.planPrice = 180
            s.planCurrency = .gbp
        }
        // Sessions in GBP: the subtitle says the row costs are converted at the user's rate.
        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            let c = preview(configure: gbp)
            c.store.load(snapshot: snapshot, name: fixture.lastPathComponent)
            c.store.pinnedNow = store.pinnedNow
            c.navigation.section = .sessions
            c.navigation.selectedSessionID = selected?.id
            c.navigation.showInspector = true
            c.navigation.showEnded = true
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
            let url = outDir.appendingPathComponent("sessions-gbp-\(suffix).png")
            if render(view, size: windowSize, appearance: appearance, titled: true, to: url) { written.append(url) }
        }
        do {
            let c = preview(configure: { s in
                gbp(s)
                s.menuBarLabel = .todaySpend
            })
            c.store.load(snapshot: snapshot, name: fixture.lastPathComponent)
            c.store.pinnedNow = store.pinnedNow
            let content = MenuBarContent().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
            let size = CGSize(width: popoverSize.width, height: min(popoverSize.height * 2, max(200, naturalHeight(content, width: popoverSize.width))))
            let url = outDir.appendingPathComponent("menubar-gbp-light.png")
            if render(content.frame(width: size.width, height: size.height, alignment: .top).background(.regularMaterial),
                      size: size, appearance: .aqua, titled: false, to: url) { written.append(url) }
        }
        // The menu bar item in each label mode (Settings ▸ General), today's spend in GBP, a waiting session (filled
        // gauge) and the CLI down (no figure), on a plain menu-bar-like strip. A waiting session fills the gauge
        // whatever the mode, so the mode rows use the fixture with nobody waiting.
        var calm = snapshot
        var waitingSnap = snapshot
        for i in calm.fleet.sessions.indices where calm.fleet.sessions[i].status == .waiting {
            calm.fleet.sessions[i].status = .idle
            calm.fleet.sessions[i].waitingFor = nil
        }
        if !waitingSnap.fleet.sessions.contains(where: { $0.status == .waiting }),
           let i = waitingSnap.fleet.sessions.firstIndex(where: { $0.status == .busy }) {
            waitingSnap.fleet.sessions[i].status = .waiting
        }
        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            var rows: [MenuBarLabelStrip.Row] = []
            func labelRow(_ title: String, _ snap: Snapshot? = calm, configure: @escaping (SettingsStore) -> Void = { _ in },
                          prepare: (AppController) -> Void = { _ in }) {
                let c = preview(configure: configure)
                if let snap { c.store.load(snapshot: snap, name: fixture.lastPathComponent) }
                c.store.pinnedNow = store.pinnedNow
                prepare(c)
                rows.append(MenuBarLabelStrip.Row(title: title, controller: c))
            }
            for mode in MenuBarLabelMode.allCases {
                labelRow(mode.title) { s in s.menuBarLabel = mode }
            }
            labelRow("Today's spend, GBP at your rate") { s in
                gbp(s)
                s.menuBarLabel = .todaySpend
            }
            labelRow("Highest 5-hour %, a session waiting", waitingSnap)
            labelRow("CLI not running", nil, prepare: { c in c.store.markCLIMissing(reason: "not bundled") })
            let strip = MenuBarLabelStrip(rows: rows).environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
            let url = outDir.appendingPathComponent("menubar-labels-\(suffix).png")
            if render(strip, size: MenuBarLabelStrip.size(rows: rows.count), appearance: appearance, titled: false, to: url) { written.append(url) }
        }

        // The Sessions banner asking to turn notifications on (permission not asked yet), with one session muted.
        let mutedID = store.sessions.first { $0.status == .idle }?.id
        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            let c = preview(notifications: .notDetermined) { s in
                if let mutedID { s.setMuted(true, sessionID: mutedID, now: snapshot.generatedAt) }
            }
            c.store.load(snapshot: snapshot, name: fixture.lastPathComponent)
            c.store.pinnedNow = store.pinnedNow
            c.navigation.section = .sessions
            c.navigation.selectedSessionID = mutedID ?? selected?.id
            c.navigation.showInspector = true
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
            let url = outDir.appendingPathComponent("sessions-banner-\(suffix).png")
            if render(view, size: windowSize, appearance: appearance, titled: true, to: url) { written.append(url) }
        }
        // The whole session inspector without scrolling (on its own, in a borderless window, as History's is), so its
        // lower sections (directory, session id, compactions) can be checked too.
        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            let size = CGSize(width: 320, height: 1420)
            let view = SessionInspector(session: store.session(id: selected?.id))
                .environment(store).environment(nav).environment(controller).environment(controller.settings)
                .environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
                .frame(width: size.width, height: size.height, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
            let url = outDir.appendingPathComponent("sessions-inspector-\(suffix).png")
            if render(view, size: size, appearance: appearance, titled: false, to: url) { written.append(url) }
        }
        // Settings: General shows a login item waiting for approval from a build folder; Notifications not asked
        // yet (light) and allowed (dark); Display in GBP with a plan; Advanced with the bundled CLI.
        let buildPath = "/Users/you/code/signalbox/apps/macos/build/Signalbox.app"
        for tab in SettingsTab.allCases {
            for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
                let c = preview(notifications: tab == .notifications && suffix == "light" ? .notDetermined : .authorized,
                                loginItem: tab == .general ? .requiresApproval : .notRegistered,
                                location: tab == .general ? .buildFolder(buildPath) : .applications) { s in
                    if tab == .display {
                        gbp(s)
                        s.planPrice = 180
                        s.planCurrency = .gbp
                    }
                    if tab == .notifications, let mutedID { s.setMuted(true, sessionID: mutedID, now: snapshot.generatedAt) }
                }
                c.store.load(snapshot: snapshot, name: fixture.lastPathComponent)
                c.store.pinnedNow = store.pinnedNow
                c.previewCLI(.found(CLILaunch(executable: URL(fileURLWithPath: "/Applications/Signalbox.app/Contents/Resources/signalbox"), origin: .bundled)))
                let view = SettingsView(tab: tab).environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                    .environment(\.pinnedColorScheme, suffix == "dark" ? .dark : .light)
                let url = outDir.appendingPathComponent("settings-\(tab.rawValue)-\(suffix).png")
                // The pane plus the tab bar, which offscreen draws as a segmented control under the title bar.
                let size = CGSize(width: SettingsView.width, height: tab.paneHeight + 52)
                if render(view, size: size, appearance: appearance, titled: true, to: url) { written.append(url) }
            }
        }

        // Error and empty states, light only: what a first run without a CLI looks like.
        let missing = preview()
        missing.store.markCLIMissing(reason: "The signalbox CLI isn't bundled with this build. Build the app with apps/macos/scripts/build-app.sh, or set SIGNALBOX_CLI to a signalbox binary (or bun:/path/to/apps/cli/src/main.ts).")
        missing.navigation.section = .sessions
        let missingView = ContentView().environment(missing.store).environment(missing.navigation).environment(missing).environment(missing.settings).environment(\.pinnedColorScheme, .light)
        let missingURL = outDir.appendingPathComponent("state-cli-missing-light.png")
        if render(missingView, size: windowSize, appearance: .aqua, titled: true, to: missingURL) { written.append(missingURL) }

        // The CLI failing: three quick exits before it says anything ("Couldn't Start"), and a CLI that
        // stopped after sending data (banner over the last data, and the popover's problem line).
        let failClock = snapshot.generatedAt.addingTimeInterval(12)
        let stderrLine = "signalbox: ENOENT: no such file or directory, scandir '/nonexistent/pricing'"
        let failing = preview(clock: { failClock })
        failing.store.pinnedNow = failClock
        for attempt in 1...SignalboxStore.failedStartThreshold {
            failing.store.handle(.started(pid: Int32(4000 + attempt), command: "signalbox watch --ndjson --days 7"))
            failing.store.handle(.stderr(stderrLine))
            failing.store.handle(.exited(status: 1, signaled: false))
            failing.store.handle(.restarting(attempt: attempt, delay: CLIProcess.backoff(attempt: attempt, initial: .seconds(1), max: .seconds(30))))
        }
        failing.navigation.section = .sessions
        let failingView = ContentView().environment(failing.store).environment(failing.navigation).environment(failing).environment(failing.settings).environment(\.pinnedColorScheme, .light)
        let failingURL = outDir.appendingPathComponent("state-cli-failed-light.png")
        if render(failingView, size: windowSize, appearance: .aqua, titled: true, to: failingURL) { written.append(failingURL) }
        // The Diagnostics sheet for that CLI: the command, PATH and stderr lines.
        failing.previewCLI(.found(CLILaunch(executable: URL(fileURLWithPath: "/Applications/Signalbox.app/Contents/Resources/signalbox"), origin: .bundled)))
        let diagnostics = DiagnosticsView().environment(failing.store).environment(failing).environment(\.pinnedColorScheme, .light)
            .frame(width: 780, height: 560)
            .background(Color(nsColor: .windowBackgroundColor))
        let diagnosticsURL = outDir.appendingPathComponent("diagnostics-light.png")
        if render(diagnostics, size: CGSize(width: 780, height: 560), appearance: .aqua, titled: false, to: diagnosticsURL) { written.append(diagnosticsURL) }

        let stopped = preview(clock: { failClock })
        stopped.store.load(snapshot: snapshot, name: fixture.lastPathComponent)
        stopped.store.pinnedNow = failClock
        stopped.store.handle(.started(pid: 4100, command: "signalbox watch --ndjson --days 7"))
        stopped.store.handle(.message(.hello(version: "0.0.0", protocolVersion: streamProtocolVersion, pid: 4100)))
        stopped.store.handle(.stderr(stderrLine))
        stopped.store.handle(.exited(status: 1, signaled: false))
        stopped.store.handle(.restarting(attempt: 1, delay: .seconds(1)))
        stopped.navigation.section = .sessions
        stopped.navigation.showEnded = true
        let stoppedView = ContentView().environment(stopped.store).environment(stopped.navigation).environment(stopped).environment(stopped.settings).environment(\.pinnedColorScheme, .light)
        let stoppedURL = outDir.appendingPathComponent("state-cli-stopped-light.png")
        if render(stoppedView, size: windowSize, appearance: .aqua, titled: true, to: stoppedURL) { written.append(stoppedURL) }
        let stoppedPopover = MenuBarContent().environment(stopped.store).environment(stopped.navigation).environment(stopped).environment(stopped.settings)
        let stoppedSize = CGSize(width: popoverSize.width, height: min(popoverSize.height * 2, max(200, naturalHeight(stoppedPopover, width: popoverSize.width))))
        let stoppedPopoverURL = outDir.appendingPathComponent("menubar-cli-stopped-light.png")
        if render(stoppedPopover.frame(width: stoppedSize.width, height: stoppedSize.height, alignment: .top).background(.regularMaterial),
                  size: stoppedSize, appearance: .aqua, titled: false, to: stoppedPopoverURL) { written.append(stoppedPopoverURL) }

        let empty = preview()
        empty.store.load(
            snapshot: Snapshot(generatedAt: snapshot.generatedAt, days: 1, fleet: FleetSnapshot(generatedAt: snapshot.generatedAt, health: snapshot.health), report: Report(generatedAt: snapshot.generatedAt, priceTables: snapshot.report.priceTables), health: snapshot.health.map { $0.name == "claude-code:spool" ? AdapterHealth(name: $0.name, stability: $0.stability, ok: false, detail: "No spool files: the signalbox-tap mod has not run") : $0 }),
            name: "empty.json"
        )
        empty.store.pinnedNow = snapshot.generatedAt
        for section in [SidebarSection.sessions, .limits, .usage] {
            empty.navigation.section = section
            let v = ContentView().environment(empty.store).environment(empty.navigation).environment(empty).environment(empty.settings).environment(\.pinnedColorScheme, .light)
            let url = outDir.appendingPathComponent("state-empty-\(section.rawValue)-light.png")
            if render(v, size: windowSize, appearance: .aqua, titled: true, to: url) { written.append(url) }
        }

        renderMilestone4(outDir: outDir, snapshot: snapshot, commands: commands, fixtureName: fixture.lastPathComponent,
                         pinnedNow: store.pinnedNow ?? snapshot.generatedAt, preview: { configure in preview(configure: configure) },
                         written: &written)

        renderHistory(outDir: outDir, snapshot: snapshot, history: history, fixtureName: fixture.lastPathComponent,
                      pinnedNow: store.pinnedNow ?? snapshot.generatedAt, preview: { configure in preview(configure: configure) },
                      written: &written)

        for url in written { print(url.path) }
        return written.isEmpty ? 1 : 0
    }

    /// Session history (every session is the main loop's `history-*`): one agent, a search, a project over 30 days,
    /// empty sessions shown, a selected entry with the inspector (live, a path that needs quoting, an untitled one
    /// with no figures, one whose folder is gone), a narrow window, and the empty, no-results, loading, CLI-too-old
    /// and no-history states. The Claude app's list: archived sessions shown, a session only in the app's list
    /// selected (and its whole inspector), an archived one with a transcript, and the list turned off.
    private static func renderHistory(outDir: URL, snapshot: Snapshot, history: HistorySnapshot?, fixtureName: String, pinnedNow: Date,
                                      preview: ((SettingsStore) -> Void) -> AppController, written: inout [URL]) {
        func shot(_ name: String, dark: Bool = false, history h: HistorySnapshot? = history, size: CGSize = windowSize,
                  folders: @escaping @Sendable (String) -> Bool = directoryExists,
                  configure: @escaping (SettingsStore) -> Void = { _ in }, prepare: (AppController) -> Void) {
            let c = preview(configure)
            c.store.load(snapshot: snapshot, name: fixtureName)
            if let h { c.store.load(history: h) }
            c.store.pinnedNow = pinnedNow
            c.navigation.section = .history
            c.navigation.showHistoryInspector = false
            prepare(c)
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, dark ? .dark : .light)
                .environment(\.directoryExists, folders)
            let url = outDir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            if render(view, size: size, appearance: dark ? .darkAqua : .aqua, titled: true, to: url) { written.append(url) }
        }
        let entries = history?.entries ?? []
        let liveID = entries.first { $0.live }?.id
        let quotedID = entries.first { $0.project?.contains("'") == true }?.id
        let untitledID = entries.first { $0.title == nil && $0.costUsd == nil }?.id
        let closedID = entries.first { !$0.live && $0.title != nil && $0.resume != nil }?.id
        let sharedName = HistoryBrowser.projects(entries).first { $0.name.contains("/") }?.path
        let appOnlyID = entries.first { $0.isAppOnly && !$0.isArchived && !$0.models.isEmpty }?.id
        let archivedMergedID = entries.first { $0.isArchived && $0.hasTranscript }?.id
        for dark in [false, true] {
            // The Claude app's list: archived sessions listed with their badge, and a session only in the app's list.
            shot("history-show-archived", dark: dark) { c in c.navigation.historyFilter = HistoryFilter(showArchived: true) }
            shot("history-selected-app-only", dark: dark) { c in
                c.navigation.selectedHistoryID = appOnlyID
                c.navigation.showHistoryInspector = true
            }
        }
        for dark in [false, true] {
            shot("history-codex", dark: dark) { c in c.navigation.historyFilter = HistoryFilter(agent: .codex) }
            shot("history-search", dark: dark) { c in c.navigation.historyFilter = HistoryFilter(query: "api") }
            shot("history-selected", dark: dark) { c in
                c.navigation.selectedHistoryID = liveID
                c.navigation.showHistoryInspector = true
            }
            shot("history-empty", dark: dark, history: HistorySnapshot(generatedAt: pinnedNow, entries: [])) { _ in }
        }
        // The whole inspector without scrolling (a titled window can't be taller than the screen, so on its own, in a
        // borderless one): a live entry with a ledger figure, compactions and subagents.
        for dark in [false, true] {
            let c = preview { _ in }
            c.store.load(snapshot: snapshot, name: fixtureName)
            if let history { c.store.load(history: history) }
            c.store.pinnedNow = pinnedNow
            let size = CGSize(width: 340, height: 1560)
            let view = HistoryInspector(entry: c.store.historyEntry(id: liveID))
                .environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, dark ? .dark : .light)
                .environment(\.directoryExists, directoryExists)
                .frame(width: size.width, height: size.height, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
            let url = outDir.appendingPathComponent("history-inspector-\(dark ? "dark" : "light").png")
            if render(view, size: size, appearance: dark ? .darkAqua : .aqua, titled: false, to: url) { written.append(url) }
        }
        // The whole inspector of a session only in the Claude app's list: why there are no figures or resume command.
        do {
            let c = preview { _ in }
            c.store.load(snapshot: snapshot, name: fixtureName)
            if let history { c.store.load(history: history) }
            c.store.pinnedNow = pinnedNow
            let size = CGSize(width: 340, height: 980)
            let view = HistoryInspector(entry: c.store.historyEntry(id: appOnlyID))
                .environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, .light)
                .environment(\.directoryExists, directoryExists)
                .frame(width: size.width, height: size.height, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
            let url = outDir.appendingPathComponent("history-inspector-app-only-light.png")
            if render(view, size: size, appearance: .aqua, titled: false, to: url) { written.append(url) }
        }
        // An archived session with a transcript (the app's title, the badge, the app's id), archived ones shown.
        shot("history-selected-archived") { c in
            c.navigation.historyFilter = HistoryFilter(showArchived: true)
            c.navigation.selectedHistoryID = archivedMergedID
            c.navigation.showHistoryInspector = true
        }
        // A search whose only matches are archived: the list offers to show them.
        if let archivedTitle = entries.first(where: { $0.isArchived && $0.isAppOnly })?.displayTitle {
            shot("history-search-archived") { c in c.navigation.historyFilter = HistoryFilter(query: archivedTitle) }
        }
        // The Claude app's list turned off in Settings ▸ Advanced: transcripts only, and the note says so.
        if let history {
            var off = history
            off.entries = history.entries.filter(\.hasTranscript).map { e in
                var e = e
                e.appSessionId = nil
                e.archived = nil
                if e.titleSource == .app { e.titleSource = .custom }
                return e
            }
            off.total = off.entries.count
            off.sources = HistorySources(transcripts: off.entries.count, claudeApp: ClaudeAppSource(enabled: false, records: 0, merged: 0, appOnly: 0, archived: 0))
            shot("history-claude-app-off", history: off) { _ in }
        }
        shot("history-selected-quoted") { c in
            c.navigation.selectedHistoryID = quotedID
            c.navigation.showHistoryInspector = true
        }
        shot("history-selected-untitled", dark: true) { c in
            c.navigation.selectedHistoryID = untitledID
            c.navigation.showHistoryInspector = true
        }
        // A session whose project folder has since been deleted: the resume line leaves out the cd and says why.
        shot("history-selected-folder-gone", folders: { _ in false }) { c in
            c.navigation.selectedHistoryID = closedID
            c.navigation.showHistoryInspector = true
        }
        shot("history-project-30d") { c in c.navigation.historyFilter = HistoryFilter(project: sharedName, range: .month) }
        // Empty sessions (no title, no responses) listed too, after "Show N empty sessions".
        shot("history-show-empty") { c in c.navigation.historyFilter = HistoryFilter(showEmpty: true) }
        shot("history-search-empty") { c in c.navigation.historyFilter = HistoryFilter(agent: .codex, query: "frobnicate") }
        // The smallest window the app allows (900×560 plus a little), the inspector open: titles truncate, the filters wrap.
        shot("history-narrow", size: CGSize(width: 960, height: 640)) { c in
            c.navigation.selectedHistoryID = liveID
            c.navigation.showHistoryInspector = true
        }
        shot("history-gbp", dark: true, configure: { s in
            s.currency = .gbp
            s.setRate(0.79, for: .gbp)
            s.setRateAsOf(pinnedNow.addingTimeInterval(-9 * 86_400), for: .gbp)
        }) { c in c.navigation.selectedHistoryID = liveID; c.navigation.showHistoryInspector = true }
        // Without a history: connected and waiting for the first scan; connected past the grace period (a CLI from
        // before history); a snapshot without one.
        for (name, connectedFor) in [("history-loading", 10.0), ("history-cli-too-old", SignalboxStore.historyGrace + 60)] {
            let connectedAt = pinnedNow.addingTimeInterval(-connectedFor)
            let c = AppController.preview(clock: { connectedAt }, settings: SettingsStore(defaults: InMemorySettings()))
            c.store.load(snapshot: snapshot, name: fixtureName)
            goLive(c.store, snapshot)
            c.store.pinnedNow = pinnedNow
            c.navigation.section = .history
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, .light)
            let url = outDir.appendingPathComponent("\(name)-light.png")
            if render(view, size: windowSize, appearance: .aqua, titled: true, to: url) { written.append(url) }
        }
        shot("history-no-history", history: nil) { _ in }
    }

    /// Milestone 4: the Commands screen (all agents, one agent, a selection, your commands, search, the
    /// CLI-too-old state), session suggestions and the About window.
    private static func renderMilestone4(outDir: URL, snapshot: Snapshot, commands: CommandsData?, fixtureName: String, pinnedNow: Date,
                                         preview: ((SettingsStore) -> Void) -> AppController, written: inout [URL]) {
        func id(_ agent: AgentID, _ name: String, shell: Bool = false) -> String {
            CommandEntry(agent: agent, kind: shell ? .shell : .slash, command: CatalogCommand(name: name, summary: "")).id
        }
        func shot(_ name: String, dark: Bool = false, snap: Snapshot? = nil, guide: CommandsData? = nil, size: CGSize = windowSize, prepare: (AppController) -> Void) {
            let c = preview { _ in }
            c.store.load(snapshot: snap ?? snapshot, name: fixtureName)
            if let guide = guide ?? commands { c.store.load(commands: guide) }
            c.store.pinnedNow = pinnedNow
            c.navigation.showEnded = true
            prepare(c)
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, dark ? .dark : .light)
            let url = outDir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            if render(view, size: size, appearance: dark ? .darkAqua : .aqua, titled: true, to: url) { written.append(url) }
        }
        // A project command when there is one (the synthetic fixture has one), else any of Claude Code's own.
        let customProject = (commands?.custom.first { $0.agent == .claudeCode && $0.scope == .project }
            ?? commands?.custom.first { $0.agent == .claudeCode })?.id
        for dark in [false, true] {
            // All agents, nothing picked: your commands first, then categories.
            shot("commands-all", dark: dark) { c in
                c.navigation.section = .commands
                c.navigation.selectedCommandID = nil
            }
            // One agent whose installed version differs from the checked one, with a command that has side effects.
            shot("commands-codex", dark: dark) { c in
                c.navigation.section = .commands
                c.navigation.commandFilter = CommandFilter(agent: .codex)
                c.navigation.selectedCommandID = id(.codex, "/model")
            }
            // Your commands, a project one selected.
            shot("commands-custom", dark: dark) { c in
                c.navigation.section = .commands
                c.navigation.commandFilter = CommandFilter(agent: .claudeCode)
                c.navigation.selectedCommandID = customProject
            }
            // Claude Code's context commands: /compact selected (planned, side effects).
            shot("commands-selected", dark: dark) { c in
                c.navigation.section = .commands
                c.navigation.commandFilter = CommandFilter(agent: .claudeCode, category: .context)
                c.navigation.selectedCommandID = id(.claudeCode, "/compact")
            }
        }
        // An agent that isn't installed; a search across agents; a search with no results; what Signalbox shows.
        shot("commands-gemini") { c in
            c.navigation.section = .commands
            c.navigation.commandFilter = CommandFilter(agent: .geminiCLI)
            c.navigation.selectedCommandID = id(.geminiCLI, "/compress")
        }
        shot("commands-search") { c in
            c.navigation.section = .commands
            c.navigation.commandFilter = CommandFilter(query: "compact")
            c.navigation.selectedCommandID = id(.geminiCLI, "/compress")
        }
        shot("commands-search-empty") { c in
            c.navigation.section = .commands
            c.navigation.commandFilter = CommandFilter(query: "frobnicate")
        }
        shot("commands-search-empty-filtered", dark: true) { c in
            c.navigation.section = .commands
            c.navigation.commandFilter = CommandFilter(agent: .codex, run: .planned, query: "model")
        }
        shot("commands-shown") { c in
            c.navigation.section = .commands
            c.navigation.commandFilter = CommandFilter(run: .shown)
            c.navigation.selectedCommandID = id(.claudeCode, "claude agents --json", shell: true)
        }
        // Long plugin-skill names that share a lead, as template plugins have: rows must keep the distinguishing end
        // (middle truncation, the plugin lead dimmed). Invented names, added to whichever guide is rendered.
        if var long = commands {
            let plugin = "acme-templates"
            let suffixes = ["report-template-quarterly-board-review", "report-template-quarterly-board-summary",
                            "report-template-weekly-status-digest", "report-template-weekly-status-update"]
            for s in suffixes {
                long.custom.append(CustomCommand(agent: .codex, name: "$\(plugin):\(s)", description: "Fill in the \(s.replacingOccurrences(of: "-", with: " "))",
                                                 kind: .pluginSkill, scope: .plugin, source: plugin))
            }
            let first = long.custom.first { $0.source == plugin }?.id
            for dark in [false, true] {
                shot("commands-long-names", dark: dark, guide: long) { c in
                    c.navigation.section = .commands
                    c.navigation.commandFilter = CommandFilter(agent: .codex)
                    c.navigation.selectedCommandID = first
                }
            }
            shot("commands-long-names-all", guide: long) { c in
                c.navigation.section = .commands
            }
        }
        // These two show the app without a guide, so they drop the one a real snapshot carries.
        var bare = snapshot
        bare.commands = nil
        // Connected to a CLI from before the command guide, for longer than the grace period.
        do {
            let connectedAt = pinnedNow.addingTimeInterval(-90)
            let c = AppController.preview(clock: { connectedAt }, settings: SettingsStore(defaults: InMemorySettings()))
            c.store.load(snapshot: bare, name: fixtureName)
            goLive(c.store, snapshot)
            c.store.pinnedNow = pinnedNow
            c.navigation.section = .commands
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, .light)
            let url = outDir.appendingPathComponent("commands-cli-too-old-light.png")
            if render(view, size: windowSize, appearance: .aqua, titled: true, to: url) { written.append(url) }
        }
        // A snapshot without a guide (the app run with --fixture alone).
        do {
            let c = preview { _ in }
            c.store.load(snapshot: bare, name: fixtureName)
            c.store.pinnedNow = pinnedNow
            c.navigation.section = .commands
            let view = ContentView().environment(c.store).environment(c.navigation).environment(c).environment(c.settings)
                .environment(\.pinnedColorScheme, .light)
            let url = outDir.appendingPathComponent("commands-no-guide-light.png")
            if render(view, size: windowSize, appearance: .aqua, titled: true, to: url) { written.append(url) }
        }

        // Session suggestions: high context while idle (compact), waiting at a permission prompt (answer it), and a
        // Codex session idle for two hours at 85% (Codex's /compact and /clear).
        let sorted = snapshot.fleet.sessions
        let highContext = sorted.first { ($0.context?.effectivePercent ?? 0) >= SessionSuggestions.highContextPercent && $0.status != .ended }
        let waiting = sorted.first { $0.status == .waiting }
        var codexSnap = snapshot
        if let i = codexSnap.fleet.sessions.firstIndex(where: { $0.agent == .codex }) {
            codexSnap.fleet.sessions[i].status = .idle
            codexSnap.fleet.sessions[i].statusSince = pinnedNow.addingTimeInterval(-2 * 3600 - 300)
            if var ctx = codexSnap.fleet.sessions[i].context {
                ctx.tokens = 231_000
                ctx.percent = nil
                codexSnap.fleet.sessions[i].context = ctx
            }
        }
        let codexID = codexSnap.fleet.sessions.first { $0.agent == .codex }?.id
        for dark in [false, true] {
            shot("sessions-suggest", dark: dark) { c in
                c.navigation.section = .sessions
                c.navigation.selectedSessionID = highContext?.id
                c.navigation.showInspector = true
            }
        }
        shot("sessions-suggest-waiting") { c in
            c.navigation.section = .sessions
            c.navigation.selectedSessionID = waiting?.id
            c.navigation.showInspector = true
        }
        shot("sessions-suggest-codex", dark: true, snap: codexSnap) { c in
            c.navigation.section = .sessions
            c.navigation.selectedSessionID = codexID
            c.navigation.showInspector = true
        }

        // About, at its natural height: connected to a CLI (version and protocol from hello) with the guide loaded.
        let iconURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/AppIcon.icns")
        let icon = NSImage(contentsOf: iconURL)
        for dark in [false, true] {
            let c = preview { _ in }
            c.store.load(snapshot: snapshot, name: fixtureName)
            goLive(c.store, snapshot)
            if let commands { c.store.load(commands: commands) }
            let about = AboutView(icon: icon).environment(c.store).environment(\.pinnedColorScheme, dark ? .dark : .light)
            let size = CGSize(width: AboutView.width, height: naturalHeight(about, width: AboutView.width) + 28)
            let url = outDir.appendingPathComponent("about-\(dark ? "dark" : "light").png")
            if render(about.frame(maxHeight: .infinity, alignment: .top), size: size, appearance: dark ? .darkAqua : .aqua, titled: true, to: url) { written.append(url) }
        }
    }

    /// The height SwiftUI wants for `view` at a fixed width.
    /// Makes a store that loaded `snap` look connected to a running CLI (range picker and commands enabled),
    /// without starting anything: the transport is inert and the CLI's lines are replayed from the snapshot.
    static func goLive(_ store: SignalboxStore, _ snap: Snapshot) {
        store.connect(InertTransport())
        // A bundled CLI reports the same release version as the app (both come from VERSION).
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        store.handle(.message(.hello(version: version, protocolVersion: streamProtocolVersion, pid: nil)))
        store.handle(.message(.report(at: snap.report.generatedAt, days: snap.days, snap.report)))
    }

    static func naturalHeight(_ view: some View, width: CGFloat) -> CGFloat {
        let host = NSHostingView(rootView: view.frame(width: width).redacted(reason: redact ? .privacy : []))
        host.layoutSubtreeIfNeeded()
        return ceil(host.fittingSize.height)
    }

    /// Hosts `view` in an offscreen window, lets SwiftUI and AppKit settle, and writes the window's
    /// contents (title bar and toolbar included) as a PNG.
    ///
    /// macOS 26 draws Liquid Glass and scroll-edge effects through backdrop and portal layers that
    /// `cacheDisplay` can't render offscreen: glass comes out as a debug placeholder and lists under
    /// the title bar come out blank. So before capturing, the scroll-edge "pockets" are hidden, and
    /// each sidebar/inspector glass panel is composited afterwards as an opaque panel with its content
    /// drawn on top. Everything else is the real AppKit/SwiftUI rendering.
    /// SIGNALBOX_RENDER_ONLY=settings,menubar renders only the shots whose names start with one of these.
    static let onlyPrefixes: [String]? = ProcessInfo.processInfo.environment["SIGNALBOX_RENDER_ONLY"]
        .map { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        .flatMap { $0.isEmpty ? nil : $0 }

    @discardableResult
    static func render<V: View>(_ view: V, size: CGSize, appearance: NSAppearance.Name, titled: Bool, to url: URL) -> Bool {
        if let only = onlyPrefixes, !only.contains(where: { url.lastPathComponent.hasPrefix($0) }) { return false }
        let style: NSWindow.StyleMask = titled ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.borderless]
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: style, backing: .buffered, defer: false)
        let nsAppearance = NSAppearance(named: appearance)
        window.appearance = nsAppearance
        window.title = "Signalbox"
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        window.backgroundColor = .windowBackgroundColor

        // At the root, so the main window, inspectors, popover and settings are all redacted the same way.
        let host = NSHostingView(rootView: view.redacted(reason: redact ? .privacy : []))
        host.sceneBridgingOptions = [.toolbars, .title]
        // The window size is ours to set; don't let the SwiftUI content resize it.
        host.sizingOptions = []
        window.contentView = host
        let frame = NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height)
        // Far off any screen: AppKit lays it out and draws it, but nobody ever sees it.
        window.setFrame(frame, display: false)
        window.orderFront(nil)
        settle(window, seconds: 1.0)

        let target = window.contentView?.superview ?? host
        // Glass picks its content's appearance from what's behind it, which offscreen is nothing.
        // Glass sets vibrant appearances on its content; vibrancy can't be captured, so use the plain one.
        func pinGlassAppearance() {
            for g in views(in: target, named: { $0.contains("GlassEffectView") }) {
                g.appearance = nsAppearance
                for v in views(in: g, named: { _ in true }) where v.appearance != nil && v.appearance != nsAppearance {
                    v.appearance = nsAppearance
                }
            }
        }
        pinGlassAppearance()
        window.setFrame(frame, display: true)
        settle(window, seconds: 0.5)
        pinGlassAppearance()
        settle(window, seconds: 0.2)

        if ProcessInfo.processInfo.environment["SIGNALBOX_DUMP_VIEWS"] != nil { dump(target, depth: 0) }

        for pocket in views(in: target, named: { $0 == "NSScrollPocket" }) { pocket.isHidden = true }
        let platters = views(in: target, named: { $0 == "NSGlassEffectView" })
        let toolbarItems = views(in: target, named: { $0 == "NSToolbarItemViewer" })
        let panels = views(in: target, named: { $0.contains("GlassEffectView") && $0 != "NSGlassEffectView" })

        guard let capture = target.bitmapImageRepForCachingDisplay(in: target.bounds) else { return false }
        target.cacheDisplay(in: target.bounds, to: capture)

        // Lift each panel's content out of its glass container (same place on screen) so it draws
        // without the glass's vibrancy context, which offscreen capture can't reproduce.
        var lifted: [(panel: NSRect, views: [NSView])] = []
        for g in panels {
            let pf = g.convert(g.bounds, to: target)
            var moved: [NSView] = []
            for holder in g.subviews where className(holder) == "ContentHolderView" {
                for child in holder.subviews where !child.isHidden {
                    let cf = child.convert(child.bounds, to: target)
                    child.removeFromSuperview()
                    child.translatesAutoresizingMaskIntoConstraints = true
                    target.addSubview(child)
                    child.frame = cf
                    child.appearance = nsAppearance
                    moved.append(child)
                }
            }
            lifted.append((pf, moved))
        }
        if !lifted.isEmpty {
            settle(window, seconds: 0.5)
            for pocket in views(in: target, named: { $0 == "NSScrollPocket" }) { pocket.isHidden = true }
        }

        let scale = CGFloat(capture.pixelsWide) / max(1, target.bounds.width)
        guard let cg = capture.cgImage,
              let ctx = CGContext(data: nil, width: capture.pixelsWide, height: capture.pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return false }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: capture.pixelsWide, height: capture.pixelsHigh))
        ctx.scaleBy(x: scale, y: scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        (nsAppearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            let dark = nsAppearance?.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            for (panel, views) in lifted {
                let clip = drawPanel(panel, in: target.bounds, dark: dark)
                NSGraphicsContext.saveGraphicsState()
                clip.addClip()
                for v in views { draw(v, into: target) }
                NSGraphicsContext.restoreGraphicsState()
                if !isAttached(panel, in: target.bounds) {
                    NSColor.separatorColor.setStroke()
                    clip.lineWidth = 0.5
                    clip.stroke()
                }
            }
            // Toolbar platters: a capsule, then the toolbar items that sit on it, redrawn on top.
            for p in platters {
                let f = p.convert(p.bounds, to: target)
                let capsule = NSBezierPath(roundedRect: f.insetBy(dx: 0.5, dy: 0.5), xRadius: f.height / 2, yRadius: f.height / 2)
                (dark ? NSColor(white: 0.23, alpha: 1) : NSColor(white: 1, alpha: 1)).setFill()
                capsule.fill()
                NSColor.labelColor.withAlphaComponent(dark ? 0.12 : 0.08).setStroke()
                capsule.lineWidth = 0.5
                capsule.stroke()
                for item in toolbarItems where !item.isHidden && item.convert(item.bounds, to: target).intersects(f) {
                    draw(item, into: target)
                }
            }
        }
        NSGraphicsContext.restoreGraphicsState()

        window.orderOut(nil)
        window.close()
        guard let image = ctx.makeImage(),
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        else { return false }
        do {
            try png.write(to: url)
            return true
        } catch {
            FileHandle.standardError.write(Data("Could not write \(url.path): \(error)\n".utf8))
            return false
        }
    }

    /// Draws one subtree at its place in `target` (into the current graphics context).
    private static func draw(_ view: NSView, into target: NSView) {
        let f = view.convert(view.bounds, to: target)
        guard f.width > 1, f.height > 1, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        rep.draw(in: f, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    private static func isAttached(_ f: NSRect, in bounds: NSRect) -> Bool {
        f.minY <= 0.5 && f.maxY >= bounds.maxY - 0.5
    }

    /// An opaque stand-in for a glass panel: floating panels (the sidebar) get rounded corners and a
    /// soft shadow, edge-attached ones (the inspector) a square edge with a divider. Returns the shape.
    @discardableResult
    private static func drawPanel(_ f: NSRect, in bounds: NSRect, dark: Bool) -> NSBezierPath {
        NSColor.windowBackgroundColor.setFill()
        f.insetBy(dx: -8, dy: -8).intersection(bounds).fill()
        let fill = dark ? NSColor(white: 0.165, alpha: 1) : NSColor(white: 0.975, alpha: 1)
        if isAttached(f, in: bounds) {
            fill.setFill()
            f.fill()
            NSColor.separatorColor.setFill()
            NSRect(x: f.minX, y: f.minY, width: 1, height: f.height).fill()
            return NSBezierPath(rect: f)
        }
        let path = NSBezierPath(roundedRect: f, xRadius: 16, yRadius: 16)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(dark ? 0.5 : 0.12)
        shadow.shadowBlurRadius = 8
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        shadow.set()
        fill.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        return path
    }

    private static func className(_ v: NSView) -> String { String(describing: type(of: v)) }

    private static func views(in root: NSView, named match: (String) -> Bool) -> [NSView] {
        var out: [NSView] = []
        func walk(_ v: NSView) {
            if match(className(v)) { out.append(v) }
            for s in v.subviews { walk(s) }
        }
        walk(root)
        return out
    }

    private static func dump(_ v: NSView, depth: Int) {
        guard depth < 40 else { return }
        print(String(repeating: "  ", count: depth) + "\(className(v)) \(v.frame.integral) hidden=\(v.isHidden)")
        for s in v.subviews { dump(s, depth: depth + 1) }
    }

    private static func settle(_ window: NSWindow, seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }
    }
}

/// The menu bar item as it would sit in the menu bar, once per label mode, with what each row shows. Drawn at
/// twice the menu bar's 13 pt so the gauge symbols can be told apart (offscreen windows render at 1×).
private struct MenuBarLabelStrip: View {
    struct Row {
        let title: String
        let controller: AppController
    }

    static let scale: CGFloat = 2
    static let width: CGFloat = 470 * scale
    static let rowHeight: CGFloat = 30 * scale

    static func size(rows: Int) -> CGSize {
        CGSize(width: width, height: CGFloat(rows) * rowHeight + 20 * scale)
    }

    let rows: [Row]

    var body: some View {
        let k = Self.scale
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows.indices, id: \.self) { i in
                let c = rows[i].controller
                HStack(spacing: 12 * k) {
                    Text(rows[i].title)
                        .font(.system(size: 12 * k))
                        .foregroundStyle(.secondary)
                        .frame(width: 270 * k, alignment: .leading)
                    MenuBarLabel(store: c.store, controller: c, settings: c.settings)
                        .font(.system(size: 13 * k))
                        .padding(.horizontal, 8 * k)
                        .padding(.vertical, 3 * k)
                        .background(RoundedRectangle(cornerRadius: 5 * k).fill(.quaternary))
                    Spacer(minLength: 0)
                }
                .frame(height: Self.rowHeight)
            }
        }
        .padding(.horizontal, 16 * k)
        .padding(.vertical, 10 * k)
        .frame(width: Self.width, alignment: .leading)
        .background(.bar)
    }
}

/// A transport that never starts a process and never sends anything (snapshot rendering only).
private final class InertTransport: SignalboxTransport, @unchecked Sendable {
    let events: AsyncStream<TransportEvent>
    private let continuation: AsyncStream<TransportEvent>.Continuation

    init() {
        (events, continuation) = AsyncStream.makeStream()
    }

    func start(days: Int) async {}
    func send(_ command: StreamCommand) async {}
    func stop() async { continuation.finish() }
}
