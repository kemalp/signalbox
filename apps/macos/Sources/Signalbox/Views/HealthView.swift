import SignalboxKit
import SwiftUI

struct HealthView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav

    var body: some View {
        DataGate(value: store.health ?? store.fleet?.health, waitingFor: "adapter health") { health in
            LiveNow(anchors: [store.healthUpdatedAt]) { now in
                List {
                    Section {
                        if health.isEmpty {
                            Text("No data sources reported.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(health.sorted(by: Self.order)) { h in
                            HealthRow(health: h)
                        }
                    } header: {
                        sectionHeader("Data sources", trailing: store.healthUpdatedAt.map { "checked \(Fmt.ago($0, now: now))" })
                    } footer: {
                        Text("Stability says how likely a source is to break when the agent updates: documented formats are supported, preview interfaces may change, internal files can change without notice.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 2)
                    }

                    Section {
                        if let tables = store.report?.priceTables, !tables.isEmpty {
                            ForEach(tables) { t in
                                PriceTableRow(table: t)
                            }
                        } else {
                            Text(store.report == nil ? "Waiting for the first report…" : "No price tables reported.")
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        sectionHeader("Price tables", trailing: nil)
                    }

                    Section {
                        CLIInfo()
                    } header: {
                        sectionHeader("Signalbox CLI", trailing: nil)
                    }
                }
                .listStyle(.inset)
            }
        }
        .navigationTitle("Health")
        .navigationSubtitle(subtitle)
        .toolbar {
            CommonToolbar()
            ToolbarItem(placement: .primaryAction) {
                Button {
                    nav.showDiagnostics = true
                } label: {
                    Label("Diagnostics", systemImage: "doc.text.magnifyingglass")
                }
                .help("CLI output and connection details")
            }
        }
    }

    private var subtitle: String {
        guard let h = store.health ?? store.fleet?.health else { return "" }
        let bad = h.filter { !$0.ok }.count
        return bad == 0 ? "All \(h.count) sources OK" : "\(bad) of \(h.count) sources need attention"
    }

    private func sectionHeader(_ title: String, trailing: String?) -> some View {
        HStack {
            Text(title)
            Spacer()
            if let trailing {
                Text(trailing)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    /// By agent, then name; the Claude app's rows (its session list, read for Claude Code's history) follow
    /// Claude Code's.
    static func order(_ a: AdapterHealth, _ b: AdapterHealth) -> Bool {
        func key(_ h: AdapterHealth) -> (AgentID, Bool) {
            guard let agent = h.agent else { return ("zzz", false) }
            return agent == "claude-app" ? (.claudeCode, true) : (agent, false)
        }
        let (aa, appA) = key(a), (ab, appB) = key(b)
        if aa != ab { return aa < ab }
        if appA != appB { return !appA }
        return a.name < b.name
    }
}

private struct HealthRow: View {
    let health: AdapterHealth

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: health.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(health.ok ? Theme.ok : Theme.warning)
                .font(.title3)
                .accessibilityLabel(health.ok ? "OK" : "Needs attention")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(health.sourceName)
                        .font(.body.weight(.semibold))
                    if let agent = health.agent { AgentBadge(agent: agent) }
                }
                Text(health.detail.isEmpty ? Fmt.dash : health.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    // A detail that names a folder (the Claude app's session list) carries the user's home path.
                    .privacySensitive(health.detail.contains("/"))
            }
            Spacer()
            StabilityBadge(stability: health.stability)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct PriceTableRow: View {
    let table: PriceTableInfo

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "tag.fill")
                .foregroundStyle(.secondary)
                .font(.title3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Fmt.providerName(table.provider))
                    .font(.body.weight(.semibold))
                Text("Prices as of \(asOf)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let s = table.sourceUrl, let url = URL(string: s) {
                Link(destination: url) {
                    Label("Source", systemImage: "arrow.up.right.square")
                }
                .help(s)
            }
        }
        .padding(.vertical, 4)
    }

    private var asOf: String { Fmt.priceDate(table.asOf) }
}

private struct CLIInfo: View {
    @Environment(SignalboxStore.self) private var store

    var body: some View {
        Group {
            LabeledContent("Version", value: store.cliVersion ?? Fmt.dash)
            LabeledContent("Protocol", value: store.cliProtocolVersion.map { "v\($0)" } ?? Fmt.dash)
            LabeledContent("Status") { ConnectionSummary() }
            if let cmd = store.cliCommand {
                LabeledContent("Command") {
                    Text(cmd)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
