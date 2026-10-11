import AppKit
import SignalboxKit
import SwiftUI

/// The menu bar item: a gauge symbol, plus what Settings ▸ General picks (the highest fresh 5-hour % by default,
/// the weekly %, today's spend, or nothing). While the CLI is down it shows a disconnected symbol and no figure,
/// since the last reading can't be trusted to be current.
struct MenuBarLabel: View {
    let store: SignalboxStore
    let controller: AppController
    let settings: SettingsStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Re-render once a minute (and on new data) so a reading that goes stale drops out. A TimelineView
        // here makes SwiftUI update the status item in a tight loop at launch, so the label observes the
        // controller's minute tick instead and reads the wall clock itself.
        _ = controller.minuteTick
        return label(now: store.pinnedNow ?? Date())
            .onAppear {
                // Notification clicks open the window through this when the window itself was never shown.
                if controller.openMainWindowAction == nil {
                    controller.openMainWindowAction = { openWindow(id: WindowID.main) }
                }
            }
    }

    private func label(now: Date) -> some View {
        let state = Self.state(store.connection)
        let figure = state == .live ? Self.figure(mode: settings.menuBarLabel, store: store, money: settings.money, now: now) : nil
        return HStack(spacing: 3) {
            Image(systemName: symbol(state: state, pct: figure?.percent))
            if let figure {
                Text(figure.text)
                    .monospacedDigit()
            }
        }
        .accessibilityLabel(accessibilityText(state: state, figure: figure))
    }

    struct Figure: Equatable {
        let text: String
        /// Set for the percentage modes; drives the gauge symbol.
        let percent: Double?
        let spoken: String
    }

    static func figure(mode: MenuBarLabelMode, store: SignalboxStore, money: Money, now: Date) -> Figure? {
        switch mode {
        case .iconOnly:
            return nil
        case .fiveHour:
            return store.highestFiveHourPercent(now: now).map { Figure(text: Fmt.percent($0), percent: $0, spoken: "5-hour limit \(Fmt.percent($0)) used") }
        case .weekly:
            return store.highestWeeklyPercent(now: now).map { Figure(text: Fmt.percent($0), percent: $0, spoken: "weekly limit \(Fmt.percent($0)) used") }
        case .todaySpend:
            return store.todaySpendUSD(now: now).map { Figure(text: money.headline($0), percent: nil, spoken: "\(money.amount($0)) recorded today") }
        }
    }

    enum LabelState { case live, waiting, down }

    static func state(_ connection: ConnectionState) -> LabelState {
        switch connection {
        case .connected, .fixture: .live
        case .idle, .starting: .waiting
        case .restarting, .failed, .cliMissing: .down
        }
    }

    private func symbol(state: LabelState, pct: Double?) -> String {
        switch state {
        case .down: return "antenna.radiowaves.left.and.right.slash"
        case .waiting: return "gauge.with.dots.needle.bottom.50percent"
        case .live: break
        }
        if store.count(.waiting) > 0 { return "gauge.with.needle.fill" }
        guard let pct else { return "gauge.with.dots.needle.bottom.50percent" }
        switch pct {
        case ..<34: return "gauge.with.dots.needle.33percent"
        case ..<67: return "gauge.with.dots.needle.50percent"
        default: return "gauge.with.dots.needle.67percent"
        }
    }

    private func accessibilityText(state: LabelState, figure: Figure?) -> String {
        switch state {
        case .down: return "Signalbox, not connected to the CLI"
        case .waiting: return "Signalbox, starting"
        case .live: return figure.map { "Signalbox, \($0.spoken)" } ?? "Signalbox"
        }
    }
}

