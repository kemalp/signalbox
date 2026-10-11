import AppKit
import SignalboxKit
import SwiftUI

struct SessionInspector: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(\.money) private var money
    let session: FleetSession?

    var body: some View {
        if let s = session {
            LiveNow(anchors: [s.statusSince, s.startedAt, s.lastActivity, s.context?.observedAt]) { now in
                Form {
                    Section {
                        header(s, now: now)
                    }
                    let suggestions = SessionSuggestions.suggest(for: s, commands: store.commands, now: now)
                    if !suggestions.isEmpty {
                        Section {
                            ForEach(suggestions) { SuggestionRow(suggestion: $0) }
                        } header: {
                            Text("Suggested")
                        } footer: {
                            if suggestions.contains(where: { $0.command != nil }) {
                                Text(suggestionsFooter(s))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if s.status != .ended {
                        Section {
                            Toggle(isOn: Binding(get: { !settings.isMuted(s.id) }, set: { settings.setMuted(!$0, sessionID: s.id, now: store.now) })) {
                                Label("Notify me about this session", systemImage: settings.isMuted(s.id) ? "bell.slash" : "bell")
                            }
                            .help("Waiting and long-task notifications for this session. A mute lasts until the session ends.")
                        } footer: {
                            if settings.isMuted(s.id) {
                                Text("Muted until this session ends.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section("Activity") {
                        LabeledContent("Status") {
                            StatusPill(status: s.status, since: s.statusSince, now: now)
                        }
                        if let waiting = s.waitingLabel { row("Waiting for", waiting) }
                        row("Status since", Fmt.clock(s.statusSince, now: now))
                        row("Started", s.startedAt.map { "\(Fmt.clock($0, now: now)) · \(Fmt.ago($0, now: now))" })
                        row("Last activity", s.lastActivity.map { Fmt.ago($0, now: now) })
                    }
                    Section("Model") {
                        row("Model", s.model, mono: true)
                        row("Effort", s.effort)
                        LabeledContent("Cost") {
                            VStack(alignment: .trailing, spacing: 2) {
                                CostText(value: s.costUsd, unpriced: (s.unpricedTokens ?? 0) > 0)
                                Text(money.isConverted ? "list-price equivalent, converted at your rate" : "list-price equivalent, not a bill")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .help(money.footnote() ?? "")
                            }
                        }
                        if let unpriced = s.unpricedTokens, unpriced > 0 {
                            row("Unpriced tokens", Fmt.tokens(unpriced))
                        }
                    }
                    Section("Context window") {
                        ContextGauge(context: s.context, style: .detail)
                            .padding(.vertical, 2)
                        if let c = s.context {
                            row("Tokens", Fmt.tokens(c.tokens))
                            row("Window", c.window.map { Fmt.tokens($0) } ?? "unknown")
                            if let src = Fmt.windowSourceLabel(c.windowSource) { row("Window size", src) }
                            if let ac = c.autoCompactAtPercent {
                                row("Auto-compact at", "\(Fmt.percent(ac, digits: 1))\(c.window.map { " · \(Fmt.tokens($0 * ac / 100))" } ?? "")")
                            }
                            row("Measured", Fmt.ago(c.observedAt, now: now))
                            row("Context source", c.source)
                        }
                    }
                    Section("Where") {
                        LabeledContent("Directory") {
                            VStack(alignment: .trailing, spacing: 4) {
                                Text(s.cwd.map { Fmt.shortPath($0) } ?? Fmt.dash)
                                    .textSelection(.enabled)
                                    .help(s.cwd ?? "")
                                    .privacySensitive()
                                if let cwd = s.cwd {
                                    Button("Reveal in Finder") { reveal(cwd) }
                                        .controlSize(.small)
                                        .disabled(!FileManager.default.fileExists(atPath: cwd))
                                }
                            }
                        }
                        row("Entrypoint", s.entrypoint)
                        row("Kind", s.kind)
                        row("Version", s.version.map { "v\($0)" })
                        row("PID", s.pid.map(String.init))
                    }
                    Section("Source") {
                        row("Agent", Fmt.agentName(s.agent))
                        row("Reported by", s.source)
                        LabeledContent("Session ID") {
                            Text(s.sessionId)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                                .privacySensitive()
                        }
                    }
                    let compactions = store.compactions.filter { $0.sessionId == s.sessionId && $0.agent == s.agent }
                    if !compactions.isEmpty {
                        Section("Compactions") {
                            ForEach(compactions, id: \.ts) { c in
                                LabeledContent(c.trigger == .manual ? "Manual" : c.trigger == .auto ? "Automatic" : "Compaction") {
                                    Text([Fmt.ago(c.ts, now: now), c.preTokens.map { "from \(Fmt.tokens($0))" }].compactMap { $0 }.joined(separator: " · "))
                                        .monospacedDigit()
                                }
                            }
                        }
                    }
                }
                .formStyle(.grouped)
            }
        } else {
            ContentUnavailableView("No Session Selected", systemImage: "sidebar.trailing", description: Text("Select a session to see everything Signalbox knows about it."))
        }
    }

    private func suggestionsFooter(_ s: FleetSession) -> String {
        let catalog = store.commands?.catalog(for: s.agent)
        let checked = catalog?.verifiedVersion.map { " (checked on \(catalog?.displayName ?? Fmt.agentName(s.agent)) \($0))" } ?? ""
        return "From the command guide\(checked). Signalbox doesn't run commands yet: copy one and run it in the session."
    }

    private func header(_ s: FleetSession, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(s.title)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .privacySensitive()
            HStack(spacing: 6) {
                AgentBadge(agent: s.agent)
                if let model = s.model {
                    Text(model)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?, mono: Bool = false) -> some View {
        LabeledContent(label) {
            Text(value ?? Fmt.dash)
                .font(mono ? .callout.monospaced() : .callout)
                .foregroundStyle(value == nil ? .tertiary : .primary)
                .textSelection(.enabled)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
    }

    private func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}

/// One suggestion: why, what it does, and the command with a Copy button (none for "answer it in the session").
private struct SuggestionRow: View {
    let suggestion: SessionSuggestion

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label {
                Text(suggestion.reason)
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: symbol)
                    .foregroundStyle(color)
            }
            Text(suggestion.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let command = suggestion.command {
                HStack(spacing: 8) {
                    Text(command)
                        .font(.callout.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                    Spacer(minLength: 4)
                    CopyButton(text: command)
                        .controlSize(.small)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            if let planned = suggestion.plannedNote {
                Text(planned)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
    }

    private var symbol: String {
        switch suggestion.kind {
        case .answer: "hand.raised.fill"
        case .compact: "arrow.down.right.and.arrow.up.left"
        case .clear: "sparkles"
        }
    }

    private var color: Color {
        switch suggestion.kind {
        case .answer: Theme.warning
        case .compact: Theme.warning
        case .clear: Theme.accent
        }
    }
}
