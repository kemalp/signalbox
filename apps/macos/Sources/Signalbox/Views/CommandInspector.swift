import AppKit
import SignalboxKit
import SwiftUI

/// The selected command: what it does, its side effects, where it works, what Signalbox does with it, and how
/// the entry was checked. Copy puts the command on the clipboard.
struct CommandInspector: View {
    let row: GuideRow?

    var body: some View {
        switch row {
        case let .builtIn(entry):
            BuiltInCommandDetail(entry: entry)
        case let .custom(command):
            CustomCommandDetail(command: command)
        case nil:
            ContentUnavailableView("No Command Selected", systemImage: "command",
                                   description: Text("Select a command to see what it does, where it works and whether Signalbox shows it."))
        }
    }
}

private struct BuiltInCommandDetail: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    let entry: CommandEntry

    var body: some View {
        let c = entry.command
        let catalog = store.commands?.catalog(for: entry.agent)
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(CommandGuide.usage(c))
                        .font(.title3.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        AgentBadge(agent: entry.agent)
                        Tag(text: c.category.title, color: .secondary)
                        if entry.kind == .shell { Tag(text: "Shell", color: .secondary, systemImage: "apple.terminal") }
                    }
                    if !c.summary.isEmpty {
                        Text(c.summary)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    CopyButton(text: CommandGuide.copyText(c), title: "Copy \(entry.kind == .shell ? "Command" : CommandGuide.copyText(c))")
                        .controlSize(.regular)
                        .padding(.top, 2)
                }
                .padding(.vertical, 2)
            }
            if let details = c.details, !details.isEmpty {
                Section("What it does") {
                    Text(details)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let effects = c.sideEffects, !effects.isEmpty {
                Section("Side effects") {
                    Label {
                        Text(effects)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .font(.callout)
                    .foregroundStyle(Theme.warning)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            Section("Where it works") {
                ForEach(c.surfaces.orderedKeys, id: \.self) { key in
                    LabeledContent(CommandSurfaces.title(key)) {
                        SurfaceValue(support: c.surfaces[key])
                    }
                }
            }
            Section("Signalbox") {
                LabeledContent("Status") {
                    RunStatusBadge(availability: c.signalbox, onOpen: { nav.section = $0 })
                }
                if let note = c.signalbox.note, !note.isEmpty {
                    Text(note)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if c.signalbox.status == .view, let section = SidebarSection(catalogView: c.signalbox.view) {
                    Button("Open \(section.title)") { nav.section = section }
                }
            }
            if !c.allAliases.isEmpty {
                Section("Also typed as") {
                    Text(c.allAliases.joined(separator: "  "))
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                }
            }
            Section("Checked") {
                if let how = c.verified?.methodLabel { row("How", how) }
                row("Checked on", c.verified?.version ?? catalog?.verifiedVersion)
                row("Installed", store.commands?.installedVersion(entry.agent) ?? "not installed")
                if case let .differs(installed, checked) = CommandGuide.versionNote(catalog: catalog, installed: store.commands?.installedVersion(entry.agent)) {
                    Text("You have \(installed); this entry was checked against \(checked). It may have changed since.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let asOf = catalog?.asOf { row("Guide written", Fmt.priceDate(asOf)) }
                if let s = c.sourceUrl, let url = URL(string: s), url.scheme == "https" {
                    LabeledContent("Source") {
                        Link(destination: url) {
                            Label(url.host ?? "Open", systemImage: "arrow.up.right.square")
                        }
                        .help(s)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func row(_ label: String, _ value: String?) -> some View {
        LabeledContent(label) {
            Text(value ?? Fmt.dash)
                .font(.callout)
                .foregroundStyle(value == nil ? .tertiary : .primary)
                .textSelection(.enabled)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct CustomCommandDetail: View {
    let command: CustomCommand

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(command.name)
                        .font(.title3.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                        .privacySensitive()
                    HStack(spacing: 6) {
                        AgentBadge(agent: command.agent)
                        Tag(text: command.kindTitle, color: command.isLegacyPrompt ? Theme.warning : .secondary)
                        ScopeTag(command: command)
                    }
                    Text(command.shortDescription ?? "No description")
                        .font(.callout)
                        .foregroundStyle(command.shortDescription == nil ? .tertiary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .privacySensitive(command.shortDescription != nil)
                    // The button's title names the command.
                    CopyButton(text: CommandGuide.copyText(command), title: "Copy \(CommandGuide.copyText(command))")
                        .padding(.top, 2)
                        .privacySensitive()
                }
                .padding(.vertical, 2)
            }
            Section("Where it comes from") {
                LabeledContent("Scope", value: command.scope.title)
                if let project = command.project {
                    LabeledContent("Project") {
                        Text(Fmt.shortPath(project))
                            .help(project)
                            .textSelection(.enabled)
                            .privacySensitive()
                    }
                }
                if let source = command.source {
                    LabeledContent(command.scope == .plugin ? "Plugin" : "File") {
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(source)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                                .privacySensitive()
                            if let url = fileURL(source) {
                                Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            }
            Section("Signalbox") {
                if command.isLegacyPrompt {
                    Label("Codex has deprecated custom prompts in favour of skills, and recent Codex CLI releases don't load them, so typing it there does nothing. Signalbox lists it because the file is still there; to keep using it, turn it into a skill.", systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(Theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(command.isLegacyPrompt
                    ? "Signalbox lists your own commands by name and description only. It never reads their contents or runs them."
                    : "Signalbox lists your own commands by name and description only. It never reads their contents or runs them: copy one and run it in the session.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
    }

    /// The command's file on disk, when the source is a path that exists (never opened, only revealed).
    private func fileURL(_ source: String) -> URL? {
        guard command.scope != .plugin else { return nil }
        let expanded = (source as NSString).expandingTildeInPath
        let path: String
        if expanded.hasPrefix("/") {
            path = expanded
        } else if let project = command.project {
            path = (project as NSString).appendingPathComponent(expanded)
        } else {
            return nil
        }
        return FileManager.default.fileExists(atPath: path) ? URL(fileURLWithPath: path) : nil
    }
}
