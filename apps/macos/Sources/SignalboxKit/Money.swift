import Foundation

/// The currencies the app can show. Every figure starts as a USD list-price equivalent; the others are
/// converted at a rate the user enters (Signalbox never fetches exchange rates).
public enum DisplayCurrency: String, CaseIterable, Identifiable, Sendable, Codable {
    case usd = "USD"
    case gbp = "GBP"
    case eur = "EUR"

    public var id: String { rawValue }
    public var code: String { rawValue }

    public var symbol: String {
        switch self {
        case .usd: "$"
        case .gbp: "£"
        case .eur: "€"
        }
    }

    /// A fixed locale per currency, so "£1,234.50" reads the same on every Mac (and in tests).
    var locale: Locale {
        switch self {
        case .usd: Locale(identifier: "en_US")
        case .gbp: Locale(identifier: "en_GB")
        case .eur: Locale(identifier: "en_IE")
        }
    }

    public var name: String {
        switch self {
        case .usd: "US dollar"
        case .gbp: "Pound sterling"
        case .eur: "Euro"
        }
    }
}

/// The one formatter every money figure goes through: the chosen currency and, for GBP/EUR, the user's rate.
/// `Money.usd` prints exactly what `Fmt.usd` and friends print.
public struct Money: Equatable, Sendable {
    public let currency: DisplayCurrency
    /// Units of `currency` per 1 USD; 1 for USD.
    public let rate: Double
    /// When the user says the rate was taken, if they set it.
    public let rateAsOf: Date?

    public static let usd = Money(currency: .usd, rate: 1, rateAsOf: nil)

    /// A rate that isn't a positive finite number falls back to plain USD: no figure is ever converted at a guess.
    public init(currency: DisplayCurrency, rate: Double?, rateAsOf: Date? = nil) {
        if currency == .usd {
            self.currency = .usd
            self.rate = 1
            self.rateAsOf = nil
        } else if let rate, rate.isFinite, rate > 0 {
            self.currency = currency
            self.rate = rate
            self.rateAsOf = rateAsOf
        } else {
            self.currency = .usd
            self.rate = 1
            self.rateAsOf = nil
        }
    }

    /// True when figures are converted from USD at the user's rate.
    public var isConverted: Bool { currency != .usd }

    private var style: FloatingPointFormatStyle<Double>.Currency {
        FloatingPointFormatStyle<Double>.Currency(code: currency.code, locale: currency.locale).precision(.fractionLength(2))
    }

    /// A USD amount in the display currency.
    public func convert(_ usd: Double) -> Double { usd * rate }

    // MARK: From USD

    /// 1234.5 → "$1,234.50" (or "£975.26" at 0.79); tiny positive amounts → "<$0.01"; nil → "—".
    public func amount(_ usd: Double?) -> String {
        guard let usd, usd.isFinite else { return Fmt.dash }
        return display(convert(usd))
    }

    /// Whole units for big headline numbers (cents kept under 100).
    public func headline(_ usd: Double?) -> String {
        guard let usd, usd.isFinite else { return Fmt.dash }
        return displayHeadline(convert(usd))
    }

    /// "$1,697–$1,920", or one figure when both ends print the same.
    public func headlineRange(_ lowUSD: Double?, _ highUSD: Double?) -> String {
        let lo = headline(lowUSD), hi = headline(highUSD)
        if lo == Fmt.dash || hi == Fmt.dash { return Fmt.dash }
        return lo == hi ? lo : "\(lo)–\(hi)"
    }

    // MARK: Already in the display currency (chart values, which are converted once when the chart is built)

    public func display(_ value: Double) -> String {
        guard value.isFinite else { return Fmt.dash }
        if value > 0, value < 0.005 { return "<" + 0.01.formatted(style) }
        return value.formatted(style)
    }

    public func displayHeadline(_ value: Double) -> String {
        guard value.isFinite else { return Fmt.dash }
        if abs(value) < 100 { return display(value) }
        return value.rounded(.toNearestOrAwayFromZero).formatted(style.precision(.fractionLength(0)))
    }

    /// Axis ticks: "£0", "£50", "£1.2K"; pence when the whole axis is under 5.
    public func axis(_ value: Double, axisMax: Double) -> String {
        guard value.isFinite else { return Fmt.dash }
        if value == 0 { return "\(currency.symbol)0" }
        if axisMax < 5 { return value.formatted(style) }
        if abs(value) >= 1000 { return currency.symbol + Fmt.tokens(value) }
        return value.rounded().formatted(style.precision(.fractionLength(0)))
    }

    // MARK: Notes

    /// "1 USD = 0.79 GBP", or nil for USD.
    public var rateText: String? {
        guard isConverted else { return nil }
        return "1 USD = \(Self.rateString(rate)) \(currency.code)"
    }

    /// The short footnote shown next to totals, e.g. "Converted at your rate: 1 USD = 0.79 GBP (as of 1 Oct 2026)".
    public func footnote(locale: Locale = .autoupdatingCurrent) -> String? {
        guard let rateText else { return nil }
        let asOf = rateAsOf.map { " (as of \($0.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale))))" } ?? ""
        return "Converted at your rate: \(rateText)\(asOf)"
    }

    /// Up to four significant decimals without trailing zeros: 0.79 → "0.79", 0.8123 → "0.8123", 1 → "1".
    public static func rateString(_ rate: Double) -> String {
        var s = String(format: "%.4f", rate)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }
}
