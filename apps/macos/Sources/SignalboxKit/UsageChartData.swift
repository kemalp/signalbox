import Foundation

/// What the daily chart stacks by.
public enum ChartBreakdown: String, CaseIterable, Identifiable, Sendable {
    case model, kind, tokenType

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .model: "Model"
        case .kind: "Kind"
        case .tokenType: "Token type"
        }
    }
}

/// Palette slots handed out per series key. A key keeps its slot for as long as the registry lives, so a model
/// keeps its colour when the range changes or another model appears. Slots are never reused: once all are
/// taken, later keys get none and chart as a grey "Other".
public struct SeriesSlots: Hashable, Sendable {
    /// How many distinct series colours the palette has (the app's `Theme.series`).
    public static let capacity = 7

    public private(set) var slots: [String: Int]

    public init(_ slots: [String: Int] = [:]) {
        self.slots = slots
    }

    public func slot(for key: String) -> Int? { slots[key] }

    /// Gives each key without a slot the lowest free one, in the order given (put the biggest first).
    public mutating func assign(_ keys: some Sequence<String>) {
        var used = Set(slots.values)
        for key in keys where slots[key] == nil {
            guard let free = (0..<Self.capacity).first(where: { !used.contains($0) }) else { return }
            slots[key] = free
            used.insert(free)
        }
    }

    /// Kinds keep fixed slots (main thread is always the first colour); unknown kinds take what's left.
    public static let kinds: SeriesSlots = SeriesSlots(["main": 0, "subagent": 1, "workflow": 2, "auxiliary": 3, "other": 4])

    /// Fixed slots per cost component: reads teal, writes blue/violet, output orange, input amber, web search pink.
    public static let tokenTypes: SeriesSlots = SeriesSlots(Dictionary(uniqueKeysWithValues: TokenType.allCases.map { ($0.rawValue, $0.slot) }))
}

/// The cost components of a `CostBreakdown`, in stacking order (biggest usually first).
public enum TokenType: String, CaseIterable, Sendable {
    case cacheRead, cacheWrite5m, cacheWrite1h, output, input, webSearch

    public var label: String {
        switch self {
        case .cacheRead: "Cache reads"
        case .cacheWrite5m: "Cache writes 5m"
        case .cacheWrite1h: "Cache writes 1h"
        case .output: "Output"
        case .input: "Input"
        case .webSearch: "Web search"
        }
    }

    var slot: Int {
        switch self {
        case .cacheRead: 0
        case .cacheWrite5m: 1
        case .cacheWrite1h: 3
        case .output: 2
        case .input: 5
        case .webSearch: 4
        }
    }

    public func cost(_ c: CostBreakdown) -> Double {
        switch self {
        case .cacheRead: c.cacheRead
        case .cacheWrite5m: c.cacheWrite5m
        case .cacheWrite1h: c.cacheWrite1h
        case .output: c.output
        case .input: c.input
        case .webSearch: c.webSearch
        }
    }
}

/// `report.byDay` as stacked series for the Usage chart. Pure: build it from a report and the colour registry.
public struct UsageChartData: Equatable, Sendable {
    public struct Day: Identifiable, Equatable, Sendable {
        /// "YYYY-MM-DD", a local calendar day.
        public let key: String
        /// Local midnight of that day.
        public let date: Date
        /// The day's list-price-equivalent cost (0 for a day with no usage, or one the report skipped).
        public let total: Double
        public var id: String { key }
    }

    public struct Series: Identifiable, Equatable, Sendable {
        public static let otherKey = "__other__"

        public let key: String
        public let label: String
        /// Palette slot; nil draws the grey "Other" colour.
        public let slot: Int?
        /// One value per day, aligned with `days`.
        public let values: [Double]
        public let total: Double
        public var id: String { key }
        public var isOther: Bool { key == Self.otherKey }
    }

    /// One stacked segment: a series' value on a day.
    public struct Bar: Identifiable, Equatable, Sendable {
        public let dayIndex: Int
        public let seriesIndex: Int
        public let date: Date
        public let dayKey: String
        public let seriesLabel: String
        public let value: Double
        public var id: String { "\(seriesIndex)|\(dayKey)" }
    }

    public let breakdown: ChartBreakdown
    public let days: [Day]
    /// Biggest first (fixed order for kinds and token types). Series that are zero on every day are left out.
    public let series: [Series]
    /// The report has no per-day model/kind split (an older CLI): `series` is one "All" series of day totals.
    public let splitMissing: Bool
    /// Series with cost 0 on every day that were left out, e.g. unpriced models.
    public let omittedZeroSeries: [String]

