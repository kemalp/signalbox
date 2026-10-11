import Foundation

/// What a context-window bar shows: fill, colour band, the auto-compact tick, and its text. Pure, from a snapshot.
public struct ContextGaugeModel: Equatable, Sendable {
    /// Amber from here (percent of the window).
    public static let defaultWarnAt: Double = 75
    /// Red from here, or 5 points before auto-compaction when that comes sooner.
    public static let defaultCritAt: Double = 90

    /// Tokens over the window in percent (the agent's own figure when it gives one); nil when unknown.
    public let percent: Double?
    /// The bar's fill, 0...1; nil draws an empty track (unknown, not zero).
    public let fraction: Double?
    /// Where auto-compaction starts, 0...1, if known.
    public let tickFraction: Double?
    public let warnAt: Double
    public let critAt: Double
    public let severity: Fmt.Severity
    /// "319K of 1M (32%)", "88.4K · window unknown", or "Context unknown".
    public let caption: String
    /// "auto-compact at 97%", if known.
    public let tickLabel: String?
    public let quality: ContextQuality?
    public let accessibilityValue: String

    public init(_ context: ContextSnapshot?) {
        quality = context?.quality
        let pct = context?.effectivePercent.flatMap { $0.isFinite ? $0 : nil }
        percent = pct
        fraction = pct.map { min(1, max(0, $0 / 100)) }
        let ac = context?.autoCompactAtPercent.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        tickFraction = ac.map { min(1, $0 / 100) }
        critAt = ac.map { min(Self.defaultCritAt, $0 - 5) } ?? Self.defaultCritAt
        warnAt = min(Self.defaultWarnAt, critAt)
        severity = Fmt.severity(pct, warnAt: warnAt, critAt: critAt)
        tickLabel = ac.map { "auto-compact at \(Fmt.percent($0))" }

        guard let c = context else {
            caption = "Context unknown"
            accessibilityValue = "unknown"
            return
        }
        let used = Fmt.tokens(c.tokens)
        switch (c.window.flatMap { $0 > 0 ? $0 : nil }, pct) {
        case let (window?, pct?):
            caption = "\(used) of \(Fmt.tokens(window)) (\(Fmt.percent(pct)))"
        case let (nil, pct?):
            caption = "\(used) (\(Fmt.percent(pct)))"
        default:
            caption = "\(used) · window unknown"
        }
        let q = c.quality == .official ? "reported by the agent" : c.quality == .estimated ? "estimated" : nil
        var parts: [String]
        if let pct {
            parts = ["\(Fmt.percent(pct)) used", "\(used) of \(c.window.map { Fmt.tokens($0) } ?? "an unknown number of") tokens"]
        } else {
            parts = ["\(used) tokens", "window size unknown"]
        }
        if let tickLabel { parts.append(tickLabel) }
        if let q { parts.append(q) }
        accessibilityValue = parts.joined(separator: ", ")
    }
}

extension LimitState {
    /// A reading older than this shows no fill: limits also move with use on other devices.
    public static let staleAfter: TimeInterval = 15 * 60

    /// Reset passed beats stale: a window that reset since the reading is known to be out of date.
    public static func of(_ limit: LimitSnapshot, now: Date, staleAfter: TimeInterval = LimitState.staleAfter) -> LimitState {
        if let resetsAt = limit.resetsAt, resetsAt <= now { return .resetPassed }
        if now.timeIntervalSince(limit.observedAt) > staleAfter { return .stale }
        return .fresh
    }
}

/// What a limit bar or ring shows. Only a fresh reading fills; a stale or reset-passed one shows an empty,
/// greyed track with a label saying why, and keeps its last value as "was N%".
public struct LimitPresentation: Equatable, Sendable {
    public let state: LimitState
    /// 0...1 for a fresh reading; nil otherwise (an empty track).
    public let fillFraction: Double?
    /// "63%" when fresh, else "—".
    public let valueText: String
    /// "was 88%" when not fresh.
    public let lastValueText: String?
    /// Fresh: "resets in 2h 14m". Stale: "stale · as of 47m ago". Reset passed: "reset passed".
    public let statusText: String
    /// One word for a small caption: nil when fresh, else "stale" or "reset passed".
    public let shortStatus: String?
    public let severity: Fmt.Severity
    public let accessibilityValue: String

    public init(_ limit: LimitSnapshot, now: Date) {
        self.init(limit, state: .of(limit, now: now), now: now)
    }

    public init(_ limit: LimitSnapshot, state: LimitState, now: Date) {
        self.state = state
        let pct = Fmt.percent(limit.usedPercent)
        let ago = Fmt.ago(limit.observedAt, now: now)
        severity = Fmt.severity(limit.usedPercent)
        switch state {
        case .fresh:
            fillFraction = min(1, max(0, limit.usedPercent / 100))
            valueText = pct
            lastValueText = nil
            statusText = Fmt.countdown(limit.resetsAt, now: now)
            shortStatus = nil
            accessibilityValue = "\(pct) used. \(Fmt.countdown(limit.resetsAt, now: now)). As of \(ago)."
        case .stale:
            fillFraction = nil
            valueText = Fmt.dash
            lastValueText = "was \(pct)"
            statusText = "stale · as of \(ago)"
            shortStatus = "stale"
            accessibilityValue = "Unknown: the last reading is stale, from \(ago), and was \(pct). \(Fmt.countdown(limit.resetsAt, now: now))."
        case .resetPassed:
            fillFraction = nil
            valueText = Fmt.dash
            lastValueText = "was \(pct)"
            statusText = "reset passed"
            shortStatus = "reset passed"
            accessibilityValue = "Unknown: the window reset after the last reading, which was \(pct) as of \(ago)."
        }
    }
}
