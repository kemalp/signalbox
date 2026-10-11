import SignalboxKit
import SwiftUI

/// Everything Signalbox knows about one history entry, and the command that resumes it. A session only in the Claude
/// app's list (no transcript on this Mac) has no figures and no resume command, and says why.
struct HistoryInspector: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money
    @Environment(\.directoryExists) private var directoryExists
    let entry: SessionHistoryEntry?

    var body: some View {
        if let e = entry {
            let now = store.now
            let live = HistoryBrowser.liveRoute(e, fleet: store.fleet)
            Form {
                Section {
                    header(e, live: live)
                }
                if e.isAppOnly {
                    noTranscriptSection(live: live)
                } else {
                    resumeSection(e, live: live)
                }
                Section("When") {
                    row("Started", dated(e.startedAt, now: now))
                    // The Claude app's last activity for a session with no transcript; "Ended" would claim more.
                    row(live != nil || e.isAppOnly ? "Last activity" : "Ended", dated(e.lastActivityAt, now: now))
                    if e.hasTranscript {
                        row("Duration", e.duration.map { Fmt.duration($0) })
                    }
                }
                Section("Where") {
                    LabeledContent("Project") {
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(e.project.map { Fmt.shortPath($0) } ?? Fmt.dash)
                                .foregroundStyle(e.project == nil ? .tertiary : .primary)
                                .textSelection(.enabled)
                                .lineLimit(2)
                                .multilineTextAlignment(.trailing)
                                .help(e.project ?? "")
                                .privacySensitive()
                            if let project = e.project {
                                Button("Reveal in Finder") { Finder.reveal(project) }
                                    .controlSize(.small)
                                    .disabled(!FileManager.default.fileExists(atPath: project))
                            }
                        }
                    }
                    // The Claude app's record has none of these; dashes would only say so three times.
                    if e.hasTranscript || e.gitBranch != nil { row("Git branch", e.gitBranch, mono: true, sensitive: true) }
                    if e.hasTranscript || e.entrypoint != nil { row("Entrypoint", e.entrypoint) }
                    if e.hasTranscript || e.version != nil { row("Version", e.version.map { "v\($0)" }) }
                }
                if e.isAppOnly {
                    Section("Usage") {
                        modelsRow(e)
                        if let effort = e.effort { row("Effort", effort) }
                        LabeledContent("Cost (recorded)") {
                            Text(HistoryBrowser.costLabel(e))
                                .foregroundStyle(.tertiary)
                                .help("No usage: the transcript isn't on this Mac")
                        }
                    }
                } else {
                    usageSections(e)
                }
                Section("Source") {
                    row("Agent", Fmt.agentName(e.agent))
                    // A session the Claude app lists without a Claude Code id carries the app's id as its session id;
                    // it is shown once, as the app's.
                    if e.sessionId != e.appSessionId {
                        LabeledContent("Session ID") {
                            Text(e.sessionId)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                                .privacySensitive()
                        }
                    }
                    if e.isInClaudeApp {
                        LabeledContent("Claude app") {
                            Text(e.isArchived ? "Listed, archived" : "Listed")
                                .font(.callout)
                                .foregroundStyle(.primary)
                        }
                        .help("The session is in the Claude app's session list. Signalbox reads the app's session records read-only: title, folder, dates, ids, model, effort and archived flag.")
                        if let appID = e.appSessionId {
                            LabeledContent("Claude app ID") {
                                Text(appID)
                                    .font(.caption.monospaced())
                                    .textSelection(.enabled)
                                    .multilineTextAlignment(.trailing)
                                    .privacySensitive()
                            }
                        }
                    }
                    LabeledContent("Transcript") {
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(e.transcriptPath.map { Fmt.shortPath($0) } ?? (e.isAppOnly ? "Not on this Mac" : Fmt.dash))
                                .foregroundStyle(e.transcriptPath == nil ? .tertiary : .primary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .help(e.transcriptPath ?? "")
                                .privacySensitive(e.transcriptPath != nil)
                            if let path = e.transcriptPath {
                                Button("Reveal Transcript in Finder") { Finder.reveal(path) }
                                    .controlSize(.small)
                                    .disabled(!FileManager.default.fileExists(atPath: path))
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
        } else {
            ContentUnavailableView("No Session Selected", systemImage: "sidebar.trailing", description: Text("Select a session to see its details and the command that resumes it."))
        }
    }

    /// Why a session only in the Claude app's list has no figures and no resume command.
    private func noTranscriptSection(live: HistoryLiveRoute?) -> some View {
        Section {
            Label {
                Text(Self.appOnlyExplanation)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "doc.questionmark")
                    .foregroundStyle(.secondary)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            if let live {
                HStack(spacing: 6) {
                    Text("This session is running now.")
                    Button("Show in Sessions") { nav.open(live) }
                        .buttonStyle(.link)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        } header: {
            Text("No transcript")
        }
    }

    private func resumeSection(_ e: SessionHistoryEntry, live: HistoryLiveRoute?) -> some View {
        Section {
            resume(e)
        } header: {
            Text("Resume")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let live {
                    HStack(spacing: 6) {
                        Text("This session is still running.")
                        Button("Show in Sessions") { nav.open(live) }
                            .buttonStyle(.link)
                    }
                }
                if HistoryBrowser.resumeLine(e, directoryExists: directoryExists) != nil {
                    Text("Paste it into a terminal. Signalbox never resumes, messages or changes a session itself.")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// Usage and activity from the transcript.
    @ViewBuilder private func usageSections(_ e: SessionHistoryEntry) -> some View {
        Section("Usage") {
            modelsRow(e)
            if let effort = e.effort {
                row("Effort", effort)
                    .help("The effort level the Claude app last set for the session")
            }
            LabeledContent("Cost (recorded)") {
                VStack(alignment: .trailing, spacing: 2) {
                    CostText(value: e.costUsd, unpriced: e.hasUnpriced)
                    Text(money.isConverted ? "list-price equivalent, converted at your rate" : "list-price equivalent, not a bill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(money.footnote() ?? "")
                }
            }
            if let ledger = e.ledgerUsd {
                LabeledContent("Claude Code's figure") {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(money.amount(ledger))
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.primary)
                        // Claude Code writes its cost state when a session ends or resumes, so a live session's
                        // figure stops at the last resume.
                        if e.live {
                            Text("saved at the last resume; out of date while the session runs")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .help("Claude Code's own cost state for this session, priced with the same table. Claude Code saves it when a session ends or resumes. It can be higher than the recorded figure when transcripts miss some output.")
                }
            }
            if let unpriced = e.unpricedTokens, unpriced > 0 {
                row("Unpriced tokens", Fmt.tokens(unpriced))
            }
            row("Responses", e.responses.map { Fmt.count($0) })
            row("Fresh tokens", e.tokens.map { Fmt.tokens($0.fresh) })
                .help("Input, cache writes and output: everything except cache reads")
            row("Processed tokens", e.tokens.map { Fmt.tokens($0.processed) })
                .help("Everything the model processed, cache reads included")
            if let share = e.placeholderShare, share > 0 {
                row("Placeholder usage", "\(Fmt.ratio(share, digits: 0)) of responses")
                    .help("Responses written before streaming finished carry placeholder output counts, so the recorded cost is a lower bound.")
            }
        }
        Section("Activity") {
            row("Compactions", e.compactions.map { Fmt.count($0) })
            row("Subagents", e.subagentFiles.map { $0 == 1 ? "1 transcript" : "\(Fmt.count($0)) transcripts" })
            row("Workflow runs", e.workflowRuns.map { Fmt.count($0) })
        }
    }

    private func header(_ e: SessionHistoryEntry, live: HistoryLiveRoute?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = e.displayTitle {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .privacySensitive()
            } else {
                Text("Untitled session")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            if let source = e.titleSourceExplanation {
                Label(source, systemImage: symbol(e.titleSource))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help(e.appTitleSource.map { "The Claude app's label for this title: \($0)" } ?? "")
            }
            HStack(spacing: 6) {
                AgentBadge(agent: e.agent)
                if let live {
                    LivePill(status: HistoryBrowser.liveStatus(e, fleet: store.fleet)) { nav.open(live) }
                }
                if e.isArchived { ArchivedTag() }
                if let name = e.projectName {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .privacySensitive()
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// The command in monospace with a Copy button, or why there is none.
    @ViewBuilder private func resume(_ e: SessionHistoryEntry) -> some View {
        if let line = HistoryBrowser.resumeLine(e, directoryExists: directoryExists) {
            VStack(alignment: .leading, spacing: 8) {
                // Small enough that a session id (36 characters) fits the inspector's width on one line.
                Text(line)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .privacySensitive()
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    // A `cd` into a folder that's gone would fail and stop the command after it.
                    if let gone = HistoryBrowser.missingResumeDirectory(e, directoryExists: directoryExists) {
                        Label("The project folder no longer exists, so the line has no cd.", systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .help(gone)
                    }
                    Spacer(minLength: 0)
                    CopyButton(text: line)
                        .controlSize(.small)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityElement(children: .contain)
        } else {
            Text("The CLI didn't send a resume command for this session.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func symbol(_ source: HistoryTitleSource) -> String {
        switch source {
        case .custom: "pencil"
        case .ai: "sparkles"
        case .agentName: "person.crop.circle"
        case .index: "list.bullet"
        case .app: "macwindow"
        case .none, .unknown: "text.quote"
        }
    }

    static let appOnlyExplanation = "This session is in the Claude app's list, but its Claude Code transcript isn't on this Mac (removed or created elsewhere), so there's no usage or resume command."

    /// "Model" (or "Models", by cost) in monospace, or a dash.
    private func modelsRow(_ e: SessionHistoryEntry) -> some View {
        LabeledContent(e.models.count > 1 ? "Models" : "Model") {
            if e.models.isEmpty {
                Text(Fmt.dash).foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .trailing, spacing: 2) {
                    ForEach(e.models, id: \.self) { m in
                        Text(m)
                            .font(.callout.monospaced())
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    /// "Oct 9, 2026 at 09:30 · 5h ago"; months-old sessions (the Claude app's list keeps them) read "7 months ago".
    private func dated(_ date: Date, now: Date) -> String {
        "\(date.formatted(date: .abbreviated, time: .shortened)) · \(Fmt.agoRounded(date, now: now))"
    }

    /// `sensitive`: the value is the user's own (a branch name), redacted where macOS asks for that.
    @ViewBuilder
    private func row(_ label: String, _ value: String?, mono: Bool = false, sensitive: Bool = false) -> some View {
        LabeledContent(label) {
            Text(value ?? Fmt.dash)
                .font(mono ? .callout.monospaced() : .callout)
                .foregroundStyle(value == nil ? .tertiary : .primary)
                .textSelection(.enabled)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
                .privacySensitive(sensitive && value != nil)
        }
    }
}
