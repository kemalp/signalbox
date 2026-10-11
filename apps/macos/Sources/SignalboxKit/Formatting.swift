import Foundation

/// Pure display formatting, matching apps/web/src/format.ts. Missing data renders as an em dash, never 0.
public enum Fmt {
    public static let dash = "—"
    /// Shown next to every dollar figure somewhere visible.
    public static let listPriceNote = "List-price equivalent, not a bill"

    // MARK: Money

    private static let usdStyle = FloatingPointFormatStyle<Double>.Currency(code: "USD", locale: Locale(identifier: "en_US"))
        .precision(.fractionLength(2))

    /// 1234.5 → "$1,234.50"; 0.001 → "<$0.01"; nil → "—".
    public static func usd(_ value: Double?) -> String {
        guard let value, value.isFinite else { return dash }
        if value > 0, value < 0.005 { return "<$0.01" }
        return value.formatted(usdStyle)
    }

    /// Whole dollars for big headline numbers: 1234.5 → "$1,235" (keeps cents under $100).
    public static func usdHeadline(_ value: Double?) -> String {
        guard let value, value.isFinite else { return dash }
        if abs(value) < 100 { return usd(value) }
        return value.rounded(.toNearestOrAwayFromZero).formatted(usdStyle.precision(.fractionLength(0)))
    }

    /// A headline range, "$1,697–$1,920", or one figure when both ends print the same ("$938").
    public static func usdHeadlineRange(_ low: Double?, _ high: Double?) -> String {
        let lo = usdHeadline(low), hi = usdHeadline(high)
        if lo == dash || hi == dash { return dash }
        return lo == hi ? lo : "\(lo)–\(hi)"
    }

    // MARK: Tokens and numbers

