import Foundation

/// The user's monthly plan price, for the "plan value" tile on Usage.
public struct PlanPrice: Equatable, Sendable {
    public let amount: Double
    public let currency: DisplayCurrency

    public init?(amount: Double?, currency: DisplayCurrency) {
        guard let amount, amount.isFinite, amount > 0 else { return nil }
        self.amount = amount
        self.currency = currency
    }
}

/// "Last 30 days at list price ≈ N× your plan". Only a 30-day report is compared with a monthly price;
/// any other window says to switch, never a prorated guess.
public enum PlanValue: Equatable, Sendable {
    /// No plan price set.
    case notConfigured
    /// The report isn't a 30-day one (or hasn't arrived).
    case needsThirtyDays
    /// The plan is priced in a currency with no rate entered, so it can't be compared with USD list prices.
    case needsRate(DisplayCurrency)
    /// `listPrice` is the 30 days' recorded list-price equivalent in the plan's currency.
    case value(multiple: Double, listPrice: Double, plan: PlanPrice)

    public static let windowDays = 30

    /// `rates` are units per USD for each non-USD currency the user entered a rate for.
    public static func compute(report: Report?, days: Int?, plan: PlanPrice?, rates: [DisplayCurrency: Double]) -> PlanValue {
        guard let plan else { return .notConfigured }
        guard let report, days == windowDays else { return .needsThirtyDays }
        let usd = report.estimate?.recordedUsd ?? report.totals.cost.total
        let rate: Double
        if plan.currency == .usd {
            rate = 1
        } else if let r = rates[plan.currency], r.isFinite, r > 0 {
            rate = r
        } else {
            return .needsRate(plan.currency)
        }
        let list = usd * rate
        return .value(multiple: list / plan.amount, listPrice: list, plan: plan)
    }

    /// "4.2×" under 10, "12×" from 10; "<0.1×" for next to nothing.
    public static func multipleText(_ m: Double) -> String {
        guard m.isFinite, m >= 0 else { return Fmt.dash }
        if m > 0, m < 0.1 { return "<0.1×" }
        if m >= 10 { return "\(Int(m.rounded()))×" }
        return String(format: "%.1f×", m)
    }
}
