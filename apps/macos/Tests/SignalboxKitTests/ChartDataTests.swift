import Foundation
import Testing
@testable import SignalboxKit

/// A fixed calendar so day keys and spans don't depend on the machine running the tests.
let london: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Europe/London")!
    c.locale = Locale(identifier: "en_GB")
    return c
}()

/// A byDay row with the given per-model and per-kind costs (tokens don't matter to the chart).
func day(_ key: String, models: [String: Double] = [:], kinds: [String: Double]? = nil, cost: CostBreakdown? = nil, split: Bool = true) -> GroupTotals {
    let total = cost?.total ?? models.values.reduce(0, +)
    let group = { (k: String, v: Double) in GroupTotals(key: k, cost: CostBreakdown(total: v)) }
    return GroupTotals(
        key: key,
        cost: cost ?? CostBreakdown(cacheRead: total, total: total),
        byModel: split ? models.sorted { $0.key < $1.key }.map(group) : nil,
        byKind: split ? (kinds ?? ["main": total]).sorted { $0.key < $1.key }.map(group) : nil
    )
}

func report(_ days: [GroupTotals], range: DateRange? = nil) -> Report {
    Report(generatedAt: date("2026-10-09T14:30:00Z"), range: range, byDay: days)
}

@Suite("Usage chart series")
struct ChartDataTests {
    @Test func stacksByModelBiggestFirstWithStableSlots() throws {
        let r = report([
            day("2026-10-07", models: ["opus": 10, "sonnet": 2]),
            day("2026-10-08", models: ["opus": 20, "haiku": 1, "unpriced-x": 0]),
            day("2026-10-09", models: ["sonnet": 3]),
        ])
        let data = UsageChartData.build(report: r, breakdown: .model, calendar: london)
        #expect(data.days.map(\.key) == ["2026-10-07", "2026-10-08", "2026-10-09"])
        #expect(data.series.map(\.key) == ["opus", "sonnet", "haiku"])
        #expect(data.series.map(\.slot) == [0, 1, 2])
        #expect(data.series[0].values == [10, 20, 0])
        #expect(data.series[1].values == [2, 0, 3])
        #expect(data.series[0].total == 30)
        // A model with no cost can't be drawn in dollars; it's named instead.
        #expect(data.omittedZeroSeries == ["unpriced-x"])
        #expect(!data.splitMissing)
        #expect(data.maxDayTotal == 21)
        // Segments only where there's spend, series by series so stacks build bottom-up in series order.
        #expect(data.bars.count == 5)
        #expect(data.bars.first?.seriesLabel == "opus")
        let split = data.split(dayIndex: 1)
        #expect(split.map(\.series.key) == ["opus", "haiku"])
        #expect(split.map(\.value) == [20, 1])
    }

    @Test func aRegistrySlotWinsOverRank() {
        // The app saw haiku first; it keeps the first colour even though opus is bigger now.
        var registry = SeriesSlots()
        registry.assign(["haiku"])
        let r = report([day("2026-10-09", models: ["opus": 10, "haiku": 1])])
        let data = UsageChartData.build(report: r, breakdown: .model, modelSlots: registry, calendar: london)
        #expect(data.series.map(\.key) == ["opus", "haiku"])
        #expect(data.series.first { $0.key == "haiku" }?.slot == 0)
        #expect(data.series.first { $0.key == "opus" }?.slot == 1)
    }

    @Test func slotsAreStableAndNeverReused() {
        var slots = SeriesSlots()
        slots.assign(["a", "b"])
        slots.assign(["c", "a"])
        #expect(slots.slot(for: "a") == 0)
        #expect(slots.slot(for: "b") == 1)
        #expect(slots.slot(for: "c") == 2)
        // Assigning the same keys again changes nothing.
        let before = slots
        slots.assign(["c", "b", "a"])
        #expect(slots == before)
        // Past the palette, keys get no slot.
        slots.assign((0..<10).map { "m\($0)" })
        #expect(slots.slots.count == SeriesSlots.capacity)
        #expect(slots.slot(for: "m3") == 6)
        #expect(slots.slot(for: "m4") == nil)
    }

    @Test func modelsPastThePaletteFoldIntoOther() {
        let models = Dictionary(uniqueKeysWithValues: (0..<9).map { ("model-\($0)", Double(90 - $0 * 10)) })
        let data = UsageChartData.build(report: report([day("2026-10-09", models: models)]), breakdown: .model, calendar: london)
        #expect(data.series.count == SeriesSlots.capacity + 1)
        let other = try! #require(data.series.last)
        #expect(other.isOther)
        #expect(other.slot == nil)
        #expect(other.label == "Other (2)")
        #expect(other.total == 20 + 10)
    }

