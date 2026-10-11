import SignalboxKit
import SwiftUI

struct LimitsView: View {
    @Environment(SignalboxStore.self) private var store

    var body: some View {
        DataGate(value: store.fleet, waitingFor: "plan limits") { _ in
            LiveNow(anchors: store.limits.flatMap { [$0.observedAt, $0.resetsAt] }) { now in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Account-wide. The freshest reading per window wins. A reading older than 15 minutes, or from before its window reset, shows no fill: limits also move with use elsewhere.")
                            .fixedSize(horizontal: false, vertical: true)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 340, maximum: 560), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                            ForEach(store.limitAgents, id: \.self) { agent in
                                LimitCard(agent: agent, now: now)
                            }
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(scopes: [.fleet]) }
        .navigationTitle("Limits")
        .navigationSubtitle("Plan and rate limits")
        .toolbar { CommonToolbar() }
    }
}

private struct LimitCard: View {
    @Environment(SignalboxStore.self) private var store
    let agent: AgentID
    let now: Date

    var body: some View {
        let limits = store.limits(for: agent)
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                if limits.isEmpty {
                    UnknownLimits(agent: agent, hint: store.claudeLimitsHint)
                } else {
                    ForEach(limits) { l in
                        LimitRow(limit: l, state: store.limitState(l, now: now), from: l.sessionId.flatMap { sid in store.sessions.first { $0.sessionId == sid } }, now: now)
                        if l.id != limits.last?.id { Divider() }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack {
                Text(Fmt.agentName(agent))
                    .font(.headline)
                Spacer()
                if let plan = limits.first(where: { $0.plan != nil })?.plan {
                    Tag(text: plan, color: .secondary)
                }
            }
            .padding(.bottom, 2)
        }
    }
}

private struct LimitRow: View {
    let limit: LimitSnapshot
    let state: LimitState
    let from: FleetSession?
    let now: Date

    var body: some View {
        let label = Fmt.limitLabel(limit)
        let window = Fmt.windowLabel(limit.windowMinutes)
        let p = LimitPresentation(limit, state: state, now: now)
        let current = state == .fresh
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.body.weight(.medium))
                    .foregroundStyle(current ? .primary : .secondary)
                if let window, !label.contains(window) {
                    Text(window)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let was = p.lastValueText {
                    Text(was)
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .help("The last reading. It isn't current, so the bar is empty.")
                } else {
                    Text(p.valueText)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                }
            }
            MeterBar(fraction: p.fillFraction, tint: Theme.color(for: p.severity), height: 8, muted: !current)
            HStack(spacing: 6) {
                switch state {
                case .fresh:
                    Text(p.statusText)
                    Text("·").foregroundStyle(.tertiary)
                    Text("as of \(Fmt.ago(limit.observedAt, now: now))")
                case .stale:
                    Tag(text: p.statusText, color: .secondary, systemImage: "clock.badge.questionmark")
                        .help("This reading is old, and limits also move with use elsewhere. Use the agent to get a new one.")
                    Text(Fmt.countdown(limit.resetsAt, now: now))
                case .resetPassed:
                    Tag(text: p.statusText, color: .secondary, systemImage: "arrow.counterclockwise")
                        .help("The window reset after this reading; use the agent to get a new one.")
                    Text("last reading \(Fmt.ago(limit.observedAt, now: now))")
                }
                Spacer(minLength: 0)
                if let from {
                    HStack(spacing: 3) {
                        Text("from")
                        Text(from.title)
                            .truncationMode(.middle)
                            .privacySensitive()
                    }
                    .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label)\(window.map { ", \($0) window" } ?? "")")
        .accessibilityValue(p.accessibilityValue)
    }
}

private struct UnknownLimits: View {
    let agent: AgentID
    let hint: ClaudeLimitsHint

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: "questionmark.circle")
                .foregroundStyle(.secondary)
                .font(.title3)
        }
        .padding(.vertical, 4)
    }

    private var title: String {
        guard agent == .claudeCode else { return "Unknown" }
        switch hint {
        case .noTap: return "Unknown — tap mod not running"
        case .tapWaiting: return "Unknown — waiting for a first reading"
        case .unknown: return "Unknown"
        }
    }

    private var detail: String {
        guard agent == .claudeCode else { return "No limit reading from \(Fmt.agentName(agent)) yet." }
        switch hint {
        case .noTap:
            return "Claude Code reports plan limits only through the signalbox-tap mod, which isn't loaded in any session. See docs/SPIKE.md to load it. Signalbox never calls account endpoints."
        case .tapWaiting:
            return "The signalbox-tap mod is loaded; the first reading arrives with Claude Code's next response. Meanwhile, /usage in a Claude Code session shows your limits."
        case .unknown:
            return "Claude Code limits appear only when the signalbox-tap mod reports them locally (see docs/SPIKE.md). Signalbox never calls account endpoints."
        }
    }
}
