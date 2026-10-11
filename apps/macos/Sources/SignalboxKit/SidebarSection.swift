import Foundation

/// The main window's screens, in sidebar order; ⌘1…⌘6 follow it. scripts/click-probe.sh clicks every case.
public enum SidebarSection: String, Hashable, CaseIterable, Identifiable, Sendable {
    case sessions, history, commands, usage, limits, health

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .sessions: "Sessions"
        case .history: "History"
        case .commands: "Commands"
        case .usage: "Usage"
        case .limits: "Limits"
        case .health: "Health"
        }
    }

    public var systemImage: String {
        switch self {
        case .sessions: "rectangle.stack"
        case .history: "clock.arrow.circlepath"
        case .commands: "command"
        case .usage: "chart.bar.xaxis"
        case .limits: "gauge.with.dots.needle.67percent"
        case .health: "stethoscope"
        }
    }

    /// The digit for ⌘1…⌘6: the section's place in the sidebar.
    public var shortcutKey: Character {
        let i = Self.allCases.firstIndex(of: self) ?? 0
        return Character(String(i + 1))
    }

    /// The screen a command catalog's `signalbox.view` names ("sessions", "usage", …); nil for anything else.
    public init?(catalogView: String?) {
        guard let catalogView, let s = SidebarSection(rawValue: catalogView), s != .commands else { return nil }
        self = s
    }
}
