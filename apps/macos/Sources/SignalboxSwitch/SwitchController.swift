import Foundation
import Observation
import SignalboxKit

public enum SwitchError: LocalizedError, Equatable {
    case off
    case preview
    case unfit(String)
    case changed(String)
    case file(String)
    case terminal(String)

    public var errorDescription: String? {
        switch self {
        case .off: "Account switching is off. Turn it on in Settings ▸ Advanced."
        case .preview: "This is a preview; nothing is written."
        case let .unfit(why): why
        case let .changed(why): why
        case let .file(why): why
        case let .terminal(why): "Couldn't open Terminal: \(why)"
        }
    }
}

/// signalbox-switch's state and its four allow-listed verbs: set the pointer, write the shim (when turned on), resume
/// in Terminal, run a setup step. Each verb checks that switching is on, acts, then appends its audit line. Nothing
/// else in the app writes outside Signalbox's own settings and labels.
@MainActor
@Observable
public final class SwitchController {
    public static let enabledUntilKey = "switch.enabledUntil"
    public nonisolated static let terminalName = "Terminal"
    /// Resume scripts that Terminal never ran are removed after this long.
    public static let staleScriptAge: TimeInterval = 3600

    public let paths: SwitchPaths
    /// When switching turns itself off; nil while off.
    public private(set) var enabledUntil: Date?
    /// The Terminal account; nil when there is no pointer file.
    public private(set) var pointer: PointerValue?
    /// A pointer file is there but doesn't read as `default` or a path.
    public private(set) var pointerUnreadable = false
    /// Bumped after every audit line, so the Log redraws.
    public private(set) var logRevision = 0
    /// An action that happened but whose audit line couldn't be written (shown on the Accounts screen).
    public private(set) var logProblem: String?
    /// Sessions opened in Terminal by this run of the app, for the two-minute guard (the log is checked too).
    @ObservationIgnored private var recentResumes: [String: Date] = [:]
    /// A second "Resume with" of the same session within this time is refused: Terminal may not have started it yet,
    /// so the fleet can't show it as running.
    public static let resumeGuard: TimeInterval = 120
    /// Snapshot renders: shows state, never writes.
    public let isPreview: Bool

    @ObservationIgnored private let fs: any SwitchFileSystem
    @ObservationIgnored private let defaults: any SettingsBackend
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private let appVersion: String
    @ObservationIgnored private let openInTerminal: @Sendable (String) throws -> Void
    @ObservationIgnored private var log: AuditLog { AuditLog(paths: paths, fs: fs) }

    public init(paths: SwitchPaths, fs: any SwitchFileSystem, defaults: any SettingsBackend, appVersion: String,
                clock: @escaping () -> Date = { Date() }, openInTerminal: @escaping @Sendable (String) throws -> Void = SwitchController.openWithTerminal,
                isPreview: Bool = false) {
        self.paths = paths
        self.fs = fs
        self.defaults = defaults
        self.appVersion = appVersion
        self.clock = clock
        self.openInTerminal = openInTerminal
        self.isPreview = isPreview
        enabledUntil = defaults.object(forKey: Self.enabledUntilKey) as? Date
        refreshPointer()
    }

    /// For the snapshot renderer: a given state, no files read or written.
    public static func preview(enabledUntil: Date?, pointer: PointerValue?, clock: @escaping () -> Date) -> SwitchController {
        let c = SwitchController(paths: SwitchPaths(root: "/nonexistent/signalbox-switch-preview"), fs: PosixFileSystem(),
                                 defaults: InMemorySettings(enabledUntil.map { [enabledUntilKey: $0] } ?? [:]), appVersion: "preview",
                                 clock: clock, openInTerminal: { _ in throw SwitchError.preview }, isPreview: true)
        c.pointer = pointer
        return c
    }

    // MARK: On, off, expiry

    public func isOn(at now: Date? = nil) -> Bool {
        guard let until = enabledUntil else { return false }
        return until > (now ?? clock())
    }

