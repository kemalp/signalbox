import Foundation
import SignalboxKit

/// Other report windows derived from a (synthetic) fixture, so the renderer can show the Today and 30-day
/// layouts without a second fixture file. Rendering only: the numbers are scaled copies, not real data.
enum SyntheticReports {
    /// Shown in "About these numbers" on every derived render so a scaled copy can't pass for real usage.
    static let note = "SYNTHETIC RENDER: these numbers are scaled from the fixture's own days, not real usage. Pass --fixture-today / --fixture-30d for real windows."

    /// The fixture's last day on its own, as a "Today" report.
    static func today(_ s: Snapshot, calendar: Calendar = .current) -> Snapshot {
        guard let last = s.report.byDay.last else { return s }
        let r = s.report
        let f = r.totals.cost.total > 0 ? last.cost.total / r.totals.cost.total : 0
        var report = r
        report.byDay = [last]
        report.totals = totals(last.tokens, last.cost, responses: last.responses, placeholders: last.placeholderResponses, from: r.totals)
        report.byModel = last.byModel ?? r.byModel.map { scaled($0, f) }
        report.byKind = last.byKind ?? r.byKind.map { scaled($0, f) }
        report.byAgent = single(r.byAgent, last) ?? r.byAgent.map { scaled($0, f) }
        report.byProject = single(r.byProject, last) ?? r.byProject.map { scaled($0, f) }
        report.estimate = r.estimate.map { ReportEstimate(recordedUsd: last.cost.total, estimatedLowUsd: $0.estimatedLowUsd * f, estimatedHighUsd: $0.estimatedHighUsd * f, method: $0.method) }
        if let since = DayKey.date(last.key, calendar: calendar) {
            report.range = DateRange(since: since, until: r.range?.until ?? s.generatedAt)
        }
        report.notes.insert(note, at: 0)
        return Snapshot(generatedAt: s.generatedAt, days: 1, fleet: s.fleet, report: report, health: s.health)
    }

    /// Thirty days ending on the fixture's last day: its days repeated at varying scale, with two empty days.
    static func month(_ s: Snapshot, calendar: Calendar = .current) -> Snapshot {
        let src = s.report.byDay
        guard let lastKey = src.last?.key, let lastDay = DayKey.date(lastKey, calendar: calendar), !src.isEmpty else { return s }
        var days: [GroupTotals] = []
        for i in 0..<30 {
            guard let date = calendar.date(byAdding: .day, value: i - 29, to: lastDay) else { continue }
            // Day 29 is the fixture's last day; earlier days cycle back through the fixture.
            let n = src.count
            let from = src[((i - 29 + n - 1) % n + n) % n]
            let factor = i == 8 || i == 15 ? 0 : 0.35 + 0.65 * abs(sin(Double(i) * 1.7))
            days.append(scaled(from, i == 29 ? 1 : factor, key: DayKey.key(date, calendar: calendar)))
        }
        let r = s.report
        let weekTotal = src.reduce(0) { $0 + $1.cost.total }
        let monthCost = days.reduce(CostBreakdown()) { add($0, $1.cost) }
        let monthTokens = days.reduce(TokenCounts()) { add($0, $1.tokens) }
        let f = weekTotal > 0 ? monthCost.total / weekTotal : 0
        var report = r
        report.byDay = days
        report.totals = totals(monthTokens, monthCost, responses: days.reduce(0) { $0 + $1.responses }, placeholders: days.reduce(0) { $0 + $1.placeholderResponses }, from: r.totals)
        report.byModel = r.byModel.map { scaled($0, f) }
        report.byKind = r.byKind.map { scaled($0, f) }
        let whole = GroupTotals(key: "", tokens: monthTokens, cost: monthCost, responses: report.totals.responses,
                                placeholderResponses: report.totals.placeholderResponses, unpricedTokens: report.totals.unpricedTokens,
                                unpricedModels: report.totals.unpricedModels)
        report.byAgent = single(r.byAgent, whole) ?? r.byAgent.map { scaled($0, f) }
        report.byProject = single(r.byProject, whole) ?? r.byProject.map { scaled($0, f) }
        report.estimate = r.estimate.map { ReportEstimate(recordedUsd: monthCost.total, estimatedLowUsd: $0.estimatedLowUsd * f, estimatedHighUsd: $0.estimatedHighUsd * f, method: $0.method) }
        if let first = days.first.flatMap({ DayKey.date($0.key, calendar: calendar) }) {
            report.range = DateRange(since: first, until: r.range?.until ?? s.generatedAt)
        }
        report.notes.insert(note, at: 0)
        return Snapshot(generatedAt: s.generatedAt, days: 30, fleet: s.fleet, report: report, health: s.health)
    }