    @Test func kindsUseFixedOrderAndSlots() {
        let r = report([
            day("2026-10-08", models: ["opus": 10], kinds: ["workflow": 6, "main": 3, "subagent": 1]),
            day("2026-10-09", models: ["opus": 5], kinds: ["auxiliary": 1, "main": 4, "mystery": 0.5]),
        ])
        let data = UsageChartData.build(report: r, breakdown: .kind, calendar: london)
        #expect(data.series.map(\.key) == ["main", "subagent", "workflow", "auxiliary", "mystery"])
        #expect(data.series.map(\.label) == ["Main thread", "Subagents", "Workflows", "Auxiliary", "mystery"])
        #expect(data.series.map(\.slot) == [0, 1, 2, 3, 5])
        #expect(data.series[0].values == [3, 4])
    }

    @Test func tokenTypesFollowTheCostBreakdown() {
        let c1 = CostBreakdown(input: 1, output: 2, cacheRead: 30, cacheWrite5m: 5, cacheWrite1h: 4, webSearch: 0, total: 42)
        let c2 = CostBreakdown(input: 0.5, output: 1, cacheRead: 10, cacheWrite5m: 2, cacheWrite1h: 0, webSearch: 0, total: 13.5)
        let r = report([day("2026-10-08", cost: c1), day("2026-10-09", cost: c2)])
        let data = UsageChartData.build(report: r, breakdown: .tokenType, calendar: london)
        // Fixed order; web search is left out when it's zero everywhere.
        #expect(data.series.map(\.key) == ["cacheRead", "cacheWrite5m", "cacheWrite1h", "output", "input"])
        #expect(data.series.map(\.label) == ["Cache reads", "Cache writes 5m", "Cache writes 1h", "Output", "Input"])
        #expect(data.series[0].values == [30, 10])
        #expect(data.series[2].values == [4, 0])
        #expect(data.days.map(\.total) == [42, 13.5])
        // The stack adds up to the day's total.
        for i in data.days.indices {
            #expect(abs(data.series.reduce(0) { $0 + $1.values[i] } - data.days[i].total) < 1e-9)
        }
        let withSearch = CostBreakdown(input: 1, output: 1, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0.03, total: 3.03)
        let searched = UsageChartData.build(report: report([day("2026-10-09", cost: withSearch)]), breakdown: .tokenType, calendar: london)
        #expect(searched.series.last?.key == "webSearch")
        #expect(searched.series.last?.label == "Web search")
    }

    @Test func emptyDaysAreZeroBarsAndGapsAreFilled() {
        let r = report([day("2026-10-06", models: ["opus": 4]), day("2026-10-09", models: ["opus": 2])])
        let data = UsageChartData.build(report: r, breakdown: .model, calendar: london)
        #expect(data.days.map(\.key) == ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"])
        #expect(data.days.map(\.total) == [4, 0, 0, 2])
        #expect(data.series[0].values == [4, 0, 0, 2])
        #expect(!data.isEmpty)
        // A day the CLI listed with no usage is a zero bar too.
        let quiet = UsageChartData.build(report: report([day("2026-10-08"), day("2026-10-09", models: ["opus": 1])]), breakdown: .model, calendar: london)
        #expect(quiet.days.map(\.total) == [0, 1])
    }

    @Test func nothingToDrawIsEmpty() {
        #expect(UsageChartData.build(report: report([]), breakdown: .model, calendar: london).isEmpty)
        let zeros = report([day("2026-10-08"), day("2026-10-09")])
        for b in ChartBreakdown.allCases {
            let data = UsageChartData.build(report: zeros, breakdown: b, calendar: london)
            #expect(data.isEmpty, "\(b)")
            #expect(data.days.count == 2)
        }
    }

    @Test func anOlderCLIWithoutDaySplitsChartsDayTotals() {
        let r = report([day("2026-10-08", models: ["opus": 3], split: false), day("2026-10-09", models: ["opus": 5], split: false)])
        let data = UsageChartData.build(report: r, breakdown: .model, calendar: london)
        #expect(data.splitMissing)
        #expect(data.series.map(\.label) == ["All models"])
        #expect(data.series[0].values == [3, 5])
        // Token type needs no split.
        #expect(!UsageChartData.build(report: r, breakdown: .tokenType, calendar: london).splitMissing)
    }

