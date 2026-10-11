import Charts
import SignalboxKit
import SwiftUI

/// The Usage screen's daily spend chart: a breakdown picker, stacked bars, a legend and notes.
struct UsageChartSection: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money
    let report: Report
    let days: Int

    var body: some View {
        @Bindable var nav = nav
        // Converted once here, so the axis ticks land on round numbers in the display currency.
        let data = UsageChartData.build(report: report, breakdown: nav.chartBreakdown, modelSlots: store.modelSlots).scaled(by: money.rate)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(days == 1 ? "Spend today" : "Spend per day")
                        .font(.headline)
                    Text("List-price equivalent\(money.isConverted ? " in \(money.currency.code), converted at your rate" : ""), stacked by \(nav.chartBreakdown.title.lowercased())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Picker("Stack by", selection: $nav.chartBreakdown) {
                    ForEach(ChartBreakdown.allCases) { b in Text(b.title).tag(b) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("What each bar is split by")
            }
            if data.isEmpty {
                ChartEmptyState(days: days, unpricedOnly: report.totals.responses > 0)
            } else {
                UsageBarChart(data: data, singleDay: days == 1)
                    .frame(height: days == 1 ? 170 : 220)
                ChartLegend(series: data.series)
                ForEach(chartNotes(data), id: \.self) { note in
                    Label(note, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator.opacity(0.6)))
    }

    private func chartNotes(_ data: UsageChartData) -> [String] {
        var notes: [String] = []
        if days == 1 {
            notes.append("Today so far, since local midnight. The report splits spend by day, not by hour; pick 7 or 30 days for a daily chart.")
        }
        if data.splitMissing {
            notes.append("This CLI doesn't split each day by \(data.breakdown.title.lowercased()); showing day totals. Token type works with any CLI.")
        }
        if !data.omittedZeroSeries.isEmpty {
            let names = data.omittedZeroSeries.joined(separator: ", ")
            notes.append("Not charted (no cost in this window, e.g. no price row): \(names).")
        }
        return notes
    }
}

/// What the renderer pins as the hovered day (a "YYYY-MM-DD" key), so snapshots show the callout.
private struct SnapshotChartSelectionKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var snapshotChartSelection: String? {
        get { self[SnapshotChartSelectionKey.self] }
        set { self[SnapshotChartSelectionKey.self] = newValue }
    }
}

struct UsageBarChart: View {
    @Environment(\.money) private var money
    let data: UsageChartData
    var singleDay = false
    /// The hovered day's key. A day, not the pointer's instant, so the chart redraws only when the day changes.
    @State private var hoveredKey: String?
    /// The plot area in the chart's own coordinates, for mapping the pointer to a day.
    @State private var plotFrame: CGRect = .zero
    @Environment(\.snapshotChartSelection) private var pinnedSelection

    private static let day: TimeInterval = 86_400

    /// The start of the next calendar day (23 or 25 hours away on a clock change).
    private static func nextDay(_ date: Date) -> Date {
        DayKey.nextDay(date) ?? date.addingTimeInterval(day)
    }

    /// Points the hover at the day containing `date`; a no-op while the pointer stays inside the same day.
    private func hover(_ date: Date?) {
        let key = data.dayIndex(containing: date).map { data.days[$0].key }
        if key != hoveredKey { hoveredKey = key }
    }

    /// chartXSelection reports the instant under the pointer; this snaps it to a day before it reaches State.
    private var selection: Binding<Date?> {
        Binding(
            get: { hoveredKey.flatMap { data.dayIndex(key: $0) }.map { data.days[$0].date } },
            set: { hover($0) }
        )
    }

