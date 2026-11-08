import AppKit
import SignalboxKit
import SignalboxSwitch
import SwiftUI

/// macOS 14. The main window opens at every launch (`defaultLaunchBehavior` needs macOS 15).
struct SignalboxApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        let controller = appDelegate.controller
        mainWindow(controller)
        aboutWindow(controller)
        menuBarAndSettings(controller)
    }
}

/// macOS 15 and later. In menu-bar-only mode (no Dock icon) the app starts with no window, so a launch at login
/// stays in the menu bar; the window opens from the menu bar item or a notification click.
@available(macOS 15.0, *)
struct SignalboxApp15: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        let controller = appDelegate.controller
        mainWindow(controller)
            .defaultLaunchBehavior(controller.settings.showDockIcon ? .automatic : .suppressed)
        aboutWindow(controller)
            .restorationBehavior(.disabled)
        menuBarAndSettings(controller)
    }
}

@MainActor
private func mainWindow(_ controller: AppController) -> some Scene {
    Window("Signalbox", id: WindowID.main) {
        ContentView()
            .environment(controller.store)
            .environment(controller.navigation)
            .environment(controller)
            .environment(controller.settings)
            .frame(minWidth: 900, minHeight: 560)
    }
    .defaultSize(width: 1280, height: 820)
    .commands { SignalboxCommands(controller: controller) }
}

/// Signalbox ▸ About Signalbox (replaces the standard panel, which can't show the CLI and guide versions).
@MainActor
private func aboutWindow(_ controller: AppController) -> some Scene {
    Window("About Signalbox", id: WindowID.about) {
        AboutView()
            .environment(controller.store)
    }
    .windowResizability(.contentSize)
    .windowStyle(.hiddenTitleBar)
    .defaultPosition(.center)
}

@MainActor @SceneBuilder
private func menuBarAndSettings(_ controller: AppController) -> some Scene {
    MenuBarExtra {
        MenuBarContent()
            .environment(controller.store)
            .environment(controller.navigation)
            .environment(controller)
            .environment(controller.settings)
    } label: {
        MenuBarLabel(store: controller.store, controller: controller, settings: controller.settings)
    }
    .menuBarExtraStyle(.window)

    Settings {
        SettingsView()
            .environment(controller.store)
            .environment(controller.navigation)
            .environment(controller)
            .environment(controller.settings)
    }
}

enum WindowID {
    static let main = "main"
    static let about = "about"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller = AppController.live(options: .current)

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Before the Dock icon would appear, and before a notification click that launched the app is delivered.
        controller.applyDockIcon(activate: false)
        controller.activateNotifications()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await controller.start() }
        ClickProbe.runIfRequested(controller)
    }

    /// Opening the app again (Finder, Spotlight, the Dock icon) shows the main window, also in menu-bar-only mode,
    /// where the window doesn't open at launch and SwiftUI wouldn't bring it back on its own.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller.showMainWindow()
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // The user may have changed the permission or the login item in System Settings.
        controller.refreshSystemState()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.shutdown()
    }
}

/// Owns the store and starts the CLI: resolves the login-shell PATH once, locates the CLI, connects. Also owns
/// settings, notifications and launch at login.
@MainActor
@Observable
final class AppController {
    let store: SignalboxStore
    let navigation = NavigationModel()
    let settings: SettingsStore
    let notifier: any Notifier
    let launchAtLogin: LaunchAtLoginModel
    /// signalbox-switch (docs/SWITCH.md): off by default; the only part of the app that writes outside its own
    /// settings and labels. A fixture run or a snapshot render gets a preview that never writes.
    let switcher: SwitchController
    /// A "Resume with" request waiting for its confirm sheet (History shows it).
    var pendingResume: PendingResume?
    /// The home folder the switch's ~/.claude is in; the snapshot renderer sets a synthetic one.
    var switchHome = SwitchPaths.home()
    /// The snapshot renderer's stand-in for the real claude, so no path of this Mac shows in a render.
    var claudePathOverride: String?
    private(set) var cliLocation: CLILocation?
    private(set) var childPATH: String?
    private(set) var loginPATHResolved = false
    /// The login shell asked for the PATH, e.g. "zsh".
    private(set) var loginShell: String?