    private static let units: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e3, "K")]

    private static func compact(_ v: Double) -> String {
        let digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
        let rounded = (v * pow(10, Double(digits))).rounded() / pow(10, Double(digits))
        // Drop trailing zeros: 1.00 → "1", 1.50 → "1.5".
        var s = String(format: "%.\(digits)f", rounded)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    /// 999 → "999", 12_345 → "12.3K", 1_880_000_000 → "1.88B".
    public static func tokens(_ value: Double?) -> String {
        guard let value, value.isFinite else { return dash }
        let a = abs(value)
        let sign = value < 0 ? "-" : ""
        if a < 1000 { return sign + String(Int(a.rounded())) }
        for (i, (size, unit)) in units.enumerated() where a >= size {
            let text = compact(a / size)
            // Rounding can carry into the next unit (999.96K → "1000K"): promote it.
            if (Double(text) ?? 0) >= 1000, i > 0 {
                let (bigger, biggerUnit) = units[i - 1]
                return sign + compact(a / bigger) + biggerUnit
            }
            return sign + text + unit
        }
        return sign + String(a)
    }

    public static func tokens(_ value: Int?) -> String {
        tokens(value.map(Double.init))
    }

    /// 12345 → "12,345".
    public static func count(_ value: Int?) -> String {
        guard let value else { return dash }
        return value.formatted(.number.locale(Locale(identifier: "en_US")))
    }

    /// A value already in percent (0...100): 41.23 → "41%".
    public static func percent(_ value: Double?, digits: Int = 0) -> String {
        guard let value, value.isFinite else { return dash }
        return String(format: "%.\(digits)f%%", value)
    }

    /// A ratio (0...1) as a percent: 0.9681 → "96.8%".
    public static func ratio(_ value: Double?, digits: Int = 1) -> String {
        guard let value, value.isFinite else { return dash }
        return percent(value * 100, digits: digits)
    }

    // MARK: Time

    /// Compact duration: "45s", "12m", "2h 5m", "3d 4h".
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return m % 60 != 0 ? "\(h)h \(m % 60)m" : "\(h)h" }
        let d = h / 24
        return h % 24 != 0 ? "\(d)d \(h % 24)h" : "\(d)d"
    }

    /// "just now", "12s ago", "3h 5m ago"; nil → "—". Future dates (clock skew) read "just now".
    public static func ago(_ date: Date?, now: Date) -> String {
        guard let date else { return dash }
        let s = now.timeIntervalSince(date)
        if s < 5 { return "just now" }
        return "\(duration(s)) ago"
    }

    /// Like `ago`, but coarser for old dates, which sit beside a full date anyway: "3d 4h ago" up to a week, then
    /// "25d ago", then "7 months ago" from 60 days and "2 years ago" from two years.
    public static func agoRounded(_ date: Date?, now: Date) -> String {
        guard let date else { return dash }
        let days = Int((now.timeIntervalSince(date) / 86_400).rounded(.down))
        if days < 7 { return ago(date, now: now) }
        if days < 60 { return "\(days)d ago" }
        if days < 730 { return "\(max(2, Int(Double(days) / 30.44))) months ago" }
        return "\(max(2, Int(Double(days) / 365.25))) years ago"
    }

    /// "resets in 2h 14m", "reset passed", or "reset time unknown".
    public static func countdown(_ resetsAt: Date?, now: Date) -> String {
        guard let resetsAt else { return "reset time unknown" }
        let s = resetsAt.timeIntervalSince(now)
        if s <= 0 { return "reset passed" }
        return "resets in \(duration(s))"
    }

    /// Time of day for today-ish timestamps, else a short date and time.
    public static func clock(_ date: Date?, now: Date, calendar: Calendar = .current) -> String {
        guard let date else { return dash }
        if abs(now.timeIntervalSince(date)) < 20 * 3600 {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    // MARK: Calendar days

    /// The calendar days a report covers, as the locale writes a span: "3 – 9 Oct" (en_GB), "Oct 3 – 9" (en_US);
    /// one day reads "Fri 9 Oct". The year appears only when the span crosses one.
    public static func daySpan(_ span: DaySpan, calendar: Calendar = .current, locale: Locale = .autoupdatingCurrent) -> String {
        if span.isSingleDay {
            return span.first.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).day().month(.abbreviated))
        }
        var style = Date.IntervalFormatStyle().day().month(.abbreviated).locale(locale)
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        if calendar.component(.year, from: span.first) != calendar.component(.year, from: span.last) { style = style.year() }
        return (span.first..<span.last).formatted(style)
    }

    /// "7 days · 3 – 9 Oct", "Today · Fri 9 Oct"; just "7 days" when the span is unknown.
    public static func rangeTitle(days: Int, span: DaySpan?, calendar: Calendar = .current, locale: Locale = .autoupdatingCurrent) -> String {
        let name = UsageRange.describe(days: days)
        guard let span else { return name }
        return "\(name) · \(daySpan(span, calendar: calendar, locale: locale))"
    }

    /// A chart axis label for a day: "Fri 9" for a week, "9 Oct" for longer spans.
    public static func axisDay(_ date: Date, dayCount: Int, calendar: Calendar = .current, locale: Locale = .autoupdatingCurrent) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        return dayCount <= 10 ? date.formatted(style.weekday(.abbreviated).day()) : date.formatted(style.day().month(.abbreviated))
    }

    /// A day in a chart callout: "Fri 9 Oct".
    public static func calloutDay(_ date: Date, calendar: Calendar = .current, locale: Locale = .autoupdatingCurrent) -> String {
        date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).day().month(.abbreviated))
    }

    /// Dollar axis ticks: "$0", "$50", "$1.2K"; cents when the whole axis is under $5.
    public static func usdAxis(_ value: Double, axisMax: Double) -> String {
        guard value.isFinite else { return dash }
        if value == 0 { return "$0" }
        if axisMax < 5 { return value.formatted(usdStyle) }
        if abs(value) >= 1000 { return "$" + tokens(value) }
        return value.rounded().formatted(usdStyle.precision(.fractionLength(0)))
    }

    // MARK: Paths and ids

    public static func basename(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return parts.last.map(String.init) ?? path
    }

    /// "/Users/you/code/api" → "~/…/api"; "/Users/you/api" → "~/api"; "/opt/a/b/c" → "/…/c".
    public static func shortPath(_ path: String?, home: String = NSHomeDirectory()) -> String {
        guard var path, !path.isEmpty else { return dash }
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        let trimmedHome = home.hasSuffix("/") ? String(home.dropLast()) : home
        var prefix = ""
        var rest = path
        if !trimmedHome.isEmpty, path == trimmedHome {
            return "~"
        } else if !trimmedHome.isEmpty, path.hasPrefix(trimmedHome + "/") {
            prefix = "~/"
            rest = String(path.dropFirst(trimmedHome.count + 1))
        } else if path.hasPrefix("/") {
            prefix = "/"
            rest = String(path.dropFirst())
        }
        let parts = rest.split(separator: "/", omittingEmptySubsequences: true)
        guard let last = parts.last else { return path }
        if parts.count <= 1 { return prefix + last }
        return prefix + "…/" + last
    }

    public static func shortID(_ id: String) -> String {
        id.count > 8 ? String(id.prefix(8)) : id
    }

    // MARK: Labels

    public static func agentName(_ agent: AgentID) -> String {
        switch agent {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        case .geminiCLI: "Gemini"
        // Not an agent: the owner of a Health row ("claude-app:sessions", the Claude app's session list).
        case "claude-app": "Claude app"
        default: agent.rawValue
        }
    }

    private static let limitLabels: [String: String] = [
        "five_hour": "5-hour window",
        "seven_day": "Weekly",
        "seven_day_opus": "Weekly · Opus",
        "seven_day_sonnet": "Weekly · Sonnet",
        "seven_day_fable": "Weekly · Fable",
        "spend_limit": "Spend limit",
        "codex.primary": "Primary window",
        "codex.secondary": "Secondary window",
    ]

    /// The CLI's label, else a known kind's label, else the kind made readable
    /// ("monthly_overage_pool" → "Monthly overage pool"; unknown kinds are otherwise kept as they are).
    public static func limitLabel(_ limit: LimitSnapshot) -> String {
        if let label = limit.label, !label.isEmpty { return label }
        if let known = limitLabels[limit.kind] { return known }
        guard limit.kind.contains("_") else { return limit.kind }
        let words = limit.kind.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// A few characters for a ring caption: the model for per-model windows ("Fable" for
    /// seven_day_fable, "gpt-reserve" for a "Weekly (gpt-reserve)" label), else "5h"/"7d", else the
    /// label's first word.
    public static func limitShortLabel(_ limit: LimitSnapshot) -> String {
        if limit.kind.hasPrefix("seven_day_") {
            return limit.kind.dropFirst("seven_day_".count).replacingOccurrences(of: "_", with: " ").capitalized
        }
        if let label = limit.label, let open = label.lastIndex(of: "("), label.hasSuffix(")") {
            let inner = label[label.index(after: open)..<label.index(before: label.endIndex)].trimmingCharacters(in: .whitespaces)
            if !inner.isEmpty { return inner }
        }
        return windowLabel(limit.windowMinutes) ?? String(limitLabel(limit).split(separator: " ").first ?? "")
    }

    /// A price table's provider as people write it ("openai" → "OpenAI").
    public static func providerName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "anthropic": "Anthropic"
        case "openai": "OpenAI"
        case "google", "gemini": "Google"
        case "xai": "xAI"
        default: provider.prefix(1).uppercased() + provider.dropFirst()
        }
    }

    /// A price table's `asOf` ("2026-10-09") as an abbreviated UTC date ("Oct 9, 2026"); anything unparsable as given.
    public static func priceDate(_ asOf: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard let d = ISODate.parse(asOf) else { return asOf }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale)
        style.timeZone = TimeZone(identifier: "UTC")!
        return d.formatted(style)
    }

    /// "Anthropic list prices as of Oct 9, 2026; OpenAI list prices as of Oct 9, 2026".
    public static func priceTablesNote(_ tables: [PriceTableInfo], locale: Locale = .autoupdatingCurrent) -> String {
        tables.map { "\(providerName($0.provider)) list prices as of \(priceDate($0.asOf, locale: locale))" }.joined(separator: "; ")
    }

    /// `text` ending in one sentence mark: "exited with status 1" → "exited with status 1.", "done." stays.
    public static func sentence(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = t.last else { return t }
        return ".!?…".contains(last) ? t : t + "."
    }

    /// 300 → "5h", 10080 → "7d", 45 → "45m".
    public static func windowLabel(_ minutes: Double?) -> String? {
        guard let minutes, minutes > 0, minutes.isFinite else { return nil }
        let m = Int(minutes.rounded())
        if m % 1440 == 0 { return "\(m / 1440)d" }
        if m % 60 == 0 { return "\(m / 60)h" }
        return "\(m)m"
    }

    /// A context snapshot's `windowSource` in words: "agent" (sent with the reading) or "model-table" (the
    /// model's documented size, from Signalbox's models/*.json); unknown values as given.
    public static func windowSourceLabel(_ source: String?) -> String? {
        guard let source, !source.isEmpty else { return nil }
        switch source {
        case "agent": return "reported by the agent"
        case "model-table": return "documented size for the model"
        default: return source
        }
    }

    public static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "main": "Main thread"
        case "subagent": "Subagents"
        case "workflow": "Workflows"
        case "auxiliary": "Auxiliary"
        case "other": "Other"
        default: kind
        }
    }

    public static func statusLabel(_ status: SessionStatus) -> String {
        switch status {
        case .busy: "Busy"
        case .waiting: "Waiting"
        case .idle: "Idle"
        case .ended: "Ended"
        case .unknown: "Unknown"
        }
    }

    /// The Sessions subtitle: "2 waiting · 1 busy · 3 idle", leaving out zero counts; with nothing live, the ended
    /// count. `convertedTo` adds the note that costs are converted at the user's rate.
    public static func sessionCounts(_ counts: [SessionStatus: Int], convertedTo currency: String? = nil) -> String {
        var parts = [SessionStatus.waiting, .busy, .idle].compactMap { status -> String? in
            let n = counts[status] ?? 0
            return n > 0 ? "\(n) \(statusLabel(status).lowercased())" : nil
        }
        if parts.isEmpty, let ended = counts[.ended], ended > 0 { parts.append("\(ended) ended") }
        if let currency { parts.append("costs in \(currency) at your rate") }
        return parts.joined(separator: " · ")
    }

    public enum Severity: Sendable, Equatable { case ok, warn, crit }

    public static func severity(_ percent: Double?, warnAt: Double = 75, critAt: Double = 90) -> Severity {
        guard let percent else { return .ok }
        if percent >= critAt { return .crit }
        if percent >= warnAt { return .warn }
        return .ok
    }
}
