import AppKit
import SignalboxKit
import SignalboxSwitch
import SwiftUI

// signalbox-switch's screens (docs/SWITCH.md): the Settings section, the Terminal account box on Accounts, the
// shared-sessions setup sheet, the log, and "Resume with" with its confirm sheet. Nothing here shows while switching
// is off, except the Terminal account line when a pointer is already there.

/// A "Resume with" waiting for its confirm sheet.
struct PendingResume: Identifiable {
    let id = UUID()
    let entry: SessionHistoryEntry
    let folder: SwitchFolder
    let copyOnly: Bool
}

// MARK: - Settings

struct SwitchSettingsSection: View {
    @Environment(AppController.self) private var controller
    @State private var duration = SwitchDuration.standard
    @State private var confirming = false
    @State private var error: String?

    var body: some View {
        let s = controller.switcher
        Section("Account switching") {
            VStack(alignment: .leading, spacing: 6) {
                if let until = s.enabledUntil, s.isOn() {
                    LabeledContent("On until") {
                        Text(until, format: .dateTime.weekday(.abbreviated).hour().minute())
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Spacer()
                        Button("Turn Off") { s.disable() }
                            .controlSize(.small)
                    }
                } else {
                    Picker("Turn on for", selection: $duration) {
                        ForEach(SwitchDuration.allCases) { Text($0.title).tag($0) }
                    }
                    HStack {
                        Spacer()
                        Button("Turn On…") { confirming = true }
                            .controlSize(.small)
                    }
                }
                SettingsNote("Lets Signalbox pick the account claude uses in Terminal, resume a session under another account in a new Terminal window, and share one session history between your Claude Code folders. Off by default; it turns itself off after the time you choose, and every action goes into a log (Accounts ▸ Log). Unofficial: not affiliated with or endorsed by Anthropic.")
                if let error {
                    SettingsNote(error, systemImage: "exclamationmark.triangle", color: Theme.critical)
                }
            }
            .disabled(controller.isFixture)
        }
        .sheet(isPresented: $confirming) {
            SwitchOnSheet(duration: duration) {
                do {
                    try s.enable(duration)
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }
}

/// What turning switching on allows, before it is on.
struct SwitchOnSheet: View {
    let duration: SwitchDuration
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Turn on account switching for \(duration.title)?")
                .font(.headline)
            row("terminal", "Pick the account claude uses in Terminal",
                "Writes one pointer file, and once a small claude script (the shim) that reads it, in ~/Library/Application Support/signalbox/switch. You hook the shim into your shell yourself.")
            row("arrow.uturn.forward.circle", "Resume a session under another account",
                "Writes a one-time script that deletes itself, and opens it in Terminal, which runs claude --resume. Signalbox never runs claude itself, and only for sessions that aren't running.")
            row("folder.badge.gearshape", "Set up shared sessions, once",
                "Moves your second folder's transcripts into ~/.claude/projects and links its projects folder there, showing every change and asking before each step.")
            row("list.bullet.rectangle", "Log every action", "An append-only log in the same folder: Accounts ▸ Log.")
            Text("It never touches logins, settings files or your shell profile. It turns itself off after \(duration.title); your Terminal account stays chosen after that. Unofficial: not affiliated with or endorsed by Anthropic.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Turn On") {
                    confirm()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 500)
    }

    private func row(_ symbol: String, _ title: String, _ detail: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(Theme.accent)
        }
    }
}

// MARK: - Accounts: the Terminal account

struct TerminalAccountBox: View {
    @Environment(AppController.self) private var controller
    @Environment(SignalboxStore.self) private var store
    @State private var showSetup = false
    @State private var showLog = false
    @State private var error: String?

