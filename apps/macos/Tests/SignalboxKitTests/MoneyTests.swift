import Foundation
import Testing
@testable import SignalboxKit

@Suite("Currency and plan value")
struct MoneyTests {
    static let usdCases: [Double?] = [nil, .nan, 0, 0.004, 3.17, 1234.5, 99.994, -2.5, 1_234_567.891]

    @Test(arguments: usdCases)
    func usdMatchesTheExistingFormatters(value: Double?) {
        let m = Money.usd
        #expect(m.amount(value) == Fmt.usd(value))
        #expect(m.headline(value) == Fmt.usdHeadline(value))
        #expect(!m.isConverted)
        #expect(m.footnote() == nil)
    }

    @Test func usdRangeAndAxisMatch() {
        let m = Money.usd
        #expect(m.headlineRange(1697.2, 1920.4) == Fmt.usdHeadlineRange(1697.2, 1920.4))
        #expect(m.headlineRange(938.32, 938.32) == "$938")
        #expect(m.headlineRange(nil, 10) == "—")
        for (v, axisMax) in [(0.0, 100.0), (50, 100), (1200, 2000), (2.5, 4), (0.5, 3)] {
            #expect(m.axis(v, axisMax: axisMax) == Fmt.usdAxis(v, axisMax: axisMax))
        }
    }

    @Test func gbpAtTheUsersRate() {
        let asOf = date("2026-10-01T12:00:00Z")
        let m = Money(currency: .gbp, rate: 0.79, rateAsOf: asOf)
        #expect(m.isConverted)
        #expect(m.convert(100) == 79)
        #expect(m.amount(1000) == "£790.00")
        #expect(m.amount(2500) == "£1,975.00")
        #expect(m.amount(0.001) == "<£0.01")
        #expect(m.amount(nil) == "—")
        #expect(m.headline(483.39) == "£382")
        #expect(m.headline(42.1) == "£33.26")
        #expect(m.headlineRange(551.07, 623.58) == "£435–£493")
        #expect(m.rateText == "1 USD = 0.79 GBP")
        let note = m.footnote(locale: Locale(identifier: "en_GB"))
        #expect(note == "Converted at your rate: 1 USD = 0.79 GBP (as of 1 Oct 2026)")
        // Chart values are converted once when the chart is built; display() only formats.
        #expect(m.display(79) == "£79.00")
        #expect(m.axis(0, axisMax: 100) == "£0")
        #expect(m.axis(50, axisMax: 100) == "£50")
        #expect(m.axis(1500, axisMax: 2000) == "£1.5K")
        #expect(m.axis(2.5, axisMax: 4) == "£2.50")
    }

    @Test func eurAtTheUsersRate() {
        let m = Money(currency: .eur, rate: 0.92)
        #expect(m.amount(1000) == "€920.00")
        #expect(m.headline(1000) == "€920")
        #expect(m.footnote() == "Converted at your rate: 1 USD = 0.92 EUR")
    }

    @Test func noUsableRateMeansUSD() {
        #expect(Money(currency: .gbp, rate: nil) == .usd)
        #expect(Money(currency: .gbp, rate: 0) == .usd)
        #expect(Money(currency: .eur, rate: -1) == .usd)
        #expect(Money(currency: .eur, rate: .infinity) == .usd)
        #expect(Money(currency: .usd, rate: 0.5).rate == 1)
    }

    @Test func rateStrings() {
        #expect(Money.rateString(0.79) == "0.79")
        #expect(Money.rateString(0.81234) == "0.8123")
        #expect(Money.rateString(1) == "1")
        #expect(Money.rateString(1.5) == "1.5")
    }

    @Test func chartValuesScaleForTheAxis() throws {
        let report = try TestPaths.loadSnapshot().report
        let usd = UsageChartData.build(report: report, breakdown: .tokenType)
        let gbp = usd.scaled(by: 0.79)
        #expect(gbp.days.count == usd.days.count)
        #expect(abs(gbp.maxDayTotal - usd.maxDayTotal * 0.79) < 1e-9)
        #expect(abs(gbp.series[0].total - usd.series[0].total * 0.79) < 1e-9)
        #expect(gbp.series.map(\.label) == usd.series.map(\.label))
        #expect(usd.scaled(by: 1) == usd)
        #expect(usd.scaled(by: .nan) == usd)
    }

    // MARK: Plan value

    func report(recorded: Double) -> Report {
        Report(generatedAt: date("2026-10-09T14:30:00Z"), totals: ReportTotals(cost: CostBreakdown(total: recorded)),
               estimate: ReportEstimate(recordedUsd: recorded, estimatedLowUsd: recorded * 1.1, estimatedHighUsd: recorded * 1.2))
    }

    @Test func planValueNeedsAPlanAndAThirtyDayReport() {
        let plan = PlanPrice(amount: 200, currency: .usd)
        #expect(PlanValue.compute(report: report(recorded: 840), days: 30, plan: nil, rates: [:]) == .notConfigured)
        #expect(PlanValue.compute(report: report(recorded: 840), days: 7, plan: plan, rates: [:]) == .needsThirtyDays)
        #expect(PlanValue.compute(report: nil, days: 30, plan: plan, rates: [:]) == .needsThirtyDays)
        #expect(PlanValue.compute(report: report(recorded: 840), days: 30, plan: plan, rates: [:]) == .value(multiple: 4.2, listPrice: 840, plan: plan!))
    }

    @Test func planValueInAnotherCurrencyUsesItsRate() throws {
        let plan = try #require(PlanPrice(amount: 180, currency: .gbp))
        #expect(PlanValue.compute(report: report(recorded: 1000), days: 30, plan: plan, rates: [:]) == .needsRate(.gbp))
        guard case let .value(m, list, _) = PlanValue.compute(report: report(recorded: 1000), days: 30, plan: plan, rates: [.gbp: 0.81]) else {
            Issue.record("expected a value")
            return
        }
        #expect(abs(list - 810) < 1e-9)
        #expect(abs(m - 4.5) < 1e-9)
    }

    @Test func planPricesMustBePositive() {
        #expect(PlanPrice(amount: nil, currency: .usd) == nil)
        #expect(PlanPrice(amount: 0, currency: .usd) == nil)
        #expect(PlanPrice(amount: .nan, currency: .usd) == nil)
    }

    @Test func multiples() {
        #expect(PlanValue.multipleText(4.2) == "4.2×")
        #expect(PlanValue.multipleText(0.43) == "0.4×")
        #expect(PlanValue.multipleText(0.02) == "<0.1×")
        #expect(PlanValue.multipleText(0) == "0.0×")
        #expect(PlanValue.multipleText(12.6) == "13×")
        #expect(PlanValue.multipleText(.nan) == "—")
    }
}
