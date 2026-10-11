import AppKit
import SignalboxKit
import SwiftUI

struct DiagnosticsView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(AppController.self) private var controller
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Diagnostics")
                    .font(.title2.weight(.semibold))
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
                    info("Connection") { ConnectionSummary() }
                    info("CLI") { mono(cliText).privacySensitive() }
                    info("Version") { mono([store.cliVersion, store.cliProtocolVersion.map { "protocol v\($0)" }].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? Fmt.dash) }
                    info("PID") { mono(store.cliPID.map(String.init) ?? Fmt.dash) }
                    info("Last exit") { mono(store.lastExit ?? Fmt.dash) }
                    info("PATH") { mono((controller.childPATH ?? Fmt.dash) + pathNote).privacySensitive() }
                }
            }
            .padding(20)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if store.diagnostics.isEmpty {
                            Text("No CLI output yet.")
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 8)
                        }
                        ForEach(store.diagnostics.elements) { line in
                            DiagnosticLineView(line: line)
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .onAppear { proxy.scrollTo(store.diagnostics.last?.id, anchor: .bottom) }
                .onChange(of: store.diagnostics.last?.id) { _, id in
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }

            Divider()

            HStack {
                Text("CLI stderr and app events; the last \(store.diagnostics.capacity) lines are kept. No message content is ever logged.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Copy All") { copyAll() }
                Button("Clear") { store.clearDiagnostics() }
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(14)
        }
        .frame(minWidth: 720, idealWidth: 780, minHeight: 480, idealHeight: 560)
    }

    private var pathNote: String {
        guard controller.childPATH != nil else { return "" }
        let shell = controller.loginShell ?? "login shell"
        return controller.loginPATHResolved ? "  (from your \(shell) login shell, plus defaults)" : "  (\(shell) login shell PATH not resolved; using defaults)"
    }

    private var cliText: String {
        if let cmd = store.cliCommand { return cmd }
        switch controller.cliLocation {
        case let .found(launch): return launch.displayCommand
        case let .missing(reason): return reason
        case nil: return controller.isFixture ? "Not used (showing a snapshot)" : "Locating…"
        }
    }

    private func info(_ label: String, @ViewBuilder _ value: () -> some View) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.trailing)
            value()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func mono(_ s: String) -> some View {
        Text(s)
            .font(.callout.monospaced())
            .textSelection(.enabled)
            .lineLimit(3)
            .truncationMode(.middle)
    }

    private func copyAll() {
        let f = Date.ISO8601FormatStyle()
        let text = store.diagnostics.elements.map { "\(f.format($0.date)) [\($0.kind)] \($0.text)" }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

private struct DiagnosticLineView: View {
    let line: DiagnosticLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(line.date.formatted(date: .omitted, time: .standard))
                .foregroundStyle(.tertiary)
            // CLI stderr and app events can name paths.
            Text(line.text)
                .foregroundStyle(color)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .privacySensitive()
        }
        .font(.caption.monospaced())
    }

    private var color: Color {
        switch line.kind {
        case .stderr: .primary
        case .event: .secondary
        case .warning: Theme.warning
        }
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