    var body: some View {
        let s = controller.switcher
        if s.isOn() || s.pointer != nil || s.pointerUnreadable {
            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    if s.isOn() {
                        picker
                        shellHelp
                        HStack {
                            Button("Set Up Shared Sessions…") { showSetup = true }
                            Button("Log…") { showLog = true }
                            Spacer()
                        }
                        .controlSize(.small)
                    } else {
                        LabeledContent("Active in Terminal") {
                            Text(current).privacySensitive()
                        }
                        HStack {
                            Text("Account switching is off (Settings ▸ Advanced). The Terminal account stays as it is.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            Button("Log…") { showLog = true }
                                .controlSize(.small)
                        }
                    }
                    if s.pointerUnreadable {
                        Label("The pointer file can't be read, so the shim refuses to run. Pick an account again.", systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                    }
                    if let problem = error ?? s.logProblem {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Theme.critical)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Text("Terminal account").font(.headline)
            }
            .sheet(isPresented: $showSetup) { SetupSheet() }
            .sheet(isPresented: $showLog) { SwitchLogView() }
        }
    }

    private var current: String {
        controller.terminalFolder.map(controller.switchLabel) ?? (controller.switcher.pointerUnreadable ? "Unreadable" : "Not chosen")
    }

    private var picker: some View {
        let folders = controller.switchFolders
        let unlisted = controller.terminalFolder.flatMap { f in folders.contains(f) ? nil : f }
        return Picker("Active in Terminal", selection: Binding<String>(
            get: { controller.terminalFolder?.id ?? "" },
            set: { id in
                guard let f = folders.first(where: { $0.id == id }) else { return }
                do {
                    try controller.switcher.setPointer(f, account: controller.auditAccount(f))
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
        )) {
            if controller.terminalFolder == nil { Text("Not chosen").tag("") }
            ForEach(folders) { f in Text(controller.switchLabel(f)).tag(f.id) }
            if let unlisted { Text("\(Fmt.shortPath(unlisted.path)) (not in your folder list)").tag(unlisted.id) }
        }
        .privacySensitive()
        .help("Writes the pointer file the shim reads. A claude already running keeps its account.")
    }

    private var shellHelp: some View {
        let p = controller.switcher.paths
        return DisclosureGroup("Use it in Terminal") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Paste one of these into your shell profile; Signalbox never edits it. The function changes only what you type; the PATH line changes every program started from your shell.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                snippet("zsh or bash (~/.zshrc, ~/.bashrc)", ShimScript.functionLines(shimPath: p.shim))
                snippet("fish (~/.config/fish/functions/claude.fish)", ShimScript.fishFunction(shimPath: p.shim))
                snippet("Or a PATH entry", ShimScript.pathLine(binDir: p.binDir))
            }
            .padding(.top, 4)
        }
        .font(.callout)
    }

    private func snippet(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.caption.weight(.medium))
                Spacer()
                CopyButton(text: text).controlSize(.mini)
            }
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                .privacySensitive()
        }
    }
}

// MARK: - Setup

