import AppKit
import SignalboxKit
import SwiftUI

extension SidebarSection {
    var shortcut: KeyEquivalent { KeyEquivalent(shortcutKey) }
}

enum SettingsTab: String, CaseIterable, Identifiable {
    case general, notifications, display, advanced

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .notifications: "Notifications"
        case .display: "Display"
        case .advanced: "Advanced"
        }
    }

    /// The pane's height in the Settings window; taller content scrolls.
    var paneHeight: CGFloat {
        switch self {
        case .general: 430
        case .notifications: 640
        case .display: 430
        case .advanced: 560
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .notifications: "bell.badge"
        case .display: "textformat.size"
        case .advanced: "wrench.and.screwdriver"
        }
    }
}

enum UsageGrouping: String, CaseIterable, Identifiable {
    case agent, model, kind, project

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent: "By agent"
        case .model: "By model"
        case .kind: "By kind"
        case .project: "By project"
        }
    }
}

/// Window-level UI state shared by the main window and the menu bar popover.
@MainActor
@Observable
final class NavigationModel {
    var section: SidebarSection? = .sessions
    var selectedSessionID: FleetSession.ID?
    var showInspector = true
    var showDiagnostics = false
    var showEnded = false
    var usageGrouping: UsageGrouping = .agent
    var chartBreakdown: ChartBreakdown = .model
    /// Commands screen: the selected row (`CommandEntry.id` or `CustomCommand.id`), the filters and the inspector.
    var selectedCommandID: String?
    var commandFilter = CommandFilter()
    var showCommandInspector = true
    /// "Your commands" shows a few rows until this is on (always all while searching).
    var showAllCustomCommands = false
    /// History screen: the selected entry (`SessionHistoryEntry.id`), the filters and search, and the inspector.
    var selectedHistoryID: SessionHistoryEntry.ID?
    var historyFilter = HistoryFilter()
    var showHistoryInspector = true
    /// True while the main window is the key window (for "quiet when viewing").
    var mainWindowIsKey = false

    /// What notifications see as "on screen": the selected session, when the Sessions screen shows.
    var viewing: ViewingState {
        ViewingState(mainWindowKey: mainWindowIsKey, visibleSessionID: (section ?? .sessions) == .sessions ? selectedSessionID : nil)
    }

    func show(session id: FleetSession.ID) {
        section = .sessions
        selectedSessionID = id
        showInspector = true
    }

    /// A history row's Live pill: Sessions, with the session selected when the fleet has it.
    func open(_ route: HistoryLiveRoute) {
        if let id = route.sessionID {
            show(session: id)
        } else {
            section = route.section
        }
    }
}

struct SignalboxCommands: Commands {
    let controller: AppController

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            AboutMenuItem()
        }
        CommandGroup(after: .toolbar) {
            Button("Refresh") { controller.store.refresh() }
                .keyboardShortcut("r")
                .disabled(!controller.store.canSendCommands)
            Divider()
            ForEach(SidebarSection.allCases) { section in
                Button(section.title) { controller.navigation.section = section }
                    .keyboardShortcut(section.shortcut)
            }
            Divider()
        }
        CommandGroup(replacing: .help) {
            Button("Signalbox Diagnostics") { controller.navigation.showDiagnostics = true }
                .keyboardShortcut("d", modifiers: [.command, .option])
        }
    }
}

/// "About Signalbox" in the app menu: opens the About window (a View, so it can use `openWindow`).
struct AboutMenuItem: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("About Signalbox") {
            NSApp.activate()
            openWindow(id: WindowID.about)
        }
    }
}
