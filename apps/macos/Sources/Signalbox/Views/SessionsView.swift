import SignalboxKit
import SwiftUI

struct SessionsView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money

    var body: some View {
        @Bindable var nav = nav
        DataGate(value: store.fleet, waitingFor: "sessions") { fleet in
            if fleet.sessions.isEmpty {
                ContentUnavailableView {
                    Label("No Sessions", systemImage: "rectangle.stack")
                } description: {
                    Text("No Claude Code, Codex or Gemini sessions are running or were seen recently.")
                }
            } else {
                SessionList()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ConnectionBanner(scopes: [.fleet, .protocol])
                NotificationOptInBanner()
            }
        }
        .navigationTitle("Sessions")
        .navigationSubtitle(subtitle)
        // No sessions, nothing to inspect: the empty state gets the whole width.
        .inspector(isPresented: Binding(get: { nav.showInspector && !store.sessions.isEmpty }, set: { nav.showInspector = $0 })) {
            SessionInspector(session: store.session(id: nav.selectedSessionID))
                .glassPanelColorScheme()
                .inspectorColumnWidth(min: 280, ideal: 320, max: 420)
        }
        .toolbar {
            CommonToolbar()
            ToolbarItem(placement: .primaryAction) {
                Button {
                    nav.showInspector.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help("Show or hide session details")
                .disabled(store.sessions.isEmpty)
            }
        }
    }

    private var subtitle: String {
        guard store.fleet != nil else { return "" }
        // Every row's cost is converted; say so where it can be seen, as Usage does.
        return Fmt.sessionCounts([.waiting: store.count(.waiting), .busy: store.count(.busy), .idle: store.count(.idle), .ended: store.count(.ended)],
                                 convertedTo: money.isConverted ? money.currency.code : nil)
    }
}

private struct SessionList: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var nav = nav
        List(selection: $nav.selectedSessionID) {
                let waiting = store.waitingSessions
                if !waiting.isEmpty {
                    Section {
                        ForEach(waiting) { s in
                            LiveSessionRow(session: s, showAgent: true, muted: settings.isMuted(s.id))
                                .tag(s.id)
                        }
                    } header: {
                        Label("Needs you", systemImage: "hand.raised.fill")
                            .foregroundStyle(Theme.warning)
                    }
                }
                ForEach(store.activeSessionsByAgent, id: \.agent) { group in
                    Section {
                        ForEach(group.sessions) { s in
                            LiveSessionRow(session: s, showAgent: false, muted: settings.isMuted(s.id))
                                .tag(s.id)
                        }
                    } header: {
                        HStack {
                            Text(Fmt.agentName(group.agent))
                            Text("\(group.sessions.count)")
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                let ended = store.endedSessions
                if !ended.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: $nav.showEnded) {
                            ForEach(ended) { s in
                                LiveSessionRow(session: s, showAgent: true, muted: settings.isMuted(s.id))
                                    .tag(s.id)
                            }
                        } label: {
                            Text("Ended · \(ended.count)")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .listStyle(.inset)
            .contextMenu(forSelectionType: FleetSession.ID.self) { ids in
                let live = ids.compactMap { store.session(id: $0) }.filter { $0.status != .ended }
                if !live.isEmpty {
                    let allMuted = live.allSatisfy { settings.isMuted($0.id) }
                    Button {
                        for s in live { settings.setMuted(!allMuted, sessionID: s.id, now: store.now) }
                    } label: {
                        Label(allMuted ? "Unmute Notifications" : "Mute Notifications", systemImage: allMuted ? "bell" : "bell.slash")
                    }
                }
            }
    }
}

/// A session row with its own clock: it redraws every second only while its status change or last activity
/// is under a minute old, so a list of quiet sessions doesn't redraw every second.
private struct LiveSessionRow: View {
    let session: FleetSession
    var showAgent: Bool
    var muted: Bool

    var body: some View {
        LiveNow(anchors: [session.statusSince, session.lastActivity]) { now in
            SessionRow(session: session, now: now, showAgent: showAgent, muted: muted)
        }
    }
}

struct SessionRow: View {
    let session: FleetSession
    let now: Date
    var showAgent: Bool
    var muted = false

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            StatusPill(status: session.status, since: session.statusSince, now: now)
                .help(session.waitingLabel.map { "Waiting for: \($0)" } ?? "")
                .frame(width: 124, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(session.title)
                        .privacySensitive()
                    if showAgent { AgentBadge(agent: session.agent) }
                    if muted {
                        Image(systemName: "bell.slash.fill")
                            .imageScale(.small)
                            .foregroundStyle(.secondary)
                            .help("Notifications muted for this session")
                            .accessibilityLabel("Notifications muted")
                    }
                }
                // The model reads as is; the project folder is the user's own (redacted where macOS asks for that).
                HStack(spacing: 0) {
                    Text(model)
                        .layoutPriority(1)
                    if let project {
                        Text(" — ")
                        Text(project)
                            .privacySensitive()
                    }
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)

            ContextGauge(context: session.context)
                .frame(width: 168)

            VStack(alignment: .trailing, spacing: 3) {
                CostText(value: session.costUsd, unpriced: (session.unpricedTokens ?? 0) > 0)
                Text(session.lastActivity.map { "active \(Fmt.ago($0, now: now))" } ?? "activity unknown")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .frame(width: 104, alignment: .trailing)
        }
        .padding(.vertical, 6)
        .opacity(session.status == .ended ? 0.7 : 1)
        .accessibilityElement(children: .combine)
    }

    private var model: String {
        [session.model ?? "model unknown", session.effort].compactMap { $0 }.joined(separator: " · ")
    }

    /// The folder after the model when the title is the session's name (otherwise the title already is the folder).
    private var project: String? {
        session.name != nil ? Fmt.basename(session.cwd) : nil
    }
}

/// A session's list-price-equivalent cost in the display currency, or "cost unknown".
struct CostText: View {
    @Environment(\.money) private var money
    let value: Double?
    var unpriced = false

    var body: some View {
        HStack(spacing: 4) {
            if unpriced {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .imageScale(.small)
                    .help("Some tokens are on models with no price row and count as zero")
            }
            Text(value == nil ? "cost unknown" : money.amount(value))
                .font(value == nil ? .caption : .body.monospacedDigit())
                .foregroundStyle(value == nil ? .secondary : .primary)
        }
        .lineLimit(1)
        .help(money.footnote().map { "\(Fmt.listPriceNote). \($0)." } ?? Fmt.listPriceNote)
        .accessibilityLabel(value == nil ? "Cost unknown" : accessibilityText)
    }

    private var accessibilityText: String {
        let base = "\(money.amount(value)), \(Fmt.listPriceNote.lowercased())"
        return money.footnote().map { "\(base). \($0)" } ?? base
    }
}

/// "Get notified when a session needs you": shown on Sessions until notifications are allowed or the user says
/// not now. Permission is only ever asked from here and from Settings, never on launch.
struct NotificationOptInBanner: View {
    @Environment(AppController.self) private var controller
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        if controller.notifier.authorization == .notDetermined, settings.notifyWaiting, !settings.notificationBannerDismissed {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge.fill")
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Get notified when a session needs you")
                        .font(.callout.weight(.semibold))
                    Text("Signalbox can tell you when a session is waiting for input or a long task finishes.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Not Now") { settings.notificationBannerDismissed = true }
                    .controlSize(.small)
                Button("Turn On") {
                    Task { await controller.notifier.requestAuthorization() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Theme.accent.opacity(0.09))
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityElement(children: .contain)
        }
    }
}