struct SetupSheet: View {
    @Environment(AppController.self) private var controller
    @Environment(SettingsStore.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var secondID = ""
    @State private var setAside = false
    @State private var inputs: SetupInputs?
    @State private var run = UUID().uuidString.lowercased()
    @State private var confirmStep: SetupStep?
    @State private var error: String?
    @State private var done: [String] = []

    var body: some View {
        let seconds = controller.switchFolders.filter { !$0.isDefault }
        VStack(alignment: .leading, spacing: 12) {
            Text("Set Up Shared Sessions").font(.title3.weight(.semibold))
            Text("Gives your second Claude Code folder the same session history as ~/.claude: its transcripts move into ~/.claude/projects, and its projects folder becomes a link there. Logins and settings stay apart. Every move is a rename that never replaces anything, and each step asks first.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if seconds.isEmpty {
                ContentUnavailableView("No second folder", systemImage: "folder.badge.plus",
                                       description: Text("Add your second Claude Code folder in Settings ▸ Advanced ▸ Claude Code folders first."))
            } else {
                if seconds.count > 1 {
                    Picker("Second folder", selection: $secondID) {
                        ForEach(seconds) { Text(controller.switchLabel($0)).tag($0.id) }
                    }
                }
                ScrollView {
                    if let inputs { planView(SetupPlanner.make(inputs, setAside: setAside)) }
                }
                .frame(minHeight: 320)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(Theme.critical)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Check Again") { replan() }
                    .disabled(seconds.isEmpty)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 640, height: 600)
        .onAppear {
            secondID = seconds.first?.id ?? ""
            replan()
        }
        .onChange(of: secondID) { replan() }
        // A setup left before its last step is logged, and reopening the sheet continues the same run.
        .onDisappear { if let second { controller.switcher.setupClosed(run: run, folder: second) } }
        .confirmationDialog(confirmStep.map { "Run step \($0.number)?" } ?? "", isPresented: Binding(get: { confirmStep != nil }, set: { if !$0 { confirmStep = nil } }),
                            presenting: confirmStep) { step in
            Button("Run Step \(step.number)") { runStep(step) }
            Button("Cancel", role: .cancel) {}
        } message: { step in
            Text("\(step.title). Signalbox checks everything again first and stops if anything changed.")
        }
    }

    private var second: SwitchFolder? { controller.switchFolders.first { $0.id == secondID && !$0.isDefault } }

    private func replan() {
        guard let second else { inputs = nil; return }
        if done.isEmpty, let unfinished = controller.switcher.unfinishedRun(for: second) { run = unfinished }
        let joining = controller.setupJoining(second: second)
        inputs = controller.switcher.setupInputs(second: second, defaultFolder: controller.switchFolders[0], joining: joining,
                                                 retention: controller.setupRetention(second: second),
                                                 threshold: settings.retentionWarnDays,
                                                 runningSessions: controller.runningSessions(in: [second] + joining))
    }

    private func runStep(_ step: SetupStep) {
        replan()
        guard let inputs else { return }
        do {
            try controller.switcher.runSetupStep(step, inputs: inputs, setAside: setAside, run: run)
            done.append(step.title)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        replan()
    }

    @ViewBuilder private func planView(_ plan: SetupPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if plan.alreadyDone {
                Label("Already set up: \(Fmt.shortPath(inputs?.second.projects ?? "")) links to the shared tree.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Theme.ok)
            }
            GroupBox("Checks") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(plan.checks) { c in
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: c.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(c.passed ? Theme.ok : Theme.critical)
                            Text(c.title)
                            Spacer()
                            Text(c.detail).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                        }
                        .font(.caption)
                        .privacySensitive()
                    }
                }
                .padding(4)
            }
            if plan.checks.contains(where: { $0.id.hasPrefix("retention:") && !$0.passed }) {
                Text("Raise cleanupPeriodDays yourself: add \"cleanupPeriodDays\": 365 to each folder's settings.json. Signalbox never edits it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !plan.alreadyDone, inputs?.secondState == .directory, let second {
                GroupBox("Before you start") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Back up first: Time Machine, or a quick APFS clone that takes almost no space until files change (same volume only).")
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                        let clone = "cp -cR \(HistoryBrowser.shellQuote(second.projects)) \(HistoryBrowser.shellQuote(second.path + "/projects-before-switch"))"
                        HStack {
                            Text(clone).font(.caption.monospaced()).textSelection(.enabled).lineLimit(2).privacySensitive()
                            Spacer()
                            CopyButton(text: clone).controlSize(.mini)
                        }
                    }
                    .padding(4)
                }
            }
            if !plan.clashes.isEmpty {
                GroupBox("In both trees") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(plan.clashes, id: \.self) { Text($0).font(.caption.monospaced()).privacySensitive() }
                        Toggle("Set the second folder's copies aside in \(SetupPlanner.setAsideFolder) (otherwise sort them out yourself first)", isOn: $setAside)
                            .font(.caption)
                    }
                    .padding(4)
                }
            }
            ForEach(Array(plan.steps.enumerated()), id: \.element.id) { index, step in
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        DisclosureGroup("\(step.moves.count) \(step.moves.count == 1 ? "move" : "moves")\(step.link == nil ? "" : ", then the link")") {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(step.createDirectories, id: \.self) { Text("mkdir \(Fmt.shortPath($0))") }
                                ForEach(step.moves, id: \.self) { Text("\(Fmt.shortPath($0.from)) → \(Fmt.shortPath($0.to))") }
                                ForEach(step.removeDirectories, id: \.self) { Text("rmdir \(Fmt.shortPath($0))") }
                                if let l = step.link { Text("ln -s \(Fmt.shortPath(l.to)) \(Fmt.shortPath(l.from))") }
                            }
                            .font(.caption2.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                        }
                        .font(.caption)
                        if index == 0 {
                            HStack {
                                Spacer()
                                Button("Run Step \(step.number)…") { confirmStep = step }
                                    .disabled(!plan.canRun || !controller.switcher.isOn())
                            }
                        }
                    }
                    .padding(4)
                } label: {
                    Text("Step \(step.number): \(step.title)").font(.callout.weight(.medium)).privacySensitive()
                }
            }
            ForEach(done, id: \.self) { title in
                Label(title, systemImage: "checkmark").font(.caption).foregroundStyle(.secondary).privacySensitive()
            }
        }
    }
}

