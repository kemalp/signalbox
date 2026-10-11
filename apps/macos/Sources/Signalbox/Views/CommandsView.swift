import SignalboxKit
import SwiftUI

/// The command guide: every built-in slash command and useful shell command of each agent, the user's own
/// commands, and for each one where it works and whether Signalbox shows it, plans to run it, or leaves it to
/// the session. Signalbox runs none of them; rows copy.
struct CommandsView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav

    var body: some View {
        @Bindable var nav = nav
        Group {
            if let data = store.commands {
                CommandGuideList(data: data)
            } else {
                // Only the placeholder needs a clock (waiting → "Update the CLI" after the grace period).
                LiveNow(anchors: [store.connectedAt]) { now in
                    CommandGuidePlaceholder(state: store.commandGuideState(now: now))
                }
            }
        }
        .navigationTitle("Commands")
        .navigationSubtitle(subtitle)
        .searchable(text: $nav.commandFilter.query, placement: .toolbar, prompt: "Search commands")
        .inspector(isPresented: Binding(get: { nav.showCommandInspector && store.commands != nil }, set: { nav.showCommandInspector = $0 })) {
            CommandInspector(row: store.commands.flatMap { CommandGuide.row(id: nav.selectedCommandID, in: $0) })
                .glassPanelColorScheme()
                .inspectorColumnWidth(min: 280, ideal: 330, max: 440)
        }
        .toolbar {
            CommonToolbar()
            ToolbarItem(placement: .primaryAction) {
                Button {
                    nav.showCommandInspector.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help("Show or hide command details")
                .disabled(store.commands == nil)
            }
        }
    }

    private var subtitle: String {
        guard let data = store.commands else { return "" }
        let builtIn = data.catalogs.reduce(0) { $0 + $1.commands.count }
        var parts = ["\(builtIn) built-in commands"]
        if !data.custom.isEmpty { parts.append("\(data.custom.count) of yours") }
        return parts.joined(separator: " · ")
    }
}

/// What the screen says before (or instead of) a guide.
private struct CommandGuidePlaceholder: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    let state: CommandGuideState

    var body: some View {
        switch state {
        case .ready, .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text("Waiting for the command guide…")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .cliTooOld:
            ContentUnavailableView {
                Label("Update the CLI", systemImage: "arrow.down.circle")
            } description: {
                Text("The signalbox CLI\(store.cliVersion.map { " (\($0))" } ?? "") this app is connected to is too old to send the command guide. Rebuild the app with apps/macos/scripts/build-app.sh, which bundles the current CLI, or choose a newer one in Settings ▸ Advanced.")
            } actions: {
                Button("Show Diagnostics") { nav.showDiagnostics = true }
            }
        case .notInSnapshot:
            ContentUnavailableView {
                Label("No Command Guide", systemImage: "command")
            } description: {
                // Non-breaking hyphens keep the option on one line.
                Text("This snapshot has no command guide. Run the app with the CLI, or give it one with \u{2011}\u{2011}fixture\u{2011}commands.")
            }
        case .unavailable:
            NoDataView(waitingFor: "the command guide")
        }
    }
}

private struct CommandGuideList: View {
    @Environment(NavigationModel.self) private var nav
    let data: CommandsData
    /// How many of your commands show before "Show All".
    static let customPreview = 6

    var body: some View {
        @Bindable var nav = nav
        let filter = nav.commandFilter
        let sections = CommandGuide.sections(data, filter: filter)
        List(selection: $nav.selectedCommandID) {
            ForEach(sections) { section in
                Section {
                    // Many skills and plugin commands would push the built-ins far down: show a few until asked.
                    let collapsed = !filter.isSearching && !nav.showAllCustomCommands && section.custom.count > Self.customPreview + 2
                    ForEach(collapsed ? Array(section.custom.prefix(Self.customPreview)) : section.custom) { c in
                        CustomCommandRow(command: c, showAgent: filter.agent == nil)
                            .tag(c.id)
                    }
                    if collapsed || (nav.showAllCustomCommands && !filter.isSearching && section.custom.count > Self.customPreview + 2) {
                        Button(collapsed ? "Show All \(section.custom.count) of Your Commands" : "Show Fewer") {
                            nav.showAllCustomCommands.toggle()
                        }
                        .buttonStyle(.link)
                        .font(.callout)
                        .padding(.vertical, 2)
                    }
                    ForEach(section.commands) { e in
                        CommandRow(entry: e, showAgent: filter.agent == nil) { nav.section = $0 }
                            .tag(e.id)
                    }
                } header: {
                    SectionHeader(section: section)
                }
            }
        }
        .listStyle(.inset)
        .overlay {
            if sections.isEmpty { emptyState(filter) }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ConnectionBanner(scopes: [.commands])
                CommandGuideHeader(data: data)
                AgentInstallNote(data: data, agent: filter.agent)
                Divider()
            }
        }
        // ⌘C (Edit ▸ Copy) copies the selected command, like the inspector's Copy button.
        .onCopyCommand {
            guard let row = CommandGuide.row(id: nav.selectedCommandID, in: data) else { return [] }
            return [NSItemProvider(object: row.copyText as NSString)]
        }
    }

    @ViewBuilder private func emptyState(_ filter: CommandFilter) -> some View {
        if filter.isSearching {
            ContentUnavailableView {
                Label("No Results for “\(filter.query.trimmingCharacters(in: .whitespaces))”", systemImage: "magnifyingglass")
                    .privacySensitive()
            } description: {
                Text(filter.hasFilters ? "No command matches the search with these filters." : "Check the spelling or try another word, such as what the command does.")
            } actions: {
                if filter.hasFilters {
                    Button("Search All Commands") { nav.commandFilter = CommandFilter(query: filter.query) }
                }
            }
        } else {
            ContentUnavailableView {
                Label("No Matching Commands", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("No command fits these filters.")
            } actions: {
                Button("Clear Filters") { nav.commandFilter = CommandFilter() }
            }
        }
    }
}

