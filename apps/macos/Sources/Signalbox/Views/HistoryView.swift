import AppKit
import SignalboxKit
import SwiftUI

/// Every past and live session, newest first, grouped by day like the Claude app's session list: the sessions the CLI
/// found a transcript for (title, where it ran, how long, on which model, what it cost) and, from newer CLIs, the
/// Claude app's own list (its titles win; a session the app lists without a transcript on this Mac shows "No
/// transcript" and no figures). Archived sessions are hidden until asked for, as in the app. Titles and stats only;
/// Signalbox never shows prompts, replies or tool output.
struct HistoryView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money

    var body: some View {
        @Bindable var nav = nav
        Group {
            if let history = store.history {
                if history.entries.isEmpty {
                    ContentUnavailableView {
                        Label("No Sessions Yet", systemImage: SidebarSection.history.systemImage)
                    } description: {
                        Text("Signalbox found no Claude Code or Codex sessions on this Mac. A session shows here once its agent has written a transcript.")
                    }
                } else {
                    HistoryList(history: history)
                }
            } else {
                // Only the placeholder needs a clock (waiting → "Update the CLI" after the grace period).
                LiveNow(anchors: [store.connectedAt]) { now in
                    HistoryPlaceholder(state: store.historyState(now: now))
                }
            }
        }
        .navigationTitle("History")
        .navigationSubtitle(subtitle)
        .searchable(text: $nav.historyFilter.query, placement: .toolbar, prompt: "Search titles and projects")
        .inspector(isPresented: Binding(get: { nav.showHistoryInspector && hasEntries }, set: { nav.showHistoryInspector = $0 })) {
            HistoryInspector(entry: store.historyEntry(id: nav.selectedHistoryID))
                .glassPanelColorScheme()
                .inspectorColumnWidth(min: 300, ideal: 340, max: 460)
        }
        .toolbar {
            CommonToolbar()
            ToolbarItem(placement: .primaryAction) {
                Button {
                    nav.showHistoryInspector.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help("Show or hide session details")
                .disabled(!hasEntries)
            }
        }
    }

    private var hasEntries: Bool { !(store.history?.entries.isEmpty ?? true) }

    /// What the list shows of what the CLI matched ("52 of 59 sessions" while filters or hidden empty sessions
    /// narrow it), so it agrees with the count above the list.
    private var subtitle: String {
        guard let h = store.history else { return "" }
        let shown = HistoryBrowser.filtered(h.entries, filter: nav.historyFilter, now: store.now).count
        var parts = [HistoryBrowser.countLabel(shown: shown, total: h.total)]
        if h.truncated, h.entries.count < h.total { parts.append("the CLI sent the newest \(h.entries.count)") }
        if money.isConverted { parts.append("costs in \(money.currency.code) at your rate") }
        return parts.joined(separator: " · ")
    }
}

/// What the screen says before (or instead of) a history.
private struct HistoryPlaceholder: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    let state: HistoryState

    var body: some View {
        switch state {
        case .ready, .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text("Reading session history…")
                    .foregroundStyle(.secondary)
                Text("The first scan reads the usage and title of every transcript, which can take a minute on a Mac with many sessions.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .cliTooOld:
            ContentUnavailableView {
                Label("Update the CLI", systemImage: "arrow.down.circle")
            } description: {
                Text("The signalbox CLI\(store.cliVersion.map { " (\($0))" } ?? "") this app is connected to hasn't sent a session history. It may be too old to: rebuild the app with apps/macos/scripts/build-app.sh, which bundles the current CLI, or choose a newer one in Settings ▸ Advanced.")
            } actions: {
                Button("Show Diagnostics") { nav.showDiagnostics = true }
            }
        case .notInSnapshot:
            ContentUnavailableView {
                Label("No History", systemImage: SidebarSection.history.systemImage)
            } description: {
                // Non-breaking hyphens keep the option on one line.
                Text("This snapshot has no session history. Run the app with the CLI, or give it one with \u{2011}\u{2011}fixture\u{2011}history.")
            }
        case .unavailable:
            NoDataView(waitingFor: "the session history")
        }
    }
}

