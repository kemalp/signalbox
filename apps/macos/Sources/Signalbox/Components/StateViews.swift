import SignalboxKit
import SwiftUI

/// Shows `content` once data exists; until then, the right empty/missing/restarting state.
struct DataGate<Value, Content: View>: View {
    @Environment(SignalboxStore.self) private var store
    let value: Value?
    let waitingFor: String
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        if let value {
            content(value)
        } else {
            NoDataView(waitingFor: waitingFor)
        }
    }
}

struct NoDataView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    let waitingFor: String

    var body: some View {
        switch store.connection {
        case let .cliMissing(reason):
            ContentUnavailableView {
                Label("Signalbox CLI Not Found", systemImage: "terminal")
            } description: {
                Text(reason)
                    .privacySensitive()
            } actions: {
                Button("Show Diagnostics") { nav.showDiagnostics = true }
            }
        case let .failed(reason, _, _):
            ContentUnavailableView {
                Label("The CLI Couldn't Start", systemImage: "exclamationmark.triangle")
            } description: {
                VStack(spacing: 8) {
                    Text("The CLI \(reason)")
                        .textSelection(.enabled)
                        .lineLimit(6)
                        .privacySensitive()
                    ConnectionSummary()
                }
            } actions: {
                Button("Show Diagnostics") { nav.showDiagnostics = true }
            }
        case let .restarting(_, _, reason):
            ContentUnavailableView {
                Label("Restarting the CLI", systemImage: "arrow.triangle.2.circlepath")
            } description: {
                VStack(spacing: 8) {
                    if let reason {
                        Text("The CLI \(reason)")
                            .textSelection(.enabled)
                            .lineLimit(6)
                            .privacySensitive()
                    }
                    ConnectionSummary()
                }
            } actions: {
                Button("Show Diagnostics") { nav.showDiagnostics = true }
            }
        default:
            VStack(spacing: 10) {
                ProgressView()
                    .controlSize(.regular)
                Text("Waiting for \(waitingFor)…")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// A slim strip above stale data when the CLI isn't live, or when a stream reported an error.
struct ConnectionBanner: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    /// Which stream's errors to surface.
    var scopes: [StreamErrorScope] = []

    var body: some View {
        if let message {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                // The reason can name the CLI's path or quote its stderr.
                Text(message)
                    .lineLimit(2)
                    .help(message)
                    .privacySensitive()
                Spacer()
                Button("Diagnostics") { nav.showDiagnostics = true }
                    .controlSize(.small)
            }
            .font(.callout)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.warning.opacity(0.12))
            .overlay(alignment: .bottom) { Divider() }
        }
    }

    private var message: String? {
        let hasData = store.fleet != nil || store.report != nil
        let age = store.lastUpdated.map { " from \(Fmt.ago($0, now: store.now))" } ?? ""
        switch store.connection {
        case let .restarting(_, _, reason) where hasData:
            let why = reason.map { ": it \($0)" } ?? ""
            return "\(Fmt.sentence("The CLI stopped\(why)")) Showing the last data\(age); restarting automatically."
        case let .failed(reason, _, _) where hasData:
            return "\(Fmt.sentence("The CLI couldn't start: it \(reason)")) Showing the last data\(age); retrying automatically."
        default:
            break
        }
        for scope in scopes {
            if let e = store.streamErrors[scope] { return "\(scope.rawValue.capitalized) update failed: \(e.message)" }
        }
        return nil
    }
}

/// "List-price equivalent, not a bill" with an info symbol.
struct ListPriceNote: View {
    var body: some View {
        Label(Fmt.listPriceNote, systemImage: "info.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .help("Dollar figures price your token usage at the provider's public list prices. Subscriptions and discounts are not reflected.")
    }
}
