import SignalboxKit
import SwiftUI

/// "Waiting · 4m" in a tinted capsule.
struct StatusPill: View {
    let status: SessionStatus
    var since: Date?
    var now: Date

    private var duration: String? {
        since.map { Fmt.duration(now.timeIntervalSince($0)) }
    }

    var body: some View {
        let color = Theme.color(for: status)
        HStack(spacing: 4) {
            Image(systemName: Theme.symbol(for: status))
                .imageScale(.small)
            Text(Fmt.statusLabel(status))
            if let duration {
                Text(duration)
                    .monospacedDigit()
                    .opacity(0.8)
            }
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(duration.map { "\(Fmt.statusLabel(status)) for \($0)" } ?? Fmt.statusLabel(status))
    }
}

/// The agent as a text badge (no vendor logos).
struct AgentBadge: View {
    let agent: AgentID
    var prominent = false

    var body: some View {
        Text(Fmt.agentName(agent))
            .font(prominent ? .callout.weight(.semibold) : .caption2.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, prominent ? 8 : 6)
            .padding(.vertical, prominent ? 3 : 2)
            .foregroundStyle(.secondary)
            .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .accessibilityLabel("Agent: \(Fmt.agentName(agent))")
    }
}

/// A small tinted text tag: "unpriced", "stale", "preview", …
struct Tag: View {
    let text: String
    var color: Color = .secondary
    var systemImage: String?

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(color)
        .background(color.opacity(0.13), in: Capsule())
    }
}

struct StabilityBadge: View {
    let stability: Stability

    var body: some View {
        Tag(text: stability.rawValue, color: Theme.color(for: stability))
            .help(help)
            .accessibilityLabel("Stability: \(stability.rawValue). \(help)")
    }

    private var help: String {
        switch stability {
        case .documented: "A documented, supported format."
        case .preview: "A preview interface; it may change between releases."
        case .internal: "An internal file format; it can change without notice."
        case .unknown: "Stability not reported."
        }
    }
}

/// A connection dot plus a one-line description; used in the sidebar footer and the menu bar popover.
struct ConnectionSummary: View {
    @Environment(SignalboxStore.self) private var store
    var compact = false

    var body: some View {
        LiveNow(anchors: [store.fleetUpdatedAt ?? store.lastUpdated, retryAt]) { now in
            HStack(spacing: 6) {
                Circle()
                    .fill(Theme.color(for: store.connection))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(text(now: now))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .monospacedDigit()
            }
            .font(compact ? .caption : .callout)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        }
    }

    /// When the next restart attempt is due, for the countdown.
    private var retryAt: Date? {
        switch store.connection {
        case let .restarting(_, retryAt, _): retryAt
        case let .failed(_, _, retryAt): retryAt
        default: nil
        }
    }

    private func text(now: Date) -> String {
        let updated = store.fleetUpdatedAt ?? store.lastUpdated
        switch store.connection {
        case .connected:
            return updated.map { "Live · updated \(Fmt.ago($0, now: now))" } ?? "Live"
        case .idle, .starting:
            return "Starting…"
        case let .restarting(attempt, retryAt, _):
            let wait = max(0, retryAt.timeIntervalSince(now))
            return wait > 0.5 ? "Restarting in \(Fmt.duration(wait.rounded(.up))) · try \(attempt)" : "Restarting · try \(attempt)"
        case .cliMissing:
            return "CLI not found"
        case let .failed(_, attempt, retryAt):
            let wait = max(0, (retryAt ?? now).timeIntervalSince(now))
            return wait > 0.5 ? "CLI couldn't start · retry in \(Fmt.duration(wait.rounded(.up)))" : "CLI couldn't start · try \(attempt)"
        case let .fixture(name):
            return "Snapshot · \(name)"
        }
    }
}