/// The explainer and the filters, pinned above the list.
private struct CommandGuideHeader: View {
    @Environment(NavigationModel.self) private var nav
    let data: CommandsData

    var body: some View {
        @Bindable var nav = nav
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text("Signalbox doesn't run commands yet. Copy one and run it in the session. Running a few safe ones from here, such as /\u{2060}compact, is planned for Claude Code after testing with the desktop app.")
                    .lineLimit(3)
            } icon: {
                Image(systemName: "info.circle")
                    .foregroundStyle(Theme.accent)
            }
            .font(.callout)
            .foregroundStyle(.secondary)

            // One row when it fits, else the menus under the agents: the header must never widen the column.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    AgentChips(data: data, selection: $nav.commandFilter.agent)
                    Spacer(minLength: 8)
                    filterMenus
                }
                VStack(alignment: .leading, spacing: 8) {
                    AgentChips(data: data, selection: $nav.commandFilter.agent)
                    HStack(spacing: 12) { filterMenus }
                }
            }
            .font(.callout)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .onChange(of: nav.commandFilter.agent) { _, agent in
            // A category the newly picked agent doesn't have would leave the list empty.
            if let c = nav.commandFilter.category, !CommandGuide.categories(data, agent: agent).contains(c) {
                nav.commandFilter.category = nil
            }
        }
    }

    /// The category and "Can Signalbox run it" pickers, each with a short label.
    @ViewBuilder private var filterMenus: some View {
        @Bindable var nav = nav
        HStack(spacing: 4) {
            Text("Category")
                .foregroundStyle(.secondary)
            Picker("Category", selection: $nav.commandFilter.category) {
                Text("All").tag(CommandCategory?.none)
                Divider()
                ForEach(CommandGuide.categories(data, agent: nav.commandFilter.agent), id: \.self) { c in
                    Text(c.title).tag(CommandCategory?.some(c))
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
            .help("Show one category of commands")
        }
        HStack(spacing: 4) {
            Text("Signalbox")
                .foregroundStyle(.secondary)
            Picker("Can Signalbox run it?", selection: $nav.commandFilter.run) {
                ForEach(CommandRunFilter.allCases) { f in
                    Text(f.title).tag(f)
                    if f == .any { Divider() }
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
            .help("Can Signalbox run it? Filter by what Signalbox does with each command.")
        }
    }
}

/// All / Claude Code / Codex / Gemini, each with its installed version or "not installed".
private struct AgentChips: View {
    let data: CommandsData
    @Binding var selection: AgentID?

    var body: some View {
        HStack(spacing: 4) {
            chip(nil, title: "All", caption: "\(data.catalogs.count) agents")
            ForEach(data.agents, id: \.self) { agent in
                chip(agent, title: Fmt.agentName(agent), caption: caption(agent))
                    .help(help(agent))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent")
    }

    private func chip(_ agent: AgentID?, title: String, caption: String) -> some View {
        let selected = selection == agent
        return Button {
            selection = agent
        } label: {
            VStack(spacing: 0) {
                Text(title)
                    .font(.callout.weight(.semibold))
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(selected ? Theme.accent : .secondary)
                    .monospacedDigit()
            }
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .frame(minWidth: 52)
            .background(selected ? Theme.accent.opacity(0.16) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(selected ? Theme.accent.opacity(0.55) : .clear, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title), \(caption)")
    }

    private func caption(_ agent: AgentID) -> String {
        data.installedVersion(agent) ?? "not installed"
    }

    private func help(_ agent: AgentID) -> String {
        let name = Fmt.agentName(agent)
        switch CommandGuide.versionNote(catalog: data.catalog(for: agent), installed: data.installedVersion(agent)) {
        case let .matches(v): return "\(name) \(v) is installed; the guide was checked against this version."
        case let .differs(installed, checked): return "\(name) \(installed) is installed; the guide was checked against \(checked)."
        case let .unchecked(installed): return "\(name) \(installed) is installed."
        case .notInstalled:
            return "\(name) isn't installed on this Mac." + (data.catalog(for: agent)?.verifiedVersion.map { " The guide was checked against \($0)." } ?? "")
        }
    }
}

/// Under the filters when one agent is picked and it isn't installed, or differs from the checked version.
private struct AgentInstallNote: View {
    let data: CommandsData
    let agent: AgentID?

    var body: some View {
        if let agent, let text = text(agent) {
            Label(text, systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
        }
    }

    private func text(_ agent: AgentID) -> String? {
        let name = data.catalog(for: agent)?.displayName ?? Fmt.agentName(agent)
        switch CommandGuide.versionNote(catalog: data.catalog(for: agent), installed: data.installedVersion(agent)) {
        case .matches, .unchecked: return nil
        case let .differs(installed, checked):
            return "You have \(name) \(installed); this list was checked against \(checked). Most commands carry over between releases; /help in the session lists exactly what yours has."
        case .notInstalled:
            let checked = data.catalog(for: agent)?.verifiedVersion.map { " This list was checked against \(name) \($0)." } ?? ""
            return "\(name) isn't installed on this Mac.\(checked)"
        }
    }
}

private struct SectionHeader: View {
    let section: CommandGuideSection

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .imageScale(.small)
            Text(section.title)
            Text("\(section.count)")
                .foregroundStyle(.tertiary)
                .monospacedDigit()
            if case .custom = section.kind {
                Spacer()
                Text("Names and descriptions only")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var symbol: String {
        switch section.kind {
        case .custom: return "person.crop.square"
        case .shell: return "apple.terminal"
        case let .category(c):
            switch c {
            case .session: return "rectangle.stack"
            case .context: return "text.badge.minus"
            case .model: return "cpu"
            case .info: return "info.circle"
            case .config: return "gearshape"
            case .account: return "person.circle"
            case .tools: return "wrench.and.screwdriver"
            case .navigation: return "arrow.triangle.turn.up.right.diamond"
            case .integrations: return "puzzlepiece.extension"
            case .debug: return "ladybug"
            default: return "square.grid.2x2"
            }
        }
    }
}

struct CommandRow: View {
    let entry: CommandEntry
    var showAgent: Bool
    var onOpen: (SidebarSection) -> Void

    var body: some View {
        let c = entry.command
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(c.name)
                        .font(.body.monospaced().weight(.semibold))
                        .lineLimit(1)
                        .layoutPriority(3)
                    if let args = c.args, !args.isEmpty {
                        Text(args)
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                    }
                    if !c.allAliases.isEmpty {
                        Text("also \(c.allAliases.joined(separator: ", "))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    if showAgent { AgentBadge(agent: entry.agent).layoutPriority(2) }
                    Spacer(minLength: 6)
                    SurfaceTags(surfaces: c.surfaces)
                        .fixedSize()
                        .layoutPriority(2)
                }
                Text(c.summary.isEmpty ? "No summary" : c.summary)
                    .font(.callout)
                    .foregroundStyle(c.summary.isEmpty ? .tertiary : .secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RunStatusBadge(availability: c.signalbox, onOpen: onOpen)
                .frame(width: 150, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct CustomCommandRow: View {
    let command: CustomCommand
    var showAgent: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    name
                        .font(.body.monospaced().weight(.semibold))
                        .lineLimit(1)
                        // Entries of one plugin share a long lead; the end is what tells them apart.
                        .truncationMode(.middle)
                        .layoutPriority(2)
                        .help(command.name)
                        .privacySensitive()
                    Tag(text: command.kindTitle, color: command.isLegacyPrompt ? Theme.warning : .secondary)
                    ScopeTag(command: command)
                    if showAgent { AgentBadge(agent: command.agent) }
                }
                Text(command.shortDescription ?? "No description")
                    .font(.callout)
                    .foregroundStyle(command.shortDescription == nil ? .tertiary : .secondary)
                    .lineLimit(2)
                    .privacySensitive(command.shortDescription != nil)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if command.isLegacyPrompt {
                    LegacyPromptBadge()
                } else {
                    RunStatusBadge(availability: CommandAvailability(status: .no))
                }
            }
            .frame(width: 150, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// The whole name, with a plugin's "<plugin>:" lead dimmed (the scope tag names the plugin too).
    private var name: Text {
        let parts = command.nameParts
        guard !parts.lead.isEmpty else { return Text(command.name) }
        return Text("\(Text(parts.lead).foregroundStyle(.secondary))\(Text(parts.rest))")
    }
}

/// In place of "Run it in the session" on a Codex legacy prompt, which recent Codex CLI releases don't load.
struct LegacyPromptBadge: View {
    var body: some View {
        Tag(text: "Not loaded by Codex CLI", color: .secondary, systemImage: "slash.circle")
            .help("Recent Codex CLI releases no longer load custom prompts. To keep using this one, turn it into a skill.")
    }
}