    /// Turns switching on for `duration`; writes the shim when it is missing or out of date.
    public func enable(_ duration: SwitchDuration) throws {
        guard !isPreview else { throw SwitchError.preview }
        let until = clock().addingTimeInterval(duration.seconds)
        do {
            _ = try fs.ensureDirectory(paths.root, mode: 0o700)
            try writeShimIfNeeded()
        } catch {
            try? append(.init(ts: clock(), action: .switchEnabled, result: .failed, appVersion: appVersion, reason: describe(error)))
            throw SwitchError.file(describe(error))
        }
        enabledUntil = until
        defaults.set(until, forKey: Self.enabledUntilKey)
        try append(.init(ts: clock(), action: .switchEnabled, result: .ok, appVersion: appVersion, until: until))
    }

    public func disable() {
        guard !isPreview, let until = enabledUntil else { return }
        clearWindow()
        try? append(.init(ts: clock(), action: .switchDisabled, result: .ok, appVersion: appVersion, until: until))
    }

    /// Logs the expiry once and turns switching off, when its time has come. Called every minute and at launch, so an
    /// expiry is logged even if the app was closed at the deadline.
    public func expireIfDue() {
        guard !isPreview, let until = enabledUntil, until <= clock() else { return }
        clearWindow()
        try? append(.init(ts: clock(), action: .switchExpired, result: .ok, appVersion: appVersion, until: until))
    }

    private func clearWindow() {
        enabledUntil = nil
        defaults.removeObject(forKey: Self.enabledUntilKey)
    }

    // MARK: The shim

    public var shimText: String { ShimScript.text(pointerPath: paths.pointer) }

    public var shimIsCurrent: Bool {
        fs.read(paths.shim, maxBytes: 64 * 1024) == Data(shimText.utf8)
    }

    private func writeShimIfNeeded() throws {
        guard !shimIsCurrent else { return }
        _ = try fs.ensureDirectory(paths.binDir, mode: 0o700)
        try fs.writeAtomically(Data(shimText.utf8), to: paths.shim, mode: 0o700)
        try append(.init(ts: clock(), action: .shimWritten, result: .ok, appVersion: appVersion, paths: [paths.shim]))
    }

    // MARK: The pointer

    public func refreshPointer() {
        guard !isPreview else { return }
        switch fs.kind(paths.pointer) {
        case nil:
            pointer = nil
            pointerUnreadable = false
        default:
            let value = fs.read(paths.pointer, maxBytes: PointerValue.maxBytes).flatMap(PointerValue.parse)
            pointer = value
            pointerUnreadable = value == nil
        }
    }

    /// Points Terminal's `claude` at `folder` (through the shim).
    public func setPointer(_ folder: SwitchFolder, account: AuditAccount?) throws {
        try requireOn()
        let before = pointer
        let entry = AuditEntry(ts: clock(), action: .pointerSet, result: .ok, appVersion: appVersion,
                               from: before?.line ?? "none", to: folder.pointerValue.line, account: account,
                               configDir: folder.path, paths: [paths.pointer])
        do {
            _ = try fs.ensureDirectory(paths.root, mode: 0o700)
            try fs.writeAtomically(folder.pointerValue.fileContents, to: paths.pointer, mode: 0o600)
        } catch {
            var failed = entry
            failed.result = AuditResult.failed.rawValue
            failed.reason = describe(error)
            try? append(failed)
            throw SwitchError.file(describe(error))
        }
        refreshPointer()
        try append(entry)
    }

    // MARK: Resume

