import AppKit
import SignalboxKit
import SwiftUI

/// System colors only, so light/dark and accessibility contrast settings just work.
enum Theme {
    static let accent = Color.teal
    /// Amber for "needs attention" and warnings.
    static let warning = Color.orange
    static let critical = Color.red
    static let ok = Color.green

    /// Chart series colours by `SeriesSlots` slot, light and dark variants of the web dashboard's validated
    /// palette (apps/web/src/styles.css), with its teal accent first. Neighbours differ in hue and lightness.
    private static let seriesPalette: [Color] = [
        dynamic(light: 0x14958A, dark: 0x2CB3A4), // teal
        dynamic(light: 0x2A78D6, dark: 0x3987E5), // blue
        dynamic(light: 0xEB6834, dark: 0xD95926), // orange
        dynamic(light: 0x4A3AA7, dark: 0x9085E9), // violet
        dynamic(light: 0xE87BA4, dark: 0xD55181), // pink
        dynamic(light: 0xEDA100, dark: 0xC98500), // amber
        dynamic(light: 0x008300, dark: 0x3F9F3F), // green
    ]
    /// "Other" (models past the palette).
    static let seriesOther = dynamic(light: 0x9AA4B1, dark: 0x5D6978)

    static func series(_ slot: Int?) -> Color {
        guard let slot, seriesPalette.indices.contains(slot) else { return seriesOther }
        return seriesPalette[slot]
    }

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        func ns(_ hex: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark) : ns(light)
        })
    }

    static func color(for status: SessionStatus) -> Color {
        switch status {
        case .busy: accent
        case .waiting: warning
        case .idle: Color.secondary
        case .ended, .unknown: Color.gray
        }
    }

    static func symbol(for status: SessionStatus) -> String {
        switch status {
        case .busy: "bolt.fill"
        case .waiting: "hand.raised.fill"
        case .idle: "moon.zzz.fill"
        case .ended: "stop.circle"
        case .unknown: "questionmark.circle"
        }
    }

    static func color(for severity: Fmt.Severity) -> Color {
        switch severity {
        case .ok: accent
        case .warn: warning
        case .crit: critical
        }
    }

    static func color(for stability: Stability) -> Color {
        switch stability {
        case .documented: ok
        case .preview: Color.blue
        case .internal: warning
        case .unknown: Color.gray
        }
    }

    static func color(for connection: ConnectionState) -> Color {
        switch connection {
        case .connected: ok
        case .starting, .idle: Color.secondary
        case .restarting: warning
        case .cliMissing, .failed: critical
        case .fixture: Color.blue
        }
    }
}

/// The current time for views with relative times: the wall clock, or the store's pinned time (fixtures).
/// By default it ticks every second only while one of `anchors` (the times the view shows) is under a minute
/// away, and every 30 s otherwise (`RefreshCadence`); a fixed `interval` overrides that.
struct LiveNow<Content: View>: View {
    @Environment(SignalboxStore.self) private var store
    var interval: TimeInterval?
    var anchors: [Date] = []
    @ViewBuilder var content: (Date) -> Content

    init(interval: TimeInterval? = nil, anchors: [Date?] = [], @ViewBuilder content: @escaping (Date) -> Content) {
        self.interval = interval
        self.anchors = anchors.compactMap { $0 }
        self.content = content
    }

    var body: some View {
        if let pinned = store.pinnedNow {
            content(pinned)
        } else if let interval {
            TimelineView(.periodic(from: .now, by: interval)) { context in
                content(context.date)
            }
        } else {
            TimelineView(RelativeTimeSchedule(anchors: anchors)) { context in
                content(context.date)
            }
        }
    }
}

/// Ticks every second while an anchor is within a minute of the tick, else every 30 s.
struct RelativeTimeSchedule: TimelineSchedule {
    let anchors: [Date]

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(upcoming: startDate, anchors: anchors, lowFrequency: mode == .lowFrequency)
    }

    struct Entries: Sequence, IteratorProtocol {
        var upcoming: Date
        let anchors: [Date]
        let lowFrequency: Bool

        mutating func next() -> Date? {
            let current = upcoming
            let step = lowFrequency ? RefreshCadence.slow : RefreshCadence.interval(now: current, anchors: anchors)
            upcoming = current.addingTimeInterval(step)
            return current
        }
    }
}

// MARK: - Snapshot rendering support

private struct PinnedColorSchemeKey: EnvironmentKey {
    static let defaultValue: ColorScheme? = nil
}

extension EnvironmentValues {
    /// Set only by the snapshot renderer. Offscreen, glass panels can't see what's behind them and
    /// pick the wrong scheme for their content; this pins it to the window's.
    var pinnedColorScheme: ColorScheme? {
        get { self[PinnedColorSchemeKey.self] }
        set { self[PinnedColorSchemeKey.self] = newValue }
    }
}

private struct PinnedColorScheme: ViewModifier {
    @Environment(\.pinnedColorScheme) private var pinned

    func body(content: Content) -> some View {
        if let pinned {
            // An explicit style instead of glass's default vibrant one, which offscreen capture can't draw.
            content
                .foregroundStyle(.primary)
                .environment(\.colorScheme, pinned)
        } else {
            content
        }
    }
}

extension View {
    /// Applies the renderer's pinned color scheme inside a glass panel (no-op in the running app).
    func glassPanelColorScheme() -> some View {
        modifier(PinnedColorScheme())
    }
}

// MARK: - Money

private struct MoneyKey: EnvironmentKey {
    static let defaultValue = Money.usd
}

extension EnvironmentValues {
    /// The currency formatter from Settings ▸ Display. Every money figure in a view goes through it.
    var money: Money {
        get { self[MoneyKey.self] }
        set { self[MoneyKey.self] = newValue }
    }
}