/// The popover behind the menu bar item.
struct MenuBarContent: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(SettingsStore.self) private var settings
    @Environment(AppController.self) private var controller
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        content
            .environment(\.money, settings.money)
            .onAppear { controller.openMainWindowAction = { openWindow(id: WindowID.main) } }
    }

    private var content: some View {
        LiveNow(anchors: store.waitingSessions.map(\.statusSince) + store.limits.map(\.observedAt)) { now in
            VStack(alignment: .leading, spacing: 12) {
                header
                if let problem = connectionProblem {
                    // The reason can name the CLI's path or quote its stderr.
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .help(problem)
                        .privacySensitive()
                }
                Divider()
                limitRings(now: now)
                Divider()
                statusCounts
                waiting(now: now)
                Divider()
                spend
                Divider()
                actions
            }
            .padding(14)
            .frame(width: 360)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Signalbox")
                .font(.headline)
            Spacer()
            ConnectionSummary(compact: true)
        }
    }

    /// Why the CLI is down, shown under the header (the numbers below are the last ones it sent).
    private var connectionProblem: String? {
        switch store.connection {
        case let .restarting(_, _, reason): Fmt.sentence("The CLI stopped\(reason.map { ": it \($0)" } ?? "")") + " Showing the last data."
        case let .failed(reason, _, _): Fmt.sentence("The CLI couldn't start: it \(reason)")
        case let .cliMissing(reason): reason
        default: nil
        }
    }

    // MARK: Limits

    @ViewBuilder
    private func limitRings(now: Date) -> some View {
        let agents = store.limitAgents
        VStack(alignment: .leading, spacing: 10) {
            ForEach(agents, id: \.self) { agent in
                let picked = store.menuBarLimits(for: agent, now: now)
                // Rings line up by their centres, so a ring with a "stale" line under it doesn't shift the row.
                HStack(alignment: .ringCenter, spacing: 12) {
                    Text(Fmt.agentName(agent))
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(width: 92, alignment: .leading)
                    if picked.shown.isEmpty {
                        Text(unknownLimitsText(agent))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else {
                        let captionWidth = Self.captionWidth(rings: picked.shown.count, more: picked.hidden > 0)
                        ForEach(picked.shown) { l in
                            LimitRing(limit: l, state: store.limitState(l, now: now), now: now, captionWidth: captionWidth)
                        }
                        if picked.hidden > 0 {
                            Button("+\(picked.hidden)") { openMain(section: .limits) }
                                .buttonStyle(.borderless)
                                .font(.callout.weight(.medium))
                                .help("\(picked.hidden) more \(picked.hidden == 1 ? "window" : "windows") for \(Fmt.agentName(agent)): open Limits")
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    /// The widest a ring caption may be: up to 76 pt ("gpt-reserve" needs about 60), less when the row
    /// has to fit four rings beside the 92 pt agent name in the 332 pt the popover has inside its padding.
    static func captionWidth(rings: Int, more: Bool) -> CGFloat {
        guard rings > 0 else { return 76 }
        let spacing: CGFloat = 12
        let available = 332 - 92 - spacing - (more ? 28 + spacing : 0) - CGFloat(rings - 1) * spacing
        return max(46, min(76, (available / CGFloat(rings)).rounded(.down)))
    }

    private func unknownLimitsText(_ agent: AgentID) -> String {
        guard agent == .claudeCode else { return "No reading yet" }
        switch store.claudeLimitsHint {
        case .noTap: return "Limits unknown — tap mod not running"
        case .tapWaiting: return "Limits unknown — waiting for a first reading"
        case .unknown: return "Limits unknown"
        }
    }

    // MARK: Sessions

    private var statusCounts: some View {
        HStack(spacing: 8) {
            countChip(.waiting)
            countChip(.busy)
            countChip(.idle)
            Spacer()
        }
    }

    private func countChip(_ status: SessionStatus) -> some View {
        let n = store.count(status)
        let color = Theme.color(for: status)
        return HStack(spacing: 4) {
            Image(systemName: Theme.symbol(for: status))
                .imageScale(.small)
            Text("\(n) \(Fmt.statusLabel(status).lowercased())")
                .monospacedDigit()
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(n > 0 ? color : .secondary)
        .background((n > 0 ? color : Color.secondary).opacity(0.13), in: Capsule())
        .accessibilityLabel("\(n) \(Fmt.statusLabel(status).lowercased())")
    }

    @ViewBuilder
    private func waiting(now: Date) -> some View {
        let waiting = store.waitingSessions
        if store.fleet == nil {
            Text("No session data yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if waiting.isEmpty {
            Label("Nothing is waiting for you.", systemImage: "checkmark.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("Needs you")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                ForEach(waiting.prefix(Self.waitingRows)) { s in
                    Button {
                        open(session: s.id)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "hand.raised.fill")
                                .foregroundStyle(Theme.warning)
                                .imageScale(.small)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.title)
                                    .lineLimit(1)
                                    .privacySensitive()
                                Text([Fmt.agentName(s.agent), s.waitingLabel ?? s.model].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Text(s.statusSince.map { Fmt.duration(now.timeIntervalSince($0)) } ?? "")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .padding(.horizontal, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(MenuRowButtonStyle())
                    .help("Open \(s.title) in Signalbox")
                }
                if waiting.count > Self.waitingRows {
                    Button {
                        openMain(section: .sessions)
                    } label: {
                        Text("\(waiting.count - Self.waitingRows) more waiting…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 3)
                            .padding(.horizontal, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(MenuRowButtonStyle())
                    .help("Show every session in Signalbox")
                }
            }
        }
    }

    /// Waiting sessions listed in the popover; the rest are behind "N more waiting…".
    static let waitingRows = 4

    // MARK: Spend

    private var spend: some View {
        // Reuse the store's report; never request a window just for the menu bar.
        let report = store.report
        let days = store.reportDays
        let value = report.map { $0.estimate?.recordedUsd ?? $0.totals.cost.total }
        let span = report?.daySpan()
        let perDay = report.map { UsageChartData.build(report: $0, breakdown: .tokenType).days } ?? []
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(days.map { Fmt.rangeTitle(days: $0, span: span) } ?? "Spend")
                        .font(.callout.weight(.medium))
                        .help(days == 1 ? "Since local midnight" : "Calendar days, today included")
                    Text(settings.money.isConverted ? "Recorded · list-price equivalent · converted at your rate" : "Recorded · list-price equivalent, not a bill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(settings.money.footnote() ?? "")
                }
                Spacer()
                Text(settings.money.amount(value))
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            if perDay.count > 1 {
                SpendSparkline(days: perDay)
                    .frame(height: 30)
                    .help("Spend per day, \(span.map { Fmt.daySpan($0) } ?? "")")
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        HStack(spacing: 8) {
            Button {
                openMain()
            } label: {
                Label("Open Signalbox", systemImage: "macwindow")
            }
            .keyboardShortcut("o")
            Button {
                store.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .labelStyle(.iconOnly)
            .help("Refresh now (⌘R)")
            .keyboardShortcut("r")
            .disabled(!store.canSendCommands)
            Spacer()
            Button {
                openSettings()
                NSApp.activate()
            } label: {
                Label("Settings…", systemImage: "gearshape")
            }
            .labelStyle(.iconOnly)
            .keyboardShortcut(",")
            .help("Signalbox Settings (⌘,)")
            Button("Quit") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .controlSize(.regular)
    }

    private func open(session id: FleetSession.ID) {
        nav.show(session: id)
        openMain()
    }

    private func openMain(section: SidebarSection? = nil) {
        if let section { nav.section = section }
        openWindow(id: WindowID.main)
        NSApp.activate()
    }
}

/// One limit as a small capacity ring with its window underneath. Only a fresh reading fills the ring; a stale or
/// reset-passed one is an empty grey ring with "—" and says which underneath.
private struct LimitRing: View {
    let limit: LimitSnapshot
    let state: LimitState
    let now: Date
    var captionWidth: CGFloat = 76

    var body: some View {
        let p = LimitPresentation(limit, state: state, now: now)
        let current = state == .fresh
        VStack(spacing: 2) {
            Gauge(value: (p.fillFraction ?? 0) * 100, in: 0...100) {
                EmptyView()
            } currentValueLabel: {
                Text(p.valueText)
                    .monospacedDigit()
                    .foregroundStyle(current ? .primary : .secondary)
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(current ? Theme.color(for: p.severity) : Color.gray.opacity(0.4))
            .scaleEffect(0.8)
            .frame(width: 46, height: 46)
            .alignmentGuide(.ringCenter) { d in d[VerticalAlignment.center] }
            // As wide as the caption needs, up to `captionWidth` (wider than the ring, so a model name like
            // "gpt-reserve" fits); longer ones shrink a little, then truncate in the middle.
            Text(Fmt.limitShortLabel(limit))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .truncationMode(.middle)
                .frame(maxWidth: captionWidth)
                .fixedSize(horizontal: true, vertical: false)
            if let status = p.shortStatus {
                Text(status)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: captionWidth)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .help(help(p))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Fmt.limitLabel(limit))
        .accessibilityValue(p.accessibilityValue)
    }

    private func help(_ p: LimitPresentation) -> String {
        switch state {
        case .fresh: "\(Fmt.limitLabel(limit)): \(p.valueText) used, \(p.statusText)"
        case .stale, .resetPassed: "\(Fmt.limitLabel(limit)): \(p.statusText), \(p.lastValueText ?? "")"
        }
    }
}

extension VerticalAlignment {
    private enum RingCenter: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
    }

    /// The centre of a limit ring, whatever is stacked under it.
    static let ringCenter = VerticalAlignment(RingCenter.self)
}

private struct MenuRowButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.12 : hovering ? 0.06 : 0))
            )
            .onHover { hovering = $0 }
    }
}
