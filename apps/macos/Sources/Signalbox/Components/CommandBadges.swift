import AppKit
import SignalboxKit
import SwiftUI

/// Copies text to the general pasteboard.
@MainActor
enum Clipboard {
    static func copy(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }
}

/// A Copy button that says "Copied" for a moment after a click.
struct CopyButton: View {
    let text: String
    var title = "Copy"
    var compact = false
    @State private var copied = false

    var body: some View {
        Button {
            Clipboard.copy(text)
            copied = true
        } label: {
            Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc")
                .contentTransition(.symbolEffect(.replace))
                .labelStyle(compact ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
        }
        .help("Copy \(text) to the clipboard")
        .accessibilityLabel(copied ? "Copied \(text)" : "Copy \(text)")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// A type-erased label style, so one button can switch between icon-only and title-and-icon.
struct AnyLabelStyle: LabelStyle {
    private let make: (Configuration) -> AnyView

    init(_ style: some LabelStyle) {
        make = { AnyView(style.makeBody(configuration: $0)) }
    }

    func makeBody(configuration: Configuration) -> some View {
        make(configuration)
    }
}

/// Where a command works, as small text tags: only the surfaces where it works (amber with a half-circle where
/// it works in part). The inspector lists every surface, including the ones where it doesn't.
struct SurfaceTags: View {
    let surfaces: CommandSurfaces

    var body: some View {
        HStack(spacing: 4) {
            ForEach(surfaces.orderedKeys.filter { surfaces[$0].isAvailable }, id: \.self) { key in
                let partial = surfaces[key] == .partial
                Tag(text: CommandSurfaces.shortTitle(key), color: partial ? Theme.warning : Theme.accent,
                    systemImage: partial ? "circle.lefthalf.filled" : nil)
                    .help(partial ? "Works in part: \(CommandSurfaces.title(key))" : "Works: \(CommandSurfaces.title(key))")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let works = surfaces.orderedKeys.filter { surfaces[$0] == .yes }.map(CommandSurfaces.title)
        let partly = surfaces.orderedKeys.filter { surfaces[$0] == .partial }.map(CommandSurfaces.title)
        var parts: [String] = []
        if !works.isEmpty { parts.append("Works in \(works.joined(separator: ", "))") }
        if !partly.isEmpty { parts.append("partly in \(partly.joined(separator: ", "))") }
        return parts.isEmpty ? "Where it works is unknown" : parts.joined(separator: "; ")
    }
}

/// One surface's support in words, for the inspector.
struct SurfaceValue: View {
    let support: SurfaceSupport

    var body: some View {
        Label(text, systemImage: symbol)
            .foregroundStyle(color)
            .font(.callout)
    }

    private var text: String {
        switch support {
        case .yes: "Works"
        case .partial: "In part"
        case .no: "No"
        case .unknown: "Unknown"
        }
    }

    private var symbol: String {
        switch support {
        case .yes: "checkmark.circle.fill"
        case .partial: "circle.lefthalf.filled"
        case .no: "xmark.circle"
        case .unknown: "questionmark.circle"
        }
    }

    private var color: Color {
        switch support {
        case .yes: Theme.accent
        case .partial: Theme.warning
        case .no, .unknown: .secondary
        }
    }
}

/// What Signalbox does with a command. "Shown in Sessions" is a link to that screen.
struct RunStatusBadge: View {
    let availability: CommandAvailability
    var onOpen: ((SidebarSection) -> Void)?

    var body: some View {
        let section = SidebarSection(catalogView: availability.view)
        if availability.status == .view, let section, let onOpen {
            Button {
                onOpen(section)
            } label: {
                tag(section: section)
            }
            .buttonStyle(.plain)
            .help("Signalbox shows this on \(section.title). Click to open it.")
        } else {
            tag(section: section)
                .help(Self.help(availability.status))
        }
    }

    private func tag(section: SidebarSection?) -> some View {
        Tag(text: Self.title(availability.status, section: section), color: Self.color(availability.status), systemImage: Self.symbol(availability.status, link: section != nil && onOpen != nil))
    }

    static func title(_ status: CommandRunStatus, section: SidebarSection?) -> String {
        switch status {
        case .view: section.map { "Shown in \($0.title)" } ?? "Shown in Signalbox"
        case .planned: "Planned"
        case .no: "Run it in the session"
        case .never: "Not offered"
        default: "Unknown"
        }
    }

    static func help(_ status: CommandRunStatus) -> String {
        switch status {
        case .view: "Signalbox already shows this information."
        case .planned: "Signalbox may run this from the app later, through an opt-in mod. It doesn't yet: copy it and run it in the session."
        case .no: "Signalbox doesn't run this. Copy it and run it in the session."
        case .never: "Deliberately not offered by Signalbox: it's destructive, sensitive, or the session owner's call."
        default: "The catalog gives a status this version of Signalbox doesn't know."
        }
    }

    static func color(_ status: CommandRunStatus) -> Color {
        switch status {
        case .view: Theme.ok
        case .planned: .blue
        case .never: Theme.critical
        default: .secondary
        }
    }

    static func symbol(_ status: CommandRunStatus, link: Bool) -> String {
        switch status {
        case .view: link ? "arrow.right.circle.fill" : "eye"
        case .planned: "clock"
        case .no: "terminal"
        case .never: "nosign"
        default: "questionmark.circle"
        }
    }
}

/// "User", "Project · storefront", "Plugin · acme-dev".
struct ScopeTag: View {
    let command: CustomCommand

    var body: some View {
        Tag(text: text, color: color, systemImage: symbol)
            .help(help)
            // "Project · <folder>" and "Plugin · <name>" name the user's own; "User" doesn't.
            .privacySensitive(command.scope == .project || command.scope == .plugin)
    }

    private var text: String {
        switch command.scope {
        case .project: Fmt.basename(command.project).map { "Project · \($0)" } ?? "Project"
        case .plugin: command.source.map { "Plugin · \($0)" } ?? "Plugin"
        default: command.scope.title
        }
    }

    private var symbol: String {
        switch command.scope {
        case .user: "person"
        case .project: "folder"
        case .plugin: "puzzlepiece.extension"
        default: "questionmark.circle"
        }
    }

    private var color: Color {
        switch command.scope {
        case .project: .purple
        case .plugin: .blue
        default: .secondary
        }
    }

    private var help: String {
        switch command.scope {
        case .user: "Yours, available in every project"
        case .project: command.project.map { "Only in \($0)" } ?? "Only in one project"
        case .plugin: "From a plugin"
        default: command.scope.title
        }
    }
}