    /// Writes a one-shot script and opens it in Terminal, which runs `claude --resume`. Signalbox never runs claude.
    /// Checked again here, whatever the menu showed: the session isn't running (`live`, from the fleet now), the folder
    /// can see its transcript, and it wasn't opened in the last two minutes. Refusals are logged.
    public func resume(_ request: ResumeRequest, transcriptPath: String, live: Bool, account: AuditAccount?) async throws {
        try requireOn()
        var entry = AuditEntry(ts: clock(), action: .resumeOpened, result: .ok, appVersion: appVersion, account: account,
                               configDir: request.folder.path, sessionId: request.sessionId, fork: request.fork,
                               terminal: Self.terminalName)
        func refuse(_ why: String, _ error: SwitchError) throws -> Never {
            entry.result = AuditResult.refused.rawValue
            entry.reason = why
            try? append(entry)
            throw error
        }
        guard let script = request.script else {
            try refuse("the session id or a path isn't fit for a script", .unfit("The session id or a path can't go into a script safely."))
        }
        if live { try refuse("session is live", .unfit("The session is running. Quit it first.")) }
        if !canSee(transcriptPath, from: request.folder) {
            try refuse("folder can't see the transcript", .unfit("\(request.folder.path) can't see this session's transcript. Set up shared sessions first."))
        }
        if openedRecently(request.sessionId) {
            try refuse("opened less than two minutes ago", .unfit("This session was opened in Terminal less than two minutes ago. If it isn't running there, try again in a moment."))
        }
        let file = "\(paths.resumeDir)/\(UUID().uuidString).command"
        entry.paths = [file]
        do {
            _ = try fs.ensureDirectory(paths.resumeDir, mode: 0o700)
            try fs.writeAtomically(Data(script.utf8), to: file, mode: 0o700)
        } catch {
            entry.result = AuditResult.failed.rawValue
            entry.reason = describe(error)
            try? append(entry)
            throw SwitchError.file(describe(error))
        }
        do {
            let open = openInTerminal
            try await Task.detached { try open(file) }.value
        } catch {
            try? fs.removeFile(file)
            entry.result = AuditResult.failed.rawValue
            entry.reason = describe(error)
            try? append(entry)
            throw SwitchError.terminal(describe(error))
        }
        recentResumes[request.sessionId] = clock()
        // Terminal is open now: a log failure must not invite a second try, so it is reported, not thrown.
        do {
            try append(entry)
        } catch {
            logProblem = "Resumed session \(request.sessionId.prefix(8)), but \(error.localizedDescription)"
        }
    }

    private func openedRecently(_ sessionId: String) -> Bool {
        let cutoff = clock().addingTimeInterval(-Self.resumeGuard)
        if let t = recentResumes[sessionId], t > cutoff { return true }
        return auditEntries(limit: 500).contains {
            $0.action == AuditAction.resumeOpened.rawValue && $0.result == AuditResult.ok.rawValue && $0.sessionId == sessionId && $0.ts > cutoff
        }
    }

    /// Removes resume scripts Terminal never ran (older than an hour), and logs what it removed.
    public func sweepResumeScripts() {
        guard !isPreview, case .directory? = fs.kind(paths.resumeDir), let names = try? fs.list(paths.resumeDir) else { return }
        let cutoff = clock().addingTimeInterval(-Self.staleScriptAge)
        var removed: [String] = []
        for name in names where name.hasSuffix(".command") {
            let path = "\(paths.resumeDir)/\(name)"
            guard case let .file(_, modified)? = fs.kind(path), modified < cutoff else { continue }
            if (try? fs.removeFile(path)) != nil { removed.append(path) }
        }
        if !removed.isEmpty {
            try? append(.init(ts: clock(), action: .resumeSwept, result: .ok, appVersion: appVersion, paths: removed))
        }
    }

    /// Whether `folder` can resume the session in `transcriptPath`: its projects/ is the tree holding the file.
    public func canSee(_ transcriptPath: String, from folder: SwitchFolder) -> Bool {
        guard let tree = fs.realpath(folder.projects), let file = fs.realpath(transcriptPath) else { return false }
        return file.hasPrefix(tree + "/")
    }

    public func claudePath(searchPATH: String, environment: [String: String]) -> String? {
        ClaudeLocator.locate(environment: environment, searchPATH: searchPATH, home: SwitchPaths.home(environment),
                             shimDir: paths.binDir, fs: fs)
    }

    // MARK: Setup

