import Foundation

/// How often a view with relative times ("active 12s ago", "busy · 4m", "resets in 2h") needs to redraw.
/// Seconds only show while a time is under a minute away, so redrawing every second is needed only then;
/// otherwise every 30 s keeps minute figures at most half a minute behind, at a thirtieth of the cost.
public enum RefreshCadence {
    public static let fast: TimeInterval = 1
    public static let slow: TimeInterval = 30
    /// A time within this distance of now (past or future) is shown in seconds.
    public static let secondsWindow: TimeInterval = 60

    /// The interval until the next redraw at `now`, given the times on screen.
    public static func interval(now: Date, anchors: [Date]) -> TimeInterval {
        anchors.contains { abs(now.timeIntervalSince($0)) < secondsWindow } ? fast : slow
    }
}