    /// Advances once a minute while the CLI runs, so the menu bar label re-checks staleness without new data.
    private(set) var minuteTick = Date()

    /// Opens (or brings back) the main window. Captured from a SwiftUI view, which is the only place
    /// `openWindow` exists; see `showMainWindow()`.
    @ObservationIgnored var openMainWindowAction: (() -> Void)?

    @ObservationIgnored private(set) var notifications: NotificationCoordinator?
    private let options: LaunchOptions
    private let clock: @Sendable () -> Date
    private var transport: CLIProcess?
    /// Restarts run one at a time; see LatestJobQueue.
    @ObservationIgnored private let restarts = LatestJobQueue()
    /// A setting that changes what History lists changed: the next restart clears History once the old CLI is gone.
    @ObservationIgnored private var historyClearPending = false
    private var started = false
    private var tickTask: Task<Void, Never>?
    private var resolvedEnvironment: [String: String]?

    /// `clock` is for the snapshot renderer, which pins time; the app uses the wall clock.
    init(options: LaunchOptions, clock: @escaping @Sendable () -> Date = { Date() }, settings: SettingsStore,
         notifier: any Notifier, loginItems: any LoginItemService, location: AppLocation, switcher: SwitchController? = nil) {
        self.options = options
        self.clock = clock
        self.settings = settings
        self.notifier = notifier
        self.switcher = switcher ?? .preview(enabledUntil: nil, pointer: nil, clock: clock)
        store = SignalboxStore(clock: clock)
        launchAtLogin = LaunchAtLoginModel(service: loginItems, location: location)
        let navigation = navigation
        notifications = NotificationCoordinator(store: store, settings: settings, notifier: notifier,
                                                viewing: { navigation.viewing }, clock: clock)
    }