    /// Everything the setup plan needs, read now: names only, never file contents. `joining`: other folders whose
    /// projects/ already links to the second folder's tree, so they will share too (their processes count as running).
    public func setupInputs(second: SwitchFolder, defaultFolder: SwitchFolder, joining: [SwitchFolder] = [], retention: [RetentionInput],
                            threshold: Int, runningSessions: [String]) -> SetupInputs {
        let shared = fs.realpath(defaultFolder.projects)
        let state: ProjectsState = switch fs.kind(second.projects) {
        case nil: .missing
        case .directory?: .directory
        case let .symlink(target)?: fs.realpath(second.projects).map { $0 == shared } == true ? .linkToShared : .linkElsewhere(target)
        default: .notADirectory
        }
        // The default folder under another spelling, or a projects/ inside the shared tree (or holding it).
        let sameFolder = (fs.realpath(second.path) ?? second.path) == (fs.realpath(defaultFolder.path) ?? defaultFolder.path)
        var overlaps = sameFolder
        if let shared, state == .directory, let real = fs.realpath(second.projects) {
            overlaps = overlaps || real == shared || real.hasPrefix(shared + "/") || shared.hasPrefix(real + "/")
        }
        var inputs = SetupInputs(switchOn: isOn(), sharedTree: shared, second: second, secondState: state, overlapsShared: overlaps,
                                 running: runningSessions + ([second] + joining).flatMap(runningProcesses), retention: retention,
                                 threshold: threshold, sameVolume: nil, exclusiveRename: nil,
                                 caseInsensitive: shared.flatMap { fs.caseSensitive($0) }.map { !$0 } ?? true)
        guard state == .directory, !overlaps, let shared else { return inputs }
        for name in (try? fs.list(second.projects)) ?? [] {
            let path = "\(second.projects)/\(name)"
            if case .directory? = fs.kind(path) {
                inputs.secondDirectories[name] = (try? fs.list(path)) ?? []
            } else {
                inputs.secondFiles.append(name)
            }
        }
        inputs.sharedNames = Set((try? fs.list(shared)) ?? [])
        let fold = { (n: String) in SetupPlanner.key(n, caseInsensitive: inputs.caseInsensitive) }
        let wanted = Set(inputs.secondDirectories.keys.map(fold))
        for name in inputs.sharedNames where wanted.contains(fold(name)) {
            if case .directory? = fs.kind("\(shared)/\(name)") {
                inputs.sharedDirectories[name] = (try? fs.list("\(shared)/\(name)")) ?? []
            }
        }
        let a = fs.device(shared), b = fs.device(second.projects)
        inputs.sameVolume = a != nil && b != nil ? a == b : nil
        inputs.exclusiveRename = fs.supportsExclusiveRename(shared) && fs.supportsExclusiveRename(second.projects)
        return inputs
    }

    /// Claude Code processes registered in the folder's sessions/ (`<pid>.json`) that still exist. Names only.
    func runningProcesses(in folder: SwitchFolder) -> [String] {
        ((try? fs.list(folder.sessions)) ?? []).compactMap { name in
            guard name.hasSuffix(".json"), let pid = Int32(name.dropLast(5)), fs.processExists(pid) else { return nil }
            return "process \(pid)"
        }
    }

    /// Runs the next step of a fresh plan, but only if it is the step you confirmed: anything that changed since the
    /// sheet showed it stops the setup. Every move is an exclusive rename; the first error stops.
    public func runSetupStep(_ confirmed: SetupStep, inputs: SetupInputs, setAside: Bool, run: String) throws {
        try requireOn()
        let plan = SetupPlanner.make(inputs, setAside: setAside)
        if !auditEntries(limit: 200).contains(where: { $0.run == run && $0.action == AuditAction.setupChecked.rawValue }) {
            let failed = plan.checks.filter { !$0.passed }.map(\.title)
            try append(.init(ts: clock(), action: .setupChecked, result: plan.canRun ? .ok : .refused, appVersion: appVersion,
                             reason: failed.isEmpty ? (plan.blockedByClashes ? "clashes" : nil) : failed.joined(separator: "; "),
                             configDir: inputs.second.path, run: run))
        }
        guard plan.canRun, let step = plan.steps.first, step.sameWork(as: confirmed) else {
            let why = plan.canRun ? "the folders changed since the plan was shown" : "a check no longer passes"
            try? append(.init(ts: clock(), action: .setupStopped, result: .refused, appVersion: appVersion, reason: why,
                              configDir: inputs.second.path, run: run))
            throw SwitchError.changed("Nothing was moved: \(why). Check again.")
        }
        var created: [String] = []
        var moved: [AuditMove] = []
        var removed: [String] = []
        do {
            for d in step.createDirectories { created += try fs.ensureDirectory(d, mode: 0o700) }
            for m in step.moves {
                try fs.renameExclusive(m.from, m.to)
                moved.append(m)
            }
            for d in step.removeDirectories {
                try fs.removeDirectory(d)
                removed.append(d)
            }
            if let link = step.link { try fs.makeSymlink(at: link.from, target: link.to) }
        } catch {
            try? append(.init(ts: clock(), action: .setupStep, result: .failed, appVersion: appVersion, reason: describe(error),
                              configDir: inputs.second.path, run: run, step: step.number, moves: moved, created: created, paths: removed))
            try? append(.init(ts: clock(), action: .setupStopped, result: .failed, appVersion: appVersion, reason: describe(error),
                              configDir: inputs.second.path, run: run))
            throw SwitchError.file("The setup stopped: \(describe(error)). Everything moved so far is in the log; Copy Undo Script reverses it.")
        }
        try append(.init(ts: clock(), action: .setupStep, result: .ok, appVersion: appVersion, from: step.link?.from, to: step.link?.to,
                         configDir: inputs.second.path, run: run, step: step.number, moves: moved, created: created,
                         paths: removed + (step.link.map { [$0.from] } ?? [])))
        if step.kind == .link {
            try append(.init(ts: clock(), action: .setupFinished, result: .ok, appVersion: appVersion, configDir: inputs.second.path, run: run))
        }
    }