    var body: some View {
        let selected = hoveredKey.flatMap { data.dayIndex(key: $0) } ?? pinnedSelection.flatMap { data.dayIndex(key: $0) }
        let axisMax = data.maxDayTotal
        Chart {
            ForEach(data.bars) { bar in
                BarMark(
                    x: .value("Day", bar.date, unit: .day),
                    y: .value("Cost", bar.value),
                    width: singleDay ? .fixed(64) : .ratio(0.62)
                )
                .foregroundStyle(by: .value("Series", bar.seriesLabel))
                .opacity(selected == nil || selected == bar.dayIndex ? 1 : 0.4)
                .accessibilityLabel(Fmt.calloutDay(bar.date))
                .accessibilityValue("\(bar.seriesLabel), \(money.display(bar.value))")
            }
            if let selected {
                RuleMark(x: .value("Day", data.days[selected].date, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.45))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .accessibilityHidden(true)
            }
        }
        .chartForegroundStyleScale(domain: data.series.map(\.label), range: data.series.map { Theme.series($0.slot) })
        .chartLegend(.hidden)
        .chartXSelection(value: selection)
        .chartXScale(domain: xDomain)
        .chartYScale(domain: .automatic(includesZero: true))
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(money.axis(v, axisMax: axisMax))
                            .monospacedDigit()
                    }
                }
            }
        }
        .chartXAxis {
            // Ticks at midday, so each label sits under its bar (a "centered" label would need a next tick).
            // With narrow bars (more than ten days) a centred label under the last bar sticks out past the plot
            // and Swift Charts drops it, so that one is right-aligned to the plot's end instead.
            let dates = axisDates
            let trailingLast = data.days.count > 10
            AxisMarks(values: dates.indices.map { i in
                trailingLast && i == dates.count - 1 ? Self.nextDay(dates[i]) : dates[i].addingTimeInterval(Self.nextDay(dates[i]).timeIntervalSince(dates[i]) / 2)
            }) { value in
                let isLast = trailingLast && value.index == value.count - 1
                // No tick under the last label: it would sit at the plot's end, not under the bar.
                if !isLast { AxisTick(length: 3) }
                // Explicit spacing (3 more where the tick is missing), so the right-aligned label sits on the
                // same line as the centred ones.
                AxisValueLabel(anchor: isLast ? .topTrailing : .top, collisionResolution: .greedy, horizontalSpacing: 0, verticalSpacing: isLast ? 8 : 5) {
                    if let d = isLast ? dates.last : value.as(Date.self) {
                        Text(singleDay ? Fmt.calloutDay(d) : Fmt.axisDay(d, dayCount: data.days.count))
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geo in
                let plotRect = proxy.plotFrame.map { geo[$0] } ?? .zero
                Color.clear
                    .onAppear { plotFrame = plotRect }
                    .onChange(of: plotRect) { _, new in plotFrame = new }
                if let selected, let plotAnchor = proxy.plotFrame {
                    let plot = geo[plotAnchor]
                    let start = proxy.position(forX: data.days[selected].date) ?? 0
                    let end = proxy.position(forX: Self.nextDay(data.days[selected].date)) ?? start
                    let center = plot.minX + (start + end) / 2
                    let halfBar = singleDay ? 32 : abs(end - start) * 0.31
                    let width = geo.size.width
                    let top = plot.minY
                    ZStack(alignment: .topLeading) {
                        Color.clear
                        ChartCallout(data: data, dayIndex: selected)
                            .fixedSize()
                            .alignmentGuide(.leading) { d in
                                let gap: CGFloat = 10
                                let right = center + halfBar + gap
                                let left = center - halfBar - gap - d.width
                                let x = right + d.width <= width ? right : max(0, left)
                                return -x
                            }
                            .alignmentGuide(.top) { _ in -top }
                    }
                    .allowsHitTesting(false)
                }
            }
        }
        // chartXSelection handles clicks and drags; this follows the pointer. Hover isn't exclusive, so the two coexist.
        .onContinuousHover { phase in
            switch phase {
            case let .active(point): hover(date(atX: point.x))
            case .ended: hover(nil)
            }
        }
        .accessibilityChartDescriptor(UsageChartDescriptor(data: data, money: money))
    }

    /// The date under an x position in the chart's coordinates, or nil outside the plot.
    private func date(atX x: CGFloat) -> Date? {
        guard plotFrame.width > 0, x >= plotFrame.minX, x <= plotFrame.maxX else { return nil }
        let domain = xDomain
        let fraction = (x - plotFrame.minX) / plotFrame.width
        return domain.lowerBound.addingTimeInterval(domain.upperBound.timeIntervalSince(domain.lowerBound) * fraction)
    }

    /// Whole days, so every bar sits inside the plot.
    private var xDomain: ClosedRange<Date> {
        guard let first = data.days.first?.date, let last = data.days.last?.date else {
            return Date(timeIntervalSince1970: 0)...Date(timeIntervalSince1970: Self.day)
        }
        return first...Self.nextDay(last)
    }

    /// Every day for a week; for longer spans about eight labels, always including the last day.
    private var axisDates: [Date] {
        let n = data.days.count
        let step = n <= 10 ? 1 : Int((Double(n) / 7).rounded(.up))
        return data.days.indices.filter { (n - 1 - $0) % step == 0 }.map { data.days[$0].date }
    }
}

/// The hovered day: its total and each series' share, biggest first.
private struct ChartCallout: View {
    @Environment(\.money) private var money
    let data: UsageChartData
    let dayIndex: Int

    static let maxRows = 6

    var body: some View {
        let day = data.days[dayIndex]
        let split = data.split(dayIndex: dayIndex)
        let shown = split.prefix(Self.maxRows)
        let rest = split.dropFirst(Self.maxRows)
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(Fmt.calloutDay(day.date))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(money.display(day.total))
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            if split.isEmpty {
                Text("No usage")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 3) {
                    ForEach(Array(shown), id: \.series.key) { item in
                        GridRow {
                            SeriesSwatch(slot: item.series.slot)
                            Text(item.series.label)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: 200, alignment: .leading)
                            Text(money.display(item.value))
                                .monospacedDigit()
                                .gridColumnAlignment(.trailing)
                        }
                    }
                    if !rest.isEmpty {
                        GridRow {
                            Color.clear.frame(width: 8, height: 8)
                            Text("\(rest.count) more")
                                .foregroundStyle(.secondary)
                            Text(money.display(rest.reduce(0) { $0 + $1.value }))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.caption)
            }
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    }
}