    public init(breakdown: ChartBreakdown, days: [Day], series: [Series], splitMissing: Bool = false, omittedZeroSeries: [String] = []) {
        self.breakdown = breakdown
        self.days = days
        self.series = series
        self.splitMissing = splitMissing
        self.omittedZeroSeries = omittedZeroSeries
    }

    /// True when there's nothing to draw: no days, or no spend on any of them.
    public var isEmpty: Bool { !days.contains { $0.total > 0 } && !series.contains { $0.total > 0 } }

    public var maxDayTotal: Double {
        days.indices.map { i in max(days[i].total, series.reduce(0) { $0 + $1.values[i] }) }.max() ?? 0
    }

    /// Every non-zero segment, series by series (so stacks build bottom-up in series order).
    public var bars: [Bar] {
        var out: [Bar] = []
        for (si, s) in series.enumerated() {
            for (di, d) in days.enumerated() where s.values[di] > 0 {
                out.append(Bar(dayIndex: di, seriesIndex: si, date: d.date, dayKey: d.key, seriesLabel: s.label, value: s.values[di]))
            }
        }
        return out
    }

    /// The same chart with every value multiplied by `factor` (a currency rate), so axis ticks land on round
    /// numbers in the display currency.
    public func scaled(by factor: Double) -> UsageChartData {
        guard factor != 1, factor.isFinite, factor > 0 else { return self }
        return UsageChartData(
            breakdown: breakdown,
            days: days.map { Day(key: $0.key, date: $0.date, total: $0.total * factor) },
            series: series.map { Series(key: $0.key, label: $0.label, slot: $0.slot, values: $0.values.map { $0 * factor }) },
            splitMissing: splitMissing,
            omittedZeroSeries: omittedZeroSeries
        )
    }

    /// A day's non-zero series values, biggest first.
    public func split(dayIndex: Int) -> [(series: Series, value: Double)] {
        guard days.indices.contains(dayIndex) else { return [] }
        return series.compactMap { s in s.values[dayIndex] > 0 ? (s, s.values[dayIndex]) : nil }
            .sorted { $0.value > $1.value }
    }

    /// The day that contains `date` (e.g. the pointer's position on the x axis).
    public func dayIndex(containing date: Date?, calendar: Calendar = .current) -> Int? {
        guard let date else { return nil }
        let key = DayKey.key(date, calendar: calendar)
        return days.firstIndex { $0.key == key }
    }

    public func dayIndex(key: String) -> Int? {
        days.firstIndex { $0.key == key }
    }

    // MARK: Building

    /// Builds the chart for `report`. `modelSlots` is the app's colour registry for models; models it has no slot
    /// for get the next free ones (biggest first), and models past the palette fold into "Other".
    public static func build(report: Report, breakdown: ChartBreakdown, modelSlots: SeriesSlots = SeriesSlots(), calendar: Calendar = .current) -> UsageChartData {
        let rows = filledDays(report.byDay, calendar: calendar)
        let days = rows.map { Day(key: $0.key, date: $0.date, total: $0.row?.cost.total ?? 0) }

        switch breakdown {
        case .tokenType:
            let all = TokenType.allCases.map { t in
                Series(key: t.rawValue, label: t.label, slot: t.slot, values: rows.map { $0.row.map { t.cost($0.cost) } ?? 0 })
            }
            return finish(breakdown, days, all)

        case .model, .kind:
            let pick: (GroupTotals) -> [GroupTotals]? = breakdown == .model ? { $0.byModel } : { $0.byKind }
            guard rows.contains(where: { $0.row.flatMap(pick) != nil }) else {
                let label = breakdown == .model ? "All models" : "All kinds"
                let all = Series(key: "__all__", label: label, slot: 0, values: days.map(\.total))
                return finish(breakdown, days, [all], splitMissing: true)
            }
            var totals: [String: Double] = [:]
            for r in rows {
                for g in r.row.flatMap(pick) ?? [] { totals[g.key, default: 0] += g.cost.total }
            }
            // Biggest first; ties in name order so the result never depends on dictionary order.
            let byTotal = totals.keys.sorted { a, b in totals[a]! != totals[b]! ? totals[a]! > totals[b]! : a < b }
            var slots = breakdown == .model ? modelSlots : SeriesSlots.kinds
            // Only series that will be drawn take a colour.
            slots.assign(byTotal.filter { totals[$0]! > 0 })
            // Kinds in their fixed order (unknown ones after, biggest first); models biggest first.
            let rank = Dictionary(uniqueKeysWithValues: byTotal.enumerated().map { ($1, $0) })
            let ordered: [String] = breakdown == .model ? byTotal : byTotal.sorted { (kindRank($0), rank[$0]!) < (kindRank($1), rank[$1]!) }
            func values(_ keys: Set<String>) -> [Double] {
                rows.map { r in (r.row.flatMap(pick) ?? []).filter { keys.contains($0.key) }.reduce(0) { $0 + $1.cost.total } }
            }
            var series: [Series] = []
            var other: [String] = []
            for key in ordered {
                guard let slot = slots.slot(for: key) else {
                    if totals[key]! > 0 { other.append(key) }
                    continue
                }
                let label = breakdown == .model ? key : Fmt.kindLabel(key)
                series.append(Series(key: key, label: label, slot: slot, values: values([key])))
            }
            let zero = ordered.filter { totals[$0]! <= 0 }
            if !other.isEmpty {
                let label = other.count == 1 ? (breakdown == .model ? other[0] : Fmt.kindLabel(other[0])) : "Other (\(other.count))"
                series.append(Series(key: Series.otherKey, label: label, slot: nil, values: values(Set(other))))
            }
            return finish(breakdown, days, series, omitted: zero.map { breakdown == .model ? $0 : Fmt.kindLabel($0) })
        }
    }