    /// A grouping with one row (one agent, one project) is the whole window, so it takes the window's own
    /// totals instead of a scaled copy that would disagree with the tiles above the table.
    private static func single(_ rows: [GroupTotals], _ whole: GroupTotals) -> [GroupTotals]? {
        guard rows.count == 1, let key = rows.first?.key else { return nil }
        return [GroupTotals(key: key, tokens: whole.tokens, cost: whole.cost, responses: whole.responses,
                            placeholderResponses: whole.placeholderResponses, unpricedTokens: whole.unpricedTokens, unpricedModels: whole.unpricedModels)]
    }

    private static func totals(_ t: TokenCounts, _ c: CostBreakdown, responses: Int, placeholders: Int, from base: ReportTotals) -> ReportTotals {
        let prompt = t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input
        let f = base.cost.total > 0 ? c.total / base.cost.total : 0
        return ReportTotals(tokens: t, cost: c, responses: responses, placeholderResponses: placeholders, unpricedTokens: base.unpricedTokens * f,
                            unpricedModels: base.unpricedModels, processedTokens: t.processed, freshTokens: t.fresh,
                            cacheHitRatio: prompt > 0 ? t.cacheRead / prompt : 0, savedByCachingUsd: base.savedByCachingUsd * f)
    }

    static func scaled(_ g: GroupTotals, _ f: Double, key: String? = nil) -> GroupTotals {
        GroupTotals(key: key ?? g.key, tokens: scaled(g.tokens, f), cost: scaled(g.cost, f), responses: Int((Double(g.responses) * f).rounded()),
                    placeholderResponses: Int((Double(g.placeholderResponses) * f).rounded()), unpricedTokens: g.unpricedTokens * f, unpricedModels: g.unpricedModels,
                    byModel: g.byModel?.map { scaled($0, f) }, byKind: g.byKind?.map { scaled($0, f) })
    }

    private static func scaled(_ t: TokenCounts, _ f: Double) -> TokenCounts {
        TokenCounts(input: (t.input * f).rounded(), output: (t.output * f).rounded(), cacheRead: (t.cacheRead * f).rounded(),
                    cacheWrite5m: (t.cacheWrite5m * f).rounded(), cacheWrite1h: (t.cacheWrite1h * f).rounded())
    }

    private static func scaled(_ c: CostBreakdown, _ f: Double) -> CostBreakdown {
        CostBreakdown(input: c.input * f, output: c.output * f, cacheRead: c.cacheRead * f, cacheWrite5m: c.cacheWrite5m * f,
                      cacheWrite1h: c.cacheWrite1h * f, webSearch: c.webSearch * f, total: c.total * f)
    }

    private static func add(_ a: CostBreakdown, _ b: CostBreakdown) -> CostBreakdown {
        CostBreakdown(input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
                      cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h, webSearch: a.webSearch + b.webSearch, total: a.total + b.total)
    }

    private static func add(_ a: TokenCounts, _ b: TokenCounts) -> TokenCounts {
        TokenCounts(input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
                    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m, cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h)
    }
}