/// A rounded square in a series colour.
struct SeriesSwatch: View {
    let slot: Int?
    var size: CGFloat = 9

    var body: some View {
        RoundedRectangle(cornerRadius: 2.5, style: .continuous)
            .fill(Theme.series(slot))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Swatch, name and total per series; wraps onto more lines when there are many.
private struct ChartLegend: View {
    @Environment(\.money) private var money
    let series: [UsageChartData.Series]

    var body: some View {
        FlowLayout(spacing: 16, lineSpacing: 6) {
            ForEach(series) { s in
                HStack(spacing: 6) {
                    SeriesSwatch(slot: s.slot)
                    Text(s.label)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 260, alignment: .leading)
                        .fixedSize(horizontal: true, vertical: false)
                    Text(money.display(s.total))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
                .help(s.label)
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Legend")
    }
}

private struct ChartEmptyState: View {
    let days: Int
    /// There were responses, but none had a price row: usage exists, it just can't be drawn in dollars.
    var unpricedOnly = false

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "chart.bar")
                .font(.title2)
                .foregroundStyle(.tertiary)
            Text(unpricedOnly ? "No priced spend to chart" : days == 1 ? "No usage recorded today" : "No usage recorded in these \(days) days")
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text(unpricedOnly ? "Every response here is on a model with no price row; the table below has its tokens." : "Bars appear once an agent records a response.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 140)
        .accessibilityElement(children: .combine)
    }
}

/// A left-to-right layout that wraps onto new lines (legends, tags).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for (index, size) in row.items {
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var items: [(Int, CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (i, view) in subviews.enumerated() {
            var size = view.sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            if !row.items.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append((i, size))
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// The chart for VoiceOver's audio graphs and data table: days by series, in the display currency.
struct UsageChartDescriptor: AXChartDescriptorRepresentable {
    let data: UsageChartData
    var money: Money = .usd
    var title = "Spend per day"

    func makeChartDescriptor() -> AXChartDescriptor {
        let labels = data.days.map { Fmt.calloutDay($0.date) }
        let x = AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: labels)
        let y = AXNumericDataAxisDescriptor(title: "Cost, list-price equivalent", range: 0...max(data.maxDayTotal, 0.01), gridlinePositions: []) { [money] in money.display($0) }
        let series = data.series.map { s in
            AXDataSeriesDescriptor(name: s.label, isContinuous: false, dataPoints: data.days.indices.map { i in
                AXDataPoint(x: labels[i], y: s.values[i])
            })
        }
        let total = data.days.reduce(0) { $0 + $1.total }
        let peak = data.days.max { $0.total < $1.total }
        var summary = "\(money.display(total)) over \(data.days.count) \(data.days.count == 1 ? "day" : "days"), stacked by \(data.breakdown.title.lowercased())."
        if let peak, data.days.count > 1 { summary += " Highest: \(Fmt.calloutDay(peak.date)), \(money.display(peak.total))." }
        return AXChartDescriptor(title: title, summary: summary, xAxis: x, yAxis: y, additionalAxes: [], series: series)
    }
}

/// Spend per day as a small line, for the menu bar popover. Expects more than one day.
struct SpendSparkline: View {
    @Environment(\.money) private var money
    let days: [UsageChartData.Day]

    var body: some View {
        let peak = max(days.map(\.total).max() ?? 0, 0.01)
        let color = Theme.series(0)
        Chart(days) { d in
            AreaMark(x: .value("Day", d.date, unit: .day), y: .value("Spend", d.total))
                .interpolationMethod(.monotone)
                .foregroundStyle(LinearGradient(colors: [color.opacity(0.32), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("Day", d.date, unit: .day), y: .value("Spend", d.total))
                .interpolationMethod(.monotone)
                .foregroundStyle(color)
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            if d.id == days.last?.id {
                PointMark(x: .value("Day", d.date, unit: .day), y: .value("Spend", d.total))
                    .foregroundStyle(color)
                    .symbolSize(18)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartYScale(domain: 0...peak * 1.1)
        .accessibilityChartDescriptor(SparklineDescriptor(days: days, money: money))
    }
}

private struct SparklineDescriptor: AXChartDescriptorRepresentable {
    let days: [UsageChartData.Day]
    let money: Money

    func makeChartDescriptor() -> AXChartDescriptor {
        let labels = days.map { Fmt.calloutDay($0.date) }
        let x = AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: labels)
        let y = AXNumericDataAxisDescriptor(title: "Spend", range: 0...max(days.map(\.total).max() ?? 0, 0.01), gridlinePositions: []) { [money] in money.amount($0) }
        let series = AXDataSeriesDescriptor(name: "Spend per day", isContinuous: true, dataPoints: days.indices.map { AXDataPoint(x: labels[$0], y: days[$0].total) })
        return AXChartDescriptor(title: "Spend per day", summary: "List-price equivalent spend on each of these \(days.count) calendar days, today included.", xAxis: x, yAxis: y, additionalAxes: [], series: [series])
    }
}