private struct HistoryList: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.directoryExists) private var directoryExists
    let history: HistorySnapshot

    var body: some View {
        @Bindable var nav = nav
        let filter = nav.historyFilter
        let now = store.now
        let shown = HistoryBrowser.filtered(history.entries, filter: filter, now: now)
        let empties = HistoryBrowser.emptyCount(history.entries, filter: filter, now: now)
        let archived = HistoryBrowser.archivedCount(history.entries, filter: filter, now: now)
        let groups = HistoryBrowser.groups(shown, now: now)
        let fleet = store.fleet
        List(selection: $nav.selectedHistoryID) {
            ForEach(groups) { group in
                Section {
                    ForEach(group.entries) { e in
                        HistoryRow(entry: e, kind: group.kind, now: now, showAgent: filter.agent == nil,
                                   live: HistoryBrowser.liveRoute(e, fleet: fleet), liveStatus: HistoryBrowser.liveStatus(e, fleet: fleet)) { route in
                            nav.open(route)
                        }
                        .tag(e.id)
                    }
                } header: {
                    HistoryGroupHeader(group: group)
                }
            }
        }
        .listStyle(.inset)
        .overlay {
            if groups.isEmpty { emptyState(filter, empties: empties, archived: archived) }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ConnectionBanner(scopes: [.history])
                HistoryHeader(history: history, shown: shown, empties: empties, archived: archived)
                Divider()
            }
        }
        .contextMenu(forSelectionType: SessionHistoryEntry.ID.self) { ids in
            if ids.count == 1, let e = ids.first.flatMap({ store.historyEntry(id: $0) }) {
                HistoryActions(entry: e, live: HistoryBrowser.liveRoute(e, fleet: fleet))
            }
        }
        // ⌘C (Edit ▸ Copy) copies the selected session's resume command, like the inspector's Copy button.
        .onCopyCommand {
            guard let e = store.historyEntry(id: nav.selectedHistoryID),
                  let line = HistoryBrowser.resumeLine(e, directoryExists: directoryExists) else { return [] }
            return [NSItemProvider(object: line as NSString)]
        }
    }

    @ViewBuilder private func emptyState(_ filter: HistoryFilter, empties: Int, archived: Int) -> some View {
        if !filter.showArchived, archived > 0 {
            // Archived sessions fit (the search included); everything else is hidden.
            ContentUnavailableView {
                Label(filter.isSearching ? "Only Archived Sessions Match" : "Only Archived Sessions", systemImage: "archivebox")
            } description: {
                Text(archived == 1
                    ? "The one session that fits is archived in the Claude app. Archived sessions are hidden, as in the app."
                    : "The \(archived) sessions that fit are archived in the Claude app. Archived sessions are hidden, as in the app.")
            } actions: {
                Button("Show Archived Sessions") { nav.historyFilter.showArchived = true }
            }
        } else if !filter.showEmpty, empties > 0, !filter.isSearching {
            ContentUnavailableView {
                Label("Only Empty Sessions", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text(empties == 1
                    ? "The one session that fits these filters is empty: no title and no responses."
                    : "The \(empties) sessions that fit these filters are empty: no title and no responses.")
            } actions: {
                Button("Show Empty Sessions") { nav.historyFilter.showEmpty = true }
                if filter.hasFilters {
                    Button("Clear Filters") { nav.historyFilter = HistoryFilter() }
                }
            }
        } else if filter.isSearching {
            ContentUnavailableView {
                Label("No Results for “\(filter.query.trimmingCharacters(in: .whitespaces))”", systemImage: "magnifyingglass")
                    .privacySensitive()
            } description: {
                Text(filter.hasFilters ? "No session matches the search with these filters." : "Search looks at session titles and project folder names.")
            } actions: {
                if filter.hasFilters {
                    Button("Search All Sessions") { nav.historyFilter = HistoryFilter(query: filter.query) }
                }
            }
        } else {
            ContentUnavailableView {
                Label("No Matching Sessions", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text(filter.range == .all ? "No session fits these filters." : "No session fits these filters in the last \(filter.range.title).")
            } actions: {
                Button("Clear Filters") { nav.historyFilter = HistoryFilter() }
            }
        }
    }
}

/// The note, the filters and the total of what's shown, pinned above the list.
private struct HistoryHeader: View {
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money
    let history: HistorySnapshot
    let shown: [SessionHistoryEntry]
    /// Empty sessions the other filters keep (hidden unless `showEmpty`).
    let empties: Int
    /// Sessions archived in the Claude app that the other filters keep (hidden unless `showArchived`).
    let archived: Int

    var body: some View {
        @Bindable var nav = nav
        VStack(alignment: .leading, spacing: 10) {
            // Everything here wraps before it widens the column: with the inspector open, a 900-point window leaves the
            // list about 400 points. (No ViewThatFits: a split view column keeps the width of its widest variant.)
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                note
                    .frame(maxWidth: .infinity, alignment: .leading)
                total
            }
            .font(.callout)

            FlowLayout(spacing: 12, lineSpacing: 8) {
                HistoryAgentChips(history: history, filter: $nav.historyFilter)
                projectMenu
                rangePicker
                emptyToggle
                archivedToggle
            }
            .font(.callout)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .onChange(of: nav.historyFilter.agent) { _, agent in
            // A project the newly picked agent has no session in would leave the list empty.
            if let p = nav.historyFilter.project, !projects(agent: agent).contains(where: { $0.path == p }) {
                nav.historyFilter.project = nil
            }
        }
    }

    private func projects(agent: AgentID?) -> [HistoryProject] {
        HistoryBrowser.projects(agent.map { a in history.entries.filter { $0.agent == a } } ?? history.entries)
    }

    /// "42 sessions · $123.45" for what the filters keep.
    private var summary: String {
        let count = shown.count == 1 ? "1 session" : "\(shown.count) sessions"
        guard let cost = HistoryBrowser.totalCost(shown) else { return count }
        return "\(count) · \(money.amount(cost))"
    }

    private var note: some View {
        let (text, help) = HistoryHeader.note(history)
        return Label {
            Text(text)
                .lineLimit(3)
        } icon: {
            Image(systemName: "info.circle")
                .foregroundStyle(Theme.accent)
        }
        .foregroundStyle(.secondary)
        .help(help)
    }

    /// What the note says, and its tooltip, for what the CLI read: the transcripts and the Claude app's list, the
    /// transcripts with the app's list turned off, or (a CLI from before the app's list) the transcripts alone.
    static func note(_ history: HistorySnapshot) -> (String, String) {
        if history.claudeApp != nil {
            return ("From the transcripts on this Mac and the Claude app's session list: titles and stats only. Signalbox never shows prompts, replies or tool output.",
                    "The Claude app's titles win. A session the app lists whose transcript isn't on this Mac shows \"No transcript\" and no figures. Signalbox reads the app's session records read-only (title, folder, dates, ids, model, effort and archived flag; nothing else); turn this off in Settings ▸ Advanced.")
        }
        if let app = history.sources?.claudeApp, !app.enabled {
            let why = switch app.offReason {
            case .flag: "The Claude app's session list is turned off in Settings ▸ Advanced"
            case .claudeConfigDir: "The Claude app's session list is left out because CLAUDE_CONFIG_DIR points away from ~/.claude, and the app's list describes the sessions there"
            case nil: "The CLI didn't read the Claude app's session list (see Health)"
            }
            return ("From the transcripts on this Mac: titles and stats only. Signalbox never shows prompts, replies or tool output.",
                    "\(why), so sessions only the app lists, and the app's own titles, aren't shown.")
        }
        return ("From the transcripts on this Mac: titles and stats only. Signalbox never shows prompts, replies or tool output.",
                "The Claude app keeps its own session list, so it can show sessions whose transcripts were deleted, and titles it never wrote to a transcript. This CLI lists what the transcripts still hold.")
    }

    private var total: some View {
        Text(summary)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize()
            .help(money.footnote().map { "\(Fmt.listPriceNote). \($0)." } ?? Fmt.listPriceNote)
    }

    /// "Project: All", a menu of the projects with their session counts. A long folder name is cut in the middle so
    /// the menu never widens the bar.
    private var projectMenu: some View {
        @Bindable var nav = nav
        let projects = projects(agent: nav.historyFilter.agent)
        let selected = projects.first { $0.path == nav.historyFilter.project }
        let name = selected?.name ?? nav.historyFilter.project.flatMap(Fmt.basename) ?? "All"
        return HStack(spacing: 4) {
            Text("Project")
                .foregroundStyle(.secondary)
            Menu {
                Picker("Project", selection: $nav.historyFilter.project) {
                    Text("All Projects").tag(String?.none)
                    Divider()
                    ForEach(projects) { p in
                        Text("\(p.name)  \(p.count)")
                            .privacySensitive()
                            .tag(String?.some(p.path))
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                Text(HistoryBrowser.middleTruncated(name, max: 26))
                    .privacySensitive(selected != nil || nav.historyFilter.project != nil)
            }
            .menuStyle(.borderlessButton)
            .tint(.primary)
            .fixedSize()
            .help(selected.map { "Showing sessions in \($0.path)" } ?? "Show one project's sessions")
        }
    }

    /// "Show 6 empty sessions" / "Hide empty sessions", when the other filters keep any.
    @ViewBuilder private var emptyToggle: some View {
        if empties > 0 {
            let showing = nav.historyFilter.showEmpty
            Button(showing ? "Hide empty sessions" : empties == 1 ? "Show 1 empty session" : "Show \(empties) empty sessions") {
                nav.historyFilter.showEmpty.toggle()
            }
            .buttonStyle(.link)
            .fixedSize()
            .help("Sessions with no title and no responses: opened and closed with nothing sent")
        }
    }

    /// "Show archived (3)" / "Hide archived", when the other filters keep any session archived in the Claude app.
    @ViewBuilder private var archivedToggle: some View {
        if archived > 0 {
            let showing = nav.historyFilter.showArchived
            Button(showing ? "Hide archived" : "Show archived (\(archived))") {
                nav.historyFilter.showArchived.toggle()
            }
            .buttonStyle(.link)
            .fixedSize()
            .help("Sessions archived in the Claude app, hidden as the app hides them")
        }
    }

    private var rangePicker: some View {
        @Bindable var nav = nav
        return Picker("Range", selection: $nav.historyFilter.range) {
            ForEach(HistoryRange.allCases) { r in
                Text(r.title).tag(r)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .help("Sessions active in the last 7 or 30 calendar days (today included), or all of them")
    }
}

/// All / Claude Code / Codex, each with how many sessions the other filters keep.
private struct HistoryAgentChips: View {
    @Environment(SignalboxStore.self) private var store
    let history: HistorySnapshot
    @Binding var filter: HistoryFilter

    var body: some View {
        // Counts follow the other filters (project, range, search), so a chip says what picking it would show.
        var others = filter
        others.agent = nil
        let kept = HistoryBrowser.filtered(history.entries, filter: others, now: store.now)
        return HStack(spacing: 4) {
            chip(nil, title: "All", count: kept.count)
            ForEach(HistoryBrowser.agents(history.entries), id: \.self) { agent in
                chip(agent, title: Fmt.agentName(agent), count: kept.filter { $0.agent == agent }.count)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent")
    }

    private func chip(_ agent: AgentID?, title: String, count: Int) -> some View {
        let selected = filter.agent == agent
        return Button {
            filter.agent = agent
        } label: {
            HStack(spacing: 5) {
                Text(title)
                    .font(.callout.weight(.semibold))
                Text("\(count)")
                    .font(.caption)
                    .foregroundStyle(selected ? Theme.accent : .secondary)
                    .monospacedDigit()
            }
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(selected ? Theme.accent.opacity(0.16) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(selected ? Theme.accent.opacity(0.55) : .clear, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title), \(count) sessions")
    }
}

/// "Today 5 · $123.45".
private struct HistoryGroupHeader: View {
    @Environment(\.money) private var money
    let group: HistoryDayGroup

    var body: some View {
        HStack(spacing: 6) {
            Text(group.title)
            Text("\(group.entries.count)")
                .foregroundStyle(.tertiary)
                .monospacedDigit()
            Spacer()
            if let cost = HistoryBrowser.totalCost(group.entries) {
                Text(money.amount(cost))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct HistoryRow: View {
    let entry: SessionHistoryEntry
    let kind: HistoryDayGroup.Kind
    let now: Date
    var showAgent: Bool
    var live: HistoryLiveRoute?
    var liveStatus: SessionStatus?
    var onOpenLive: (HistoryLiveRoute) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    title
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(entry.displayTitle ?? "Untitled session")
                    if let live {
                        LivePill(status: liveStatus) { onOpenLive(live) }
                    }
                    if entry.isArchived { ArchivedTag() }
                    if showAgent { AgentBadge(agent: entry.agent) }
                }
                meta
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)

            VStack(alignment: .trailing, spacing: 3) {
                if entry.hasTranscript {
                    CostText(value: entry.costUsd, unpriced: entry.hasUnpriced)
                    Text(HistoryBrowser.durationLabel(entry))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                        .help("How long the session ran, from its first to its last transcript line")
                } else {
                    // In the Claude app's list only: no transcript, so no usage. A dash, never $0.00.
                    Group {
                        Text(HistoryBrowser.costLabel(entry))
                            .foregroundStyle(.tertiary)
                        Text(HistoryBrowser.durationLabel(entry))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .help("In the Claude app's list, but its transcript isn't on this Mac: no usage or resume command")
                }
            }
            .frame(width: 104, alignment: .trailing)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        // The combined row hides the pill's button from VoiceOver; offer its action on the row.
        .accessibilityActions {
            if let live {
                Button("Show in Sessions") { onOpenLive(live) }
            }
        }
    }

    @ViewBuilder private var title: some View {
        if let t = entry.displayTitle {
            Text(t)
                .font(.body.weight(.semibold))
                .privacySensitive()
        } else {
            Text("Untitled session")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    /// "api-refactor · 09:30 · claude-opus-5-5 +1" (a session only in the Claude app's list leaves out a model it
    /// doesn't know). The project folder is the user's own (redacted where macOS asks for that); the rest reads as is.
    private var meta: some View {
        let start = HistoryBrowser.startLabel(entry, in: kind, now: now)
        let rest = [start, HistoryBrowser.modelLabel(entry)].compactMap { $0 }.joined(separator: " · ")
        return HStack(spacing: 0) {
            if let project = entry.projectName {
                Text(project)
                    .privacySensitive()
            } else {
                Text("no project")
                    .foregroundStyle(.tertiary)
            }
            Text(" · \(rest)")
                .layoutPriority(1)
        }
    }
}

/// "Archived" on a session archived in the Claude app.
struct ArchivedTag: View {
    var body: some View {
        Tag(text: "Archived", color: .secondary, systemImage: "archivebox")
            .help("Archived in the Claude app")
            .accessibilityLabel("Archived in the Claude app")
    }
}

/// "● Live" on a row whose session runs now; clicking it opens the session on Sessions.
struct LivePill: View {
    var status: SessionStatus?
    var action: () -> Void

    var body: some View {
        let color = status == .waiting ? Theme.warning : Theme.accent
        Button(action: action) {
            HStack(spacing: 4) {
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                Text(status == .waiting ? "Live · Waiting" : "Live")
            }
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(status.map { "\(Fmt.statusLabel($0)) now. Click to open it in Sessions." } ?? "Running now. Click to open Sessions.")
        .accessibilityLabel(status.map { "Live, \(Fmt.statusLabel($0).lowercased()). Open in Sessions" } ?? "Live. Open Sessions")
    }
}

/// The right-click menu of a history row and the inspector's actions.
struct HistoryActions: View {
    @Environment(NavigationModel.self) private var nav
    @Environment(\.directoryExists) private var directoryExists
    let entry: SessionHistoryEntry
    let live: HistoryLiveRoute?

    var body: some View {
        if let line = HistoryBrowser.resumeLine(entry, directoryExists: directoryExists) {
            Button {
                Clipboard.copy(line)
            } label: {
                Label("Copy Resume Command", systemImage: "doc.on.doc")
            }
        }
        if let live {
            Button {
                nav.open(live)
            } label: {
                Label("Show in Sessions", systemImage: SidebarSection.sessions.systemImage)
            }
        }
        Divider()
        if let project = entry.project {
            Button("Reveal Project in Finder") { Finder.reveal(project) }
                .disabled(!FileManager.default.fileExists(atPath: project))
        }
        if let transcript = entry.transcriptPath {
            Button("Reveal Transcript in Finder") { Finder.reveal(transcript) }
                .disabled(!FileManager.default.fileExists(atPath: transcript))
        }
    }
}

enum Finder {
    /// Opens a Finder window with `path` selected. Signalbox itself never opens or reads the file.
    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}

private struct DirectoryExistsKey: EnvironmentKey {
    static let defaultValue: @Sendable (String) -> Bool = { HistoryBrowser.directoryExists($0) }
}

extension EnvironmentValues {
    /// Whether a session's folder is still on this Mac, for the resume line (no `cd` into a folder that's gone). The
    /// snapshot renderer replaces it, as synthetic fixtures name folders that don't exist here.
    var directoryExists: @Sendable (String) -> Bool {
        get { self[DirectoryExistsKey.self] }
        set { self[DirectoryExistsKey.self] = newValue }
    }
}