    @Test func findsTheDayUnderThePointer() throws {
        let data = UsageChartData.build(report: report([day("2026-10-08", models: ["a": 1]), day("2026-10-09", models: ["a": 1])]), breakdown: .model, calendar: london)
        let noon = try #require(london.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 12)))
        #expect(data.dayIndex(containing: noon, calendar: london) == 1)
        #expect(data.dayIndex(containing: noon.addingTimeInterval(-86_400 * 5), calendar: london) == nil)
        #expect(data.dayIndex(containing: nil, calendar: london) == nil)
        #expect(data.dayIndex(key: "2026-10-08") == 0)
    }

    /// Where a clock change skips midnight, that day starts at 01:00. Every later day must still find its row,
    /// and the last day must still be drawn.
    @Test(arguments: [
        ("America/Santiago", 2026, 9, 1, 9),
        ("America/Havana", 2026, 3, 5, 12),
        ("Atlantic/Azores", 2026, 3, 25, 31),
        ("America/Santiago", 2026, 4, 1, 9),
        ("Europe/London", 2026, 3, 25, 31),
    ])
    func daysSurviveAClockChangeAtMidnight(zone: String, year: Int, month: Int, from: Int, to: Int) throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: zone))
        let keys = (from...to).map { String(format: "%04d-%02d-%02d", year, month, $0) }
        let r = report(keys.enumerated().map { i, k in day(k, models: ["a": Double(i + 1)]) })
        let data = UsageChartData.build(report: r, breakdown: .model, calendar: cal)
        #expect(data.days.map(\.key) == keys)
        #expect(data.series.first?.values == keys.indices.map { Double($0 + 1) })
        #expect(data.days.map(\.total) == keys.indices.map { Double($0 + 1) })
        for (i, d) in data.days.enumerated() {
            #expect(d.date == cal.startOfDay(for: d.date))
            // The pointer anywhere in the day finds it.
            #expect(data.dayIndex(containing: d.date.addingTimeInterval(11 * 3600), calendar: cal) == i)
            if i + 1 < data.days.count {
                #expect(DayKey.nextDay(d.date, calendar: cal) == data.days[i + 1].date)
            }
        }
        // A gap across the change is filled with an empty day, not lost.
        let gappy = UsageChartData.build(report: report([day(keys[0], models: ["a": 1]), day(keys[keys.count - 1], models: ["a": 2])]), breakdown: .model, calendar: cal)
        #expect(gappy.days.map(\.key) == keys)
        #expect(gappy.days.last?.total == 2)
    }

    @Test func dayKeysParseStrictly() {
        #expect(DayKey.date("2026-10-09", calendar: london).map { DayKey.key($0, calendar: london) } == "2026-10-09")
        #expect(DayKey.date("2026-02-31", calendar: london) == nil)
        #expect(DayKey.date("2026-13-01", calendar: london) == nil)
        #expect(DayKey.date("yesterday", calendar: london) == nil)
        #expect(DayKey.date("2026-10", calendar: london) == nil)
    }

    @Test func theSyntheticFixtureCharts() throws {
        let s = try TestPaths.loadSnapshot()
        let data = UsageChartData.build(report: s.report, breakdown: .model, calendar: london)
        #expect(data.days.count == s.report.byDay.count)
        #expect(data.series.first?.slot == 0)
        // Every day's stack matches its total (the fixture's byModel rows add up to the day).
        for (i, d) in data.days.enumerated() {
            #expect(abs(data.series.reduce(0) { $0 + $1.values[i] } - d.total) < 0.01, "\(d.key)")
        }
        // The fixture's unpriced model has no cost to draw.
        #expect(data.omittedZeroSeries.contains("gpt-5.5-codex"))
    }

    @MainActor
    @Test func theStoreKeepsModelColoursAcrossReports() {
        let store = SignalboxStore(clock: { date("2026-10-09T14:30:00Z") })
        let first = Report(generatedAt: date("2026-10-09T14:30:00Z"), byModel: [
            GroupTotals(key: "opus", cost: CostBreakdown(total: 50)),
            GroupTotals(key: "sonnet", cost: CostBreakdown(total: 5)),
            GroupTotals(key: "unpriced", cost: CostBreakdown(total: 0)),
        ])
        store.handle(.message(.report(at: nil, days: 7, first)))
        #expect(store.modelSlots.slot(for: "opus") == 0)
        #expect(store.modelSlots.slot(for: "sonnet") == 1)
        #expect(store.modelSlots.slot(for: "unpriced") == nil)
        // Today: only a new model, now the biggest. The others keep their colours; it takes the next one.
        let second = Report(generatedAt: date("2026-10-09T14:31:00Z"), byModel: [
            GroupTotals(key: "haiku", cost: CostBreakdown(total: 80)),
            GroupTotals(key: "sonnet", cost: CostBreakdown(total: 1)),
        ])
        store.handle(.message(.report(at: nil, days: 1, second)))
        #expect(store.modelSlots.slot(for: "opus") == 0)
        #expect(store.modelSlots.slot(for: "sonnet") == 1)
        #expect(store.modelSlots.slot(for: "haiku") == 2)
    }
}

