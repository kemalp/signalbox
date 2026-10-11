import SignalboxKit
import SwiftUI

struct ContentView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(SettingsStore.self) private var settings
    @Environment(AppController.self) private var controller
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var nav = nav
        NavigationSplitView {
            SidebarView()
                .glassPanelColorScheme()
                .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 280)
        } detail: {
            detail
        }
        .tint(Theme.accent)
        .environment(\.money, settings.money)
        .sheet(isPresented: $nav.showDiagnostics) {
            DiagnosticsView()
        }
        .onAppear {
            nav.mainWindowIsKey = activeState == .key
            controller.openMainWindowAction = { openWindow(id: WindowID.main) }
        }
        .onChange(of: activeState) { _, state in nav.mainWindowIsKey = state == .key }
        .onDisappear { nav.mainWindowIsKey = false }
    }

    @ViewBuilder private var detail: some View {
        switch nav.section ?? .sessions {
        case .sessions: SessionsView()
        case .history: HistoryView()
        case .commands: CommandsView()
        case .usage: UsageView()
        case .limits: LimitsView()
        case .health: HealthView()
        }
    }
}

struct SidebarView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav

    var body: some View {
        @Bindable var nav = nav
        List(selection: $nav.section) {
            Section("Signalbox") {
                ForEach(SidebarSection.allCases) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .badge(badge(for: section))
                        .tag(section)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button {
                nav.showDiagnostics = true
            } label: {
                ConnectionSummary(compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .help("Connection to the signalbox CLI. Click for Diagnostics.")
        }
    }

    private func badge(for section: SidebarSection) -> Int {
        switch section {
        case .sessions: store.count(.waiting)
        case .health: (store.health ?? []).filter { !$0.ok }.count
        default: 0
        }
    }
}

/// Toolbar buttons every screen shares.
struct CommonToolbar: ToolbarContent {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav

    var body: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                store.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(!store.canSendCommands)
            .help("Ask the CLI for fresh sessions and usage now (⌘R)")
        }
    }
}