    /// The undo script for one setup run, from its logged moves (failed steps' moves included: they happened).
    public func undoScript(run: String) -> String? {
        let lines = auditEntries().filter { $0.run == run }.reversed()
        let steps = lines.filter { $0.action == AuditAction.setupStep.rawValue }
        guard let second = lines.first(where: { $0.configDir != nil })?.configDir, let at = steps.first?.ts else { return nil }
        let shared = steps.compactMap(\.to).last
        return UndoScript.text(secondFolder: second, sharedTree: shared, moves: steps.flatMap { $0.moves ?? [] },
                               created: steps.flatMap { $0.created ?? [] }, run: run, at: at)
    }

    /// A setup of `folder` that moved something and didn't finish: reopening the sheet continues it under the same
    /// run, so one undo script covers all of it.
    public func unfinishedRun(for folder: SwitchFolder) -> String? {
        var finished = Set<String>()
        for e in auditEntries() where e.configDir == folder.path {
            guard let run = e.run else { continue }
            if e.action == AuditAction.setupFinished.rawValue { finished.insert(run) }
            if e.action == AuditAction.setupStep.rawValue, !finished.contains(run) { return run }
        }
        return nil
    }

    /// Logs a setup left before its last step (the sheet closed), so the log shows it and offers its undo script.
    public func setupClosed(run: String, folder: SwitchFolder) {
        guard !isPreview, isOn() else { return }
        let lines = auditEntries(limit: 500).filter { $0.run == run }
        guard lines.contains(where: { $0.action == AuditAction.setupStep.rawValue }),
              !lines.contains(where: { $0.action == AuditAction.setupFinished.rawValue }),
              lines.first?.action != AuditAction.setupStopped.rawValue else { return }
        try? append(.init(ts: clock(), action: .setupStopped, result: .cancelled, appVersion: appVersion,
                          reason: "the sheet was closed before the last step", configDir: folder.path, run: run))
    }

    // MARK: The log

    public func auditEntries(limit: Int = 5000) -> [AuditEntry] {
        isPreview ? [] : log.entries(limit: limit)
    }

    /// While switching is off nothing is written, not even a refusal's log line.
    private func requireOn() throws {
        guard !isPreview else { throw SwitchError.preview }
        guard isOn() else { throw SwitchError.off }
    }

    private func append(_ entry: AuditEntry) throws {
        do {
            try log.append(entry)
        } catch {
            throw SwitchError.file("Couldn't write the audit log: \(describe(error))")
        }
        logRevision += 1
    }

    private func describe(_ error: any Error) -> String {
        (error as? SwitchFileError)?.description ?? (error as? LocalizedError)?.errorDescription ?? "\(error)"
    }

    /// `open -a Terminal <file>` from an argument array: no shell, no AppleScript, so no Automation permission. Runs off
    /// the main actor (resume() calls it from a detached task).
    public nonisolated static func openWithTerminal(_ path: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", terminalName, path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw SwitchError.terminal("open exited with status \(p.terminationStatus)") }
    }
}