@Suite("Calendar-day ranges")
struct RangeLabelTests {
    /// Interval formats use thin spaces around the dash; compare with plain ones.
    func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{2009}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    func d(_ y: Int, _ m: Int, _ day: Int) -> Date {
        london.date(from: DateComponents(year: y, month: m, day: day))!
    }

    @Test func pickerAndTitlesSayCalendarDays() {
        #expect(UsageRange.allCases.map(\.label) == ["Today", "7 days", "30 days"])
        #expect(UsageRange.describe(days: 1) == "Today")
        #expect(UsageRange.describe(days: 7) == "7 days")
        #expect(UsageRange.describe(days: 14) == "14 days")
    }

    @Test func spansReadTheLocaleWay() {
        let gb = Locale(identifier: "en_GB")
        let week = DaySpan(first: d(2026, 10, 3), last: d(2026, 10, 9))
        #expect(plain(Fmt.daySpan(week, calendar: london, locale: gb)) == "3 – 9 Oct")
        #expect(plain(Fmt.daySpan(week, calendar: london, locale: Locale(identifier: "en_US"))) == "Oct 3 – 9")
        #expect(plain(Fmt.daySpan(DaySpan(first: d(2026, 9, 28), last: d(2026, 10, 4)), calendar: london, locale: gb)) == "28 Sept – 4 Oct"
            || plain(Fmt.daySpan(DaySpan(first: d(2026, 9, 28), last: d(2026, 10, 4)), calendar: london, locale: gb)) == "28 Sep – 4 Oct")
        #expect(plain(Fmt.daySpan(DaySpan(first: d(2026, 12, 28), last: d(2027, 1, 3)), calendar: london, locale: gb)) == "28 Dec 2026 – 3 Jan 2027")
        #expect(Fmt.daySpan(DaySpan(first: d(2026, 10, 9), last: d(2026, 10, 9)), calendar: london, locale: gb) == "Fri 9 Oct")
        #expect(plain(Fmt.rangeTitle(days: 7, span: week, calendar: london, locale: gb)) == "7 days · 3 – 9 Oct")
        #expect(Fmt.rangeTitle(days: 7, span: nil) == "7 days")
    }

    @Test func aReportsSpanComesFromItsDays() {
        let r = report([day("2026-10-03"), day("2026-10-04"), day("2026-10-09")])
        #expect(r.daySpan(calendar: london) == DaySpan(first: d(2026, 10, 3), last: d(2026, 10, 9)))
    }

    @Test func withoutDaysTheRangeEndIsExclusive() {
        // Seven calendar days: since local midnight six days ago, until midnight tonight (exclusive).
        let r = report([], range: DateRange(since: d(2026, 10, 3), until: d(2026, 10, 10)))
        #expect(r.daySpan(calendar: london) == DaySpan(first: d(2026, 10, 3), last: d(2026, 10, 9)))
        // A watch report ends "now", part way through today.
        let live = report([], range: DateRange(since: d(2026, 10, 9), until: d(2026, 10, 9).addingTimeInterval(14.5 * 3600)))
        #expect(live.daySpan(calendar: london)?.isSingleDay == true)
        #expect(report([]).daySpan(calendar: london) == nil)
    }

    @Test func axisLabels() {
        let gb = Locale(identifier: "en_GB")
        #expect(Fmt.axisDay(d(2026, 10, 9), dayCount: 7, calendar: london, locale: gb) == "Fri 9")
        #expect(Fmt.axisDay(d(2026, 10, 9), dayCount: 30, calendar: london, locale: gb) == "9 Oct")
        #expect(Fmt.usdAxis(0, axisMax: 100) == "$0")
        #expect(Fmt.usdAxis(50, axisMax: 100) == "$50")
        #expect(Fmt.usdAxis(1200, axisMax: 2000) == "$1.2K")
        #expect(Fmt.usdAxis(0.25, axisMax: 1) == "$0.25")
    }
}