    /// The app's controller: real notifications (or the dry-run logger), SMAppService, the app's own defaults.
    static func live(options: LaunchOptions) -> AppController {
        let env = ProcessInfo.processInfo.environment
        // SIGNALBOX_DEFAULTS_SUITE keeps a test copy of the app from touching the real app's settings.
        let defaults = env["SIGNALBOX_DEFAULTS_SUITE"].flatMap { $0.isEmpty ? nil : UserDefaults(suiteName: $0) } ?? .standard
        let location = AppLocation.classify(bundlePath: Bundle.main.bundlePath)
        let bundled = location != .notBundled && Bundle.main.bundleIdentifier != nil
        let notifier: any Notifier
        if NotifyDryRun.isEnabled(env) {
            notifier = DryRunNotifier()
        } else if bundled {
            notifier = UserNotificationsNotifier()
        } else {
            notifier = UnavailableNotifier(reason: "Notifications need the Signalbox app bundle; this copy runs outside one (swift run). Build it with apps/macos/scripts/build-app.sh.")
        }
        let loginItems: any LoginItemService = bundled ? MainAppLoginItem() : StaticLoginItem()
        let switcher: SwitchController? = options.fixture == nil
            ? SwitchController(paths: .standard(environment: env), fs: PosixFileSystem(), defaults: defaults,
                               appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
            : nil
        let controller = AppController(options: options, settings: SettingsStore(defaults: defaults), notifier: notifier,
                                       loginItems: loginItems, location: location, switcher: switcher)
        // Account labels live in Signalbox's own accounts.json (the CLI reads it too); a fixture run keeps them in memory.
        if options.fixture == nil { controller.store.useAccountLabels(FileAccountLabels(url: FileAccountLabels.defaultURL(environment: env))) }
        return controller
    }

    /// For the snapshot renderer: in-memory settings, no system services.
    static func preview(options: LaunchOptions = LaunchOptions(arguments: []), clock: @escaping @Sendable () -> Date = { Date() },
                        settings: SettingsStore, notifications: NotificationAuthorization = .authorized,
                        loginItem: LoginItemStatus = .notRegistered, location: AppLocation = .applications,
                        switcher: SwitchController? = nil) -> AppController {
        AppController(options: options, clock: clock, settings: settings, notifier: StaticNotifier(notifications),
                      loginItems: StaticLoginItem(loginItem), location: location, switcher: switcher)
    }

    func activateNotifications() {
        if let n = notifier as? UserNotificationsNotifier {
            n.onRoute = { [weak self] route in self?.handle(route) }
            n.activate()
        }
    }

    func start() async {
        guard !started else { return }
        started = true
        if let fixture = options.fixture {
            do {
                store.load(snapshot: try Snapshot.decode(Data(contentsOf: fixture)), name: fixture.lastPathComponent)
            } catch {
                store.markCLIMissing(reason: "Could not read the fixture \(fixture.path): \(error.localizedDescription)")
            }
            if let url = options.resolvedCommandsFixture {
                do {
                    store.load(commands: try CommandsData.decode(Data(contentsOf: url)))
                } catch {
                    FileHandle.standardError.write(Data("signalbox-app: could not read the command guide \(url.path): \(error.localizedDescription)\n".utf8))
                }
            }
            if let url = options.resolvedHistoryFixture {
                do {
                    store.load(history: try HistorySnapshot.decode(Data(contentsOf: url)))
                } catch {
                    FileHandle.standardError.write(Data("signalbox-app: could not read the session history \(url.path): \(error.localizedDescription)\n".utf8))
                }
            }
            return
        }
        if DebugLog.isEnabled() {
            // Kind and what it opens only: titles carry session names, which the debug log never prints.
            notifications?.onPost = { [weak self] r in
                let target = r.target.sessionID == nil ? r.target.encoded : "session"
                DebugLog.write("notification kind=\(r.kind.rawValue) target=\(target) permission=\(self.map { "\($0.notifier.authorization)" } ?? "?")")
            }
        }
        notifications?.start()
        // An expiry is logged even if the app was closed at the deadline; scripts Terminal never ran are removed.
        switcher.expireIfDue()
        switcher.sweepResumeScripts()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                self?.minuteTick = Date()
                self?.switcher.expireIfDue()
                self?.switcher.refreshPointer()
            }
        }
        let debug = DebugLog.isEnabled()
        if debug {
            var lastState = ""
            store.eventObserver = { [weak store] event in
                DebugLog.write(DebugLog.describe(event))
                // What the window shows now, whenever it changes.
                guard let store else { return }
                let state = DebugLog.describe(store.connection)
                if state != lastState {
                    lastState = state
                    DebugLog.write("state \(state)")
                }
            }
        }
        store.markStarting("Resolving the login-shell PATH")
        let resolved = await ShellEnvironment.resolve()
        childPATH = resolved.environment["PATH"]
        loginPATHResolved = resolved.loginPATHResolved
        loginShell = resolved.shell
        resolvedEnvironment = resolved.environment
        if debug {
            // Counts and kinds only: the PATH and the CLI's location are in Diagnostics.
            let entries = (childPATH ?? "").split(separator: ":").count
            DebugLog.write("login-shell PATH \(resolved.loginPATHResolved ? "resolved" : "NOT resolved (using inherited PATH + fallbacks)") from \(resolved.shell); child PATH has \(entries) entries")
        }
        connectCLI()
    }

    /// Locates the CLI (environment, then the Settings override, then the bundle) and connects to it.
    private func connectCLI() {
        guard let environment = resolvedEnvironment else { return }
        let location = CLILocator.locate(
            environment: ProcessInfo.processInfo.environment,
            override: settings.cliPathOverride,
            bundleResources: Bundle.main.resourceURL,
            searchPATH: childPATH ?? ""
        )
        cliLocation = location
        if DebugLog.isEnabled() {
            switch location {
            case let .found(launch): DebugLog.write("cli found (\(launch.originDescription))")
            case .missing: DebugLog.write("cli missing (see Diagnostics)")
            }
        }
        switch location {
        case let .missing(reason):
            store.markCLIMissing(reason: reason)
        case let .found(launch):
            let t = CLIProcess(configuration: .init(launch: launch, environment: environment, options: settings.watchOptions))
            transport = t
            store.connect(t)
        }
    }

    /// Turns the Claude app's session list in History on or off: the CLI restarts with or without --no-claude-app,
    /// and History reads again rather than showing a list built with the old setting.
    func setIncludeClaudeAppSessions(_ on: Bool) {
        guard on != settings.includeClaudeAppSessions else { return }
        settings.includeClaudeAppSessions = on
        guard !isFixture else { return }
        store.clearHistory()
        historyClearPending = true
        Task { await restartCLI() }
    }

    /// Sets the extra Claude Code config folders the CLI reads (one per account, say): the CLI restarts with a
    /// --claude-config-dir per folder, and History reads again.
    func setClaudeConfigDirs(_ dirs: [String]) {
        var clean: [String] = []
        for d in dirs where d.hasPrefix("/") && !clean.contains(d) { clean.append(d) }
        guard clean != settings.claudeConfigDirs else { return }
        settings.claudeConfigDirs = clean
        guard !isFixture else { return }
        store.clearHistory()
        historyClearPending = true
        Task { await restartCLI() }
    }

    /// Stops the CLI and starts it again with the current settings (after the CLI path or its flags change).
    /// Restarts never overlap: quick toggles queue, and only the latest waiting one runs.
    func restartCLI() async {
        await restarts.run { [weak self] in await self?.performRestart() }
    }

    private func performRestart() async {
        let clearHistory = historyClearPending
        historyClearPending = false
        guard started, !isFixture, resolvedEnvironment != nil else { return }
        await store.disconnect()
        transport = nil
        // The old CLI may have sent a history built with the old setting before it stopped.
        if clearHistory { store.clearHistory() }
        store.markStarting("Restarting the CLI with new settings")
        connectCLI()
    }

    /// Called from applicationWillTerminate: must not wait.
    func shutdown() {
        tickTask?.cancel()
        notifications?.stop()
        if DebugLog.isEnabled() { DebugLog.write("terminating; sending SIGTERM to the CLI") }
        transport?.terminateImmediately()
    }

    var isFixture: Bool { options.fixture != nil }

    // MARK: Account switching

    /// ~/.claude (CLAUDE_CONFIG_DIR unset) and every other Claude Code folder Signalbox reads.
    var switchFolders: [SwitchFolder] {
        let env = ProcessInfo.processInfo.environment
        let fs = PosixFileSystem()
        return SwitchFolder.list(home: switchHome, extra: [env["CLAUDE_CONFIG_DIR"]].compactMap { $0 } + settings.claudeConfigDirs,
                                 realpath: { fs.realpath($0) })
    }

    /// "Team · ~/.claude-team", or "~/.claude-team · account unknown" when the folder's login can't be read.
    func switchLabel(_ folder: SwitchFolder) -> String {
        if let a = folder.account(in: store.accounts) { return "\(store.accountName(a.id)) · \(Fmt.shortPath(folder.path))" }
        return "\(Fmt.shortPath(folder.path)) · account unknown"
    }

    /// The account to name in the audit log: Step 1's hashed id and your label, nil when unknown.
    func auditAccount(_ folder: SwitchFolder) -> AuditAccount? {
        folder.account(in: store.accounts).map { AuditAccount(id: $0.id, label: store.accountLabels[$0.id] ?? $0.label) }
    }

    /// The folder the pointer names (one not in the list still shows, by its path).
    var terminalFolder: SwitchFolder? {
        guard let p = switcher.pointer else { return nil }
        if let f = SwitchFolder.folder(for: p, in: switchFolders) { return f }
        switch p {
        case .defaultFolder: return switchFolders.first
        case let .folder(path): return SwitchFolder(path: path, isDefault: false)
        }
    }

    /// The popover's "Terminal: …" text: the account's name, else the folder; nil without a pointer.
    var terminalAccountText: String? {
        if switcher.pointerUnreadable { return "unreadable pointer file" }
        guard let f = terminalFolder else { return nil }
        if let a = f.account(in: store.accounts) { return store.accountName(a.id) }
        return Fmt.shortPath(f.path)
    }

    /// The real claude for resume scripts (the shim skipped).
    var realClaudePath: String? {
        if let claudePathOverride { return claudePathOverride }
        return switcher.claudePath(searchPATH: childPATH ?? ProcessInfo.processInfo.environment["PATH"] ?? "", environment: ProcessInfo.processInfo.environment)
    }

    /// The Claude Code sessions running in `folders` now, for the setup's check.
    func runningSessions(in folders: [SwitchFolder]) -> [String] {
        let paths = Set(folders.map(\.path))
        return (store.fleet?.sessions ?? []).filter { s in
            s.agent == .claudeCode && s.status != .ended && s.configDir.map(SwitchFolder.normalize).map(paths.contains) == true
        }.map { "session \(String($0.sessionId.prefix(8)))" }
    }

    /// Folders other than the default and `second` whose projects/ already shares a tree with either (the CLI's
    /// retention rows say which): after the link they all share one tree, so they count in the checks too.
    func setupJoining(second: SwitchFolder) -> [SwitchFolder] {
        let rows = (store.fleet?.retention ?? []).filter { $0.agent == .claudeCode }
        let def = switchFolders[0]
        var out: [SwitchFolder] = []
        for r in rows {
            let p = SwitchFolder.normalize(r.configDir)
            let shares = (r.sharesTranscriptsWith ?? []).map(SwitchFolder.normalize)
            guard p != def.path, p != second.path, shares.contains(def.path) || shares.contains(second.path),
                  !out.contains(where: { $0.path == p }) else { continue }
            out.append(SwitchFolder(path: p, isDefault: false))
        }
        return out
    }

    /// Every folder that will share the default tree, the default first, with the days Claude Code keeps there.
    func setupRetention(second: SwitchFolder) -> [RetentionInput] {
        let rows = (store.fleet?.retention ?? []).filter { $0.agent == .claudeCode }
        let folders = [switchFolders[0].path, second.path] + setupJoining(second: second).map(\.path)
        return folders.map { path in
            let row = rows.first { SwitchFolder.normalize($0.configDir) == path }
            let days: Int? = row.flatMap { r in
                switch RetentionStatus.of(r, warnBelowDays: 0) {
                case .invalid, .unknown: nil
                default: r.effectiveDays
                }
            }
            return RetentionInput(folder: path, days: days)
        }
    }

    // MARK: Settings side effects

    /// Shows or hides the Dock icon. The menu bar item keeps the window reachable either way.
    func applyDockIcon(activate: Bool = true) {
        let policy: NSApplication.ActivationPolicy = settings.showDockIcon ? .regular : .accessory
        guard NSApp.activationPolicy() != policy else { return }
        NSApp.setActivationPolicy(policy)
        // Switching hides the app's windows behind others; keep whatever was open in front.
        if activate { NSApp.activate() }
    }

    func refreshSystemState() {
        launchAtLogin.refresh()
        Task { await notifier.refreshAuthorization() }
    }

    func resetSettings() {
        switcher.disable()
        let cliPath = settings.cliPathOverride
        let options = settings.watchOptions
        settings.resetAll()
        applyDockIcon()
        if options != settings.watchOptions, !isFixture {
            store.clearHistory()
            historyClearPending = true
        }
        if cliPath != settings.cliPathOverride || options != settings.watchOptions { Task { await restartCLI() } }
    }

    /// The snapshot renderer shows a CLI location without running one.
    func previewCLI(_ location: CLILocation) {
        cliLocation = location
    }

    // MARK: Windows and notification clicks

    func showMainWindow() {
        NSApp.activate()
        if let open = openMainWindowAction {
            open()
        } else if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix(WindowID.main) == true }) {
            window.makeKeyAndOrderFront(nil)
        }
    }

    func showDiagnostics() {
        navigation.showDiagnostics = true
        showMainWindow()
    }

    func handle(_ route: NotificationRoute) {
        switch route {
        case let .open(target):
            switch target {
            case let .session(id): navigation.show(session: id)
            case .limits: navigation.section = .limits
            case .diagnostics: navigation.showDiagnostics = true
            case .app: break
            }
            showMainWindow()
        case let .mute(id):
            settings.setMuted(true, sessionID: id, now: clock())
        case .ignore:
            break
        }
    }
}