// MARK: - Log

struct SwitchLogView: View {
    @Environment(AppController.self) private var controller
    @Environment(\.dismiss) private var dismiss
    @State private var copiedRun: String?

    var body: some View {
        let s = controller.switcher
        let _ = s.logRevision
        let entries = s.auditEntries()
        // The undo button sits on the newest line of each setup run that moved something.
        let undoRows: Set<String> = {
            var seen = Set<String>(), rows = Set<String>()
            let withSteps = Set(entries.filter { $0.action == AuditAction.setupStep.rawValue && !($0.moves ?? []).isEmpty }.compactMap(\.run))
            for e in entries { if let r = e.run, withSteps.contains(r), seen.insert(r).inserted { rows.insert(e.id) } }
            return rows
        }()
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Account switching log").font(.title3.weight(.semibold))
                Spacer()
                Text(Fmt.shortPath(s.paths.audit)).font(.caption.monospaced()).foregroundStyle(.secondary).privacySensitive()
            }
            if entries.isEmpty {
                ContentUnavailableView("Nothing logged yet", systemImage: "list.bullet.rectangle",
                                       description: Text("Every action account switching takes appears here, refusals included."))
            } else {
                List(entries) { e in row(e, undo: undoRows.contains(e.id)) }
                    .listStyle(.inset)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 680, height: 500)
    }

    private func row(_ e: AuditEntry, undo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(e.knownAction?.title ?? e.action).font(.callout.weight(.medium))
                if e.result != "ok" {
                    Text(e.result).font(.caption2.weight(.semibold)).padding(.horizontal, 5).padding(.vertical, 1)
                        .background((e.result == "failed" ? Theme.critical : Theme.warning).opacity(0.2), in: Capsule())
                }
                Spacer()
                Text(e.ts, format: .dateTime.month(.abbreviated).day().hour().minute().second())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(detail(e))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .privacySensitive()
            if undo, let run = e.run, let script = controller.switcher.undoScript(run: run) {
                HStack {
                    Spacer()
                    Button(copiedRun == run ? "Copied" : "Copy Undo Script") {
                        Clipboard.copy(script)
                        copiedRun = run
                    }
                    .controlSize(.small)
                    .help("A shell script that moves every logged entry back and removes the link. Quit Claude Code in every folder before running it.")
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func detail(_ e: AuditEntry) -> String {
        var parts: [String] = []
        if let a = e.account { parts.append(a.label.map { "\($0) (\(AccountNaming.shortID(a.id)))" } ?? AccountNaming.shortID(a.id)) }
        if let from = e.from, let to = e.to, e.action == AuditAction.pointerSet.rawValue { parts.append("\(from) → \(to)") }
        if let d = e.configDir { parts.append(Fmt.shortPath(d)) }
        if let sid = e.sessionId { parts.append("session \(sid.prefix(8))\(e.fork == true ? " as a copy" : "")") }
        if let until = e.until { parts.append("until \(until.formatted(.dateTime.month(.abbreviated).day().hour().minute()))") }
        if let step = e.step { parts.append("step \(step)") }
        if let m = e.moves, !m.isEmpty { parts.append("\(m.count) \(m.count == 1 ? "move" : "moves")") }
        if let p = e.paths, !p.isEmpty, e.moves == nil { parts.append(p.map { Fmt.shortPath($0) }.joined(separator: ", ")) }
        if let r = e.reason { parts.append(r) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Resume with

/// The "Resume With" menu for a history entry; empty while switching is off.
struct ResumeWithMenu: View {
    @Environment(AppController.self) private var controller
    @Environment(SignalboxStore.self) private var store
    let entry: SessionHistoryEntry

    var body: some View {
        let s = controller.switcher
        if s.isOn() {
            let choices = ResumePlanner.choices(entry: entry, fleet: store.fleet, switchOn: true, folders: controller.switchFolders,
                                                accounts: store.accounts) { f in
                entry.transcriptPath.map { s.canSee($0, from: f) } ?? false
            }
            Menu {
                if let block = choices.block {
                    Text(block.text)
                } else {
                    ForEach(choices.options) { o in
                        Button(controller.switchLabel(o.folder) + (o.block == nil ? "" : " (\(o.block!.text))")) {
                            controller.pendingResume = PendingResume(entry: entry, folder: o.folder, copyOnly: choices.copyOnly)
                        }
                        .disabled(o.block != nil)
                    }
                }
            } label: {
                Label("Resume With", systemImage: "arrow.uturn.forward.circle")
            }
            .privacySensitive()
        }
    }
}

struct ResumeSheet: View {
    @Environment(AppController.self) private var controller
    @Environment(SignalboxStore.self) private var store
    @Environment(\.directoryExists) private var directoryExists
    @Environment(\.dismiss) private var dismiss
    let pending: PendingResume
    @State private var asCopy = false
    @State private var error: String?
    @State private var opening = false

    var body: some View {
        let request = self.request
        VStack(alignment: .leading, spacing: 12) {
            Text("Resume in Terminal under \(controller.switchLabel(pending.folder))?")
                .font(.headline)
                .privacySensitive()
            GroupBox {
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent("Session") { Text(pending.entry.displayTitle ?? "Untitled").lineLimit(1).privacySensitive() }
                    if let p = pending.entry.project { LabeledContent("Folder") { Text(Fmt.shortPath(p)).lineLimit(1).truncationMode(.middle).privacySensitive() } }
                    LabeledContent("Last active") { Text(pending.entry.lastActivityAt, format: .relative(presentation: .named)) }
                }
                .font(.callout)
                .padding(4)
            }
            Toggle("Start as a copy (a new session id; the original stays as it is)", isOn: Binding(get: { asCopy || pending.copyOnly }, set: { asCopy = $0 }))
                .disabled(pending.copyOnly)
            if pending.copyOnly {
                Text("Desktop app sessions are resumed only as a copy: the Claude app can write to them again at any time.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let command = request?.displayCommand {
                Text(command)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .privacySensitive()
            } else {
                Label(controller.realClaudePath == nil ? ResumeBlock.noClaude.text : ResumeBlock.unsafeID.text, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Theme.warning)
            }
            Text("This account starts with a cold cache: the whole conversation is sent again with your first message and counts against its limits. Claude Code may ask \"Resume this conversation?\" first. Signalbox writes a one-time script, opens it in Terminal and logs it; Terminal runs claude.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Theme.critical)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Open in Terminal") { open() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(request == nil || opening)
            }
        }
        .padding(20)
        .frame(width: 540)
    }

    private var request: ResumeRequest? {
        guard let claude = controller.realClaudePath else { return nil }
        let dir = HistoryBrowser.resumeDirectory(pending.entry).flatMap { directoryExists($0) ? $0 : nil }
        let r = ResumeRequest(sessionId: pending.entry.sessionId, cwd: dir, folder: pending.folder, fork: asCopy || pending.copyOnly, claudePath: claude)
        return r.script == nil ? nil : r
    }

    private func open() {
        // Checked again now: the session may have started since the menu was shown.
        let s = controller.switcher
        let choices = ResumePlanner.choices(entry: pending.entry, fleet: store.fleet, switchOn: s.isOn(), folders: [pending.folder],
                                            accounts: store.accounts) { f in pending.entry.transcriptPath.map { s.canSee($0, from: f) } ?? false }
        if let block = choices.block ?? choices.options.first?.block {
            error = block.text
            return
        }
        guard let request, let transcript = pending.entry.transcriptPath, !opening else { return }
        opening = true
        let live = ResumePlanner.isLive(pending.entry, fleet: store.fleet)
        Task {
            defer { opening = false }
            do {
                try await s.resume(request, transcriptPath: transcript, live: live, account: controller.auditAccount(pending.folder))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