    /// Drops series that are zero on every day (no web search, an unpriced model); `omitted` names the ones worth a note.
    private static func finish(_ breakdown: ChartBreakdown, _ days: [Day], _ series: [Series], splitMissing: Bool = false, omitted: [String] = []) -> UsageChartData {
        UsageChartData(breakdown: breakdown, days: days, series: series.filter { $0.total > 0 }, splitMissing: splitMissing, omittedZeroSeries: omitted)
    }

    private static func kindRank(_ kind: String) -> Int {
        SeriesSlots.kinds.slot(for: kind) ?? 99
    }

    /// The report's day rows on a continuous run of local days: a day the report skipped is filled in empty.
    static func filledDays(_ byDay: [GroupTotals], calendar: Calendar) -> [(key: String, date: Date, row: GroupTotals?)] {
        let parsed = byDay.compactMap { row in DayKey.date(row.key, calendar: calendar).map { (row: row, date: $0) } }
            .sorted { $0.date < $1.date }
        guard let first = parsed.first?.date, let last = parsed.last?.date else { return [] }
        var byDate: [Date: GroupTotals] = [:]
        for p in parsed { byDate[p.date] = p.row }
        var out: [(key: String, date: Date, row: GroupTotals?)] = []
        var day = first
        // A guard against a bogus key years away; the CLI caps byDay well below this.
        while day <= last, out.count < 800 {
            out.append((DayKey.key(day, calendar: calendar), day, byDate[day]))
            guard let next = DayKey.nextDay(day, calendar: calendar) else { break }
            day = next
        }
        return out
    }
}

extension UsageChartData.Series {
    init(key: String, label: String, slot: Int?, values: [Double]) {
        self.init(key: key, label: label, slot: slot, values: values, total: values.reduce(0, +))
    }
}

/// "YYYY-MM-DD" local day keys, as the report writes them.
public enum DayKey {
    public static func date(_ key: String, calendar: Calendar = .current) -> Date? {
        let parts = key.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        guard let date = calendar.date(from: DateComponents(year: y, month: m, day: d)) else { return nil }
        // Reject keys the calendar rolled over (2026-02-31 → March 3).
        return calendar.component(.day, from: date) == d ? calendar.startOfDay(for: date) : nil
    }

    /// The start of the calendar day after `date`'s. Steps from midday and re-anchors with `startOfDay`: where a
    /// clock change skips midnight (Chile, Cuba, the Azores) that day starts at 01:00, and stepping by `.day` from
    /// it would keep 01:00 on every later day, so no later day would match its key's midnight.
    public static func nextDay(_ date: Date, calendar: Calendar = .current) -> Date? {
        let midday = calendar.startOfDay(for: date).addingTimeInterval(12 * 3600)
        guard let next = calendar.date(byAdding: .day, value: 1, to: midday) else { return nil }
        let start = calendar.startOfDay(for: next)
        return start > date ? start : nil
    }

    public static func key(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}

/// The first and last local calendar day a report covers.
public struct DaySpan: Equatable, Sendable {
    public let first: Date
    public let last: Date

    public init(first: Date, last: Date) {
        self.first = first
        self.last = last
    }

    public var isSingleDay: Bool { first == last }
}

extension Report {
    /// The calendar days this report covers: its first and last `byDay` keys, else its range (whose end is exclusive).
    public func daySpan(calendar: Calendar = .current) -> DaySpan? {
        let keys = byDay.compactMap { DayKey.date($0.key, calendar: calendar) }.sorted()
        if let first = keys.first, let last = keys.last { return DaySpan(first: first, last: last) }
        guard let range else { return nil }
        let first = calendar.startOfDay(for: range.since)
        let last = calendar.startOfDay(for: range.until.addingTimeInterval(-0.001))
        return DaySpan(first: first, last: max(first, last))
    }
}
