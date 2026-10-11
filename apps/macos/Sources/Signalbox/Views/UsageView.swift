import SignalboxKit
import SwiftUI

struct UsageView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(NavigationModel.self) private var nav
    @Environment(\.money) private var money

    var body: some View {
        DataGate(value: store.report, waitingFor: "the usage report") { report in
            UsageContent(report: report, days: store.reportDays ?? store.range.days)
                .opacity(store.isAwaitingReport ? 0.55 : 1)
                .animation(.easeInOut(duration: 0.2), value: store.isAwaitingReport)
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(scopes: [.report, .protocol]) }
        .navigationTitle("Usage")
        .navigationSubtitle(money.isConverted ? "\(Fmt.listPriceNote) · in \(money.currency.code) at your rate" : Fmt.listPriceNote)
        .toolbar {
            ToolbarItem(placement: .principal) {
                RangePicker()
            }
            CommonToolbar()
        }
    }
}

struct RangePicker: View {
    @Environment(SignalboxStore.self) private var store

    var body: some View {
        HStack(spacing: 8) {
            Picker("Range", selection: Binding(get: { store.range }, set: { store.select(range: $0) })) {
                ForEach(UsageRange.allCases) { r in
                    Text(r.label).tag(r)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .disabled(isFixture)
            .help(isFixture ? "Showing a saved snapshot; the range is fixed" : "Report window, in calendar days (Today starts at local midnight)")
            if store.isAwaitingReport, !isFixture {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading report")
            }
        }
    }

    private var isFixture: Bool {
        if case .fixture = store.connection { return true }
        return false
    }
}

private struct UsageContent: View {
    @Environment(NavigationModel.self) private var nav
    @Environment(SignalboxStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(\.money) private var money
    let report: Report
    let days: Int

    var body: some View {
        @Bindable var nav = nav
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                tiles
                if let note = money.footnote() {
                    Label("\(note). \(Fmt.listPriceNote).", systemImage: "arrow.left.arrow.right.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help("Signalbox never fetches exchange rates. Every figure is a USD list-price equivalent multiplied by the rate in Settings ▸ Display.")
                }
                UsageChartSection(report: report, days: days)
                // With no usage at all, the chart's empty state says so; an empty table under it would repeat it.
                if report.totals.responses > 0 || !report.byAgent.isEmpty || !report.byModel.isEmpty {
                    HStack {
                        Picker("Group", selection: $nav.usageGrouping) {
                            ForEach(UsageGrouping.allCases) { g in Text(g.title).tag(g) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .fixedSize()
                        Spacer()
                        ListPriceNote()
                    }
                    UsageTable(rows: rows(for: nav.usageGrouping), grouping: nav.usageGrouping)
                }
                notes
            }
            .padding(20)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(UsageRange.describe(days: days))
                .font(.title2.weight(.semibold))
            if let span = report.daySpan() {
                Text(Fmt.daySpan(span))
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .help(days == 1 ? "Since local midnight" : "Calendar days: today and the \(days - 1) days before it")
            }
            Spacer()
            Text("\(Fmt.count(report.totals.responses)) responses")
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private func estimateCaption(_ e: ReportEstimate) -> String {
        guard money.headline(e.estimatedLowUsd) == money.headline(e.estimatedHighUsd) else { return "Likely range, corrected for missing output" }
        // As in the CLI report: with no agent ledger to calibrate against, the estimate is the recorded figure.
        return abs(e.estimatedLowUsd - e.recordedUsd) < 0.005 ? "Equals recorded: no ledger to calibrate against" : "Corrected for missing output"
    }

    private var tiles: some View {
        let t = report.totals
        let e = report.estimate
        // Narrower tiles when the plan tile makes six, so it doesn't wrap onto a row of its own at the default size.
        let minimum: CGFloat = settings.plan == nil ? 172 : 150
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum, maximum: 400), spacing: 12)], spacing: 12) {
            StatTile(
                title: "Recorded",
                systemImage: "dollarsign.circle",
                value: money.headline(e?.recordedUsd ?? t.cost.total),
                caption: "Lower bound, from transcripts",
                help: "The sum of every recorded response priced at list price. Some output is missing from transcripts, so the real figure is higher."
            )
            StatTile(
                title: "Estimated",
                systemImage: "arrow.left.and.right.circle",
                value: e.map { money.headlineRange($0.estimatedLowUsd, $0.estimatedHighUsd) } ?? Fmt.dash,
                caption: e.map(estimateCaption) ?? "Likely range, corrected for missing output",
                help: e?.method
            )
            StatTile(
                title: "Tokens",
                systemImage: "number.circle",
                value: "\(Fmt.tokens(t.freshTokens)) fresh",
                caption: "of \(Fmt.tokens(t.processedTokens)) processed (incl. cache reads)",
                help: "Fresh = input + output + cache writes. Processed adds cache reads."
            )
            StatTile(
                title: "Cache hit",
                systemImage: "bolt.horizontal.circle",
                value: t.processedTokens > 0 ? Fmt.ratio(t.cacheHitRatio) : Fmt.dash,
                caption: "of prompt tokens read from cache"
            )
            StatTile(
                title: "Cache savings",
                systemImage: "leaf.circle",
                value: money.headline(t.savedByCachingUsd),
                caption: "Gross, vs. paying full input price",
                help: "cacheRead × (input price − cache-read price), at list price. Cache writes are not subtracted."
            )
            if let plan = settings.plan {
                PlanValueTile(value: PlanValue.compute(report: report, days: days, plan: plan, rates: settings.rates), plan: plan)
            }
        }
    }

    /// What the numbers mean and where they're incomplete, straight from the report.
    private var notes: some View {
        let t = report.totals
        let unpriced = t.unpricedModels
        return VStack(alignment: .leading, spacing: 8) {
            Text("About these numbers")
                .font(.headline)
            // The report usually says this itself; only add it when it doesn't.
            if !unpriced.isEmpty, !report.notes.contains(where: { note in unpriced.allSatisfy { note.contains($0) } }) {
                noteRow("exclamationmark.triangle.fill", Theme.warning,
                        "\(unpriced.joined(separator: ", ")) \(unpriced.count == 1 ? "has" : "have") no price row: \(Fmt.tokens(t.unpricedTokens)) tokens count as zero.")
            }
            if t.placeholderResponses > 0, !report.notes.contains(where: { $0.localizedCaseInsensitiveContains("placeholder") }) {
                noteRow("text.badge.minus", .secondary,
                        "\(Fmt.count(t.placeholderResponses)) of \(Fmt.count(t.responses)) responses kept a streaming placeholder, so their output tokens are a lower bound.")
            }
            ForEach(report.notes, id: \.self) { note in
                noteRow("info.circle", .secondary, note)
            }
            if !report.priceTables.isEmpty {
                noteRow("tag", .secondary, "Prices: \(Fmt.priceTablesNote(report.priceTables)). \(Fmt.listPriceNote).")
            }
            if let method = report.estimate?.method, !method.isEmpty {
                DisclosureGroup("How the estimate is calculated") {
                    Text(method)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                }
                .font(.callout)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func noteRow(_ symbol: String, _ color: Color, _ text: String) -> some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(color)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    private func rows(for grouping: UsageGrouping) -> [UsageRow] {
        let groups: [GroupTotals]
        switch grouping {
        case .agent: groups = report.byAgent
        case .model: groups = report.byModel
        case .kind: groups = report.byKind
        case .project: groups = report.byProject
        }
        let total = max(report.totals.cost.total, 0)
        return groups.map { g in
            UsageRow(
                id: g.key,
                swatch: swatch(g, grouping),
                name: displayName(g.key, grouping),
                fullName: g.key,
                cost: g.cost.total,
                share: total > 0 ? g.cost.total / total : 0,
                processed: g.tokens.processed,
                fresh: g.tokens.fresh,
                cacheRead: g.tokens.cacheRead,
                responses: g.responses,
                unpriced: g.hasUnpriced
            )
        }
    }

    /// The row's chart colour, so the table reads as the chart's legend: models by the app's colour registry,
    /// kinds by their fixed slots; rows the chart doesn't draw (no cost) get none.
    private func swatch(_ g: GroupTotals, _ grouping: UsageGrouping) -> UsageRow.Swatch {
        guard g.cost.total > 0 else { return .none }
        switch grouping {
        case .model: return .slot(store.modelSlots.slot(for: g.key))
        case .kind: return .slot(SeriesSlots.kinds.slot(for: g.key))
        case .agent, .project: return .none
        }
    }

    private func displayName(_ key: String, _ grouping: UsageGrouping) -> String {
        switch grouping {
        case .agent: Fmt.agentName(AgentID(rawValue: key))
        case .model: key
        case .kind: Fmt.kindLabel(key)
        case .project: Fmt.shortPath(key)
        }
    }
}

struct UsageRow: Identifiable, Hashable {
    enum Swatch: Hashable {
        case none
        /// A chart colour; a nil slot is the grey "Other".
        case slot(Int?)
    }

    let id: String
    let swatch: Swatch
    let name: String
    let fullName: String
    let cost: Double
    let share: Double
    let processed: Double
    let fresh: Double
    let cacheRead: Double
    let responses: Int
    let unpriced: Bool
}

private struct UsageTable: View {
    @Environment(\.money) private var money
    let rows: [UsageRow]
    let grouping: UsageGrouping
    @State private var sortOrder = [KeyPathComparator(\UsageRow.cost, order: .reverse)]

    static let limit = 10

    /// Header plus rows, so the table hugs its (at most ten) rows instead of filling the window with stripes.
    private static func height(rows: Int) -> CGFloat { 32 + 25 * CGFloat(max(rows, 1)) }

    var body: some View {
        let sorted = rows.sorted(using: sortOrder)
        let shown = Array(sorted.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 6) {
            if rows.isEmpty {
                ContentUnavailableView("No Usage in This Window", systemImage: "chart.bar", description: Text("No recorded responses in this range."))
                    .frame(maxWidth: .infinity, minHeight: 160)
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                table(shown)
                    .frame(height: Self.height(rows: shown.count))
            }
            if sorted.count > Self.limit {
                Text("Top \(Self.limit) of \(sorted.count) · \(money.amount(sorted.dropFirst(Self.limit).reduce(0) { $0 + $1.cost })) in the rest")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func table(_ shown: [UsageRow]) -> some View {
            Table(shown, sortOrder: $sortOrder) {
                TableColumn(grouping.title.replacingOccurrences(of: "By ", with: "").capitalized, value: \.name) { row in
                    HStack(spacing: 6) {
                        if case let .slot(slot) = row.swatch {
                            SeriesSwatch(slot: slot)
                        }
                        Text(row.name)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(row.fullName)
                            // Project folders are the user's own; agents, models and kinds read as is.
                            .privacySensitive(grouping == .project)
                        if row.unpriced {
                            Tag(text: "unpriced", color: Theme.warning, systemImage: "exclamationmark.triangle.fill")
                                .help(grouping == .model ? "No price row for this model: its tokens count as zero" : "Some of these tokens are on models with no price row and count as zero")
                        }
                    }
                }
                .width(min: 160, ideal: 260)

                TableColumn("Cost", value: \.cost) { row in
                    Text(money.amount(row.cost))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 80, ideal: 96)

                TableColumn("Share", value: \.share) { row in
                    HStack(spacing: 6) {
                        MeterBar(fraction: row.share, tint: Theme.accent, height: 4)
                            .frame(width: 40)
                        Text(Fmt.ratio(row.share, digits: 0))
                            .monospacedDigit()
                            .lineLimit(1)
                            .fixedSize()
                            .frame(minWidth: 40, alignment: .trailing)
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(Fmt.ratio(row.share, digits: 0)) of cost")
                }
                .width(min: 100, ideal: 110)

                TableColumn("Processed", value: \.processed) { row in
                    Text(Fmt.tokens(row.processed))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 70, ideal: 86)

                TableColumn("Fresh", value: \.fresh) { row in
                    Text(Fmt.tokens(row.fresh))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 60, ideal: 76)

                TableColumn("Cache read", value: \.cacheRead) { row in
                    Text(Fmt.tokens(row.cacheRead))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 70, ideal: 86)

                TableColumn("Responses", value: \.responses) { row in
                    Text(Fmt.count(row.responses))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 70, ideal: 86)
            }
            .tableStyle(.inset(alternatesRowBackgrounds: true))
    }
}

/// "Last 30 days at list price ≈ 4.2× your plan". Compares a 30-day report only; other windows say to switch.
private struct PlanValueTile: View {
    @Environment(SignalboxStore.self) private var store
    let value: PlanValue
    let plan: PlanPrice

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Plan value", systemImage: "equal.circle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(headline)
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if value == .needsThirtyDays, canSwitch {
                // Two caption-height lines, like every other tile: what's missing, then the switch on its own line,
                // so neither is cut off when six tiles share a row.
                VStack(alignment: .leading, spacing: 0) {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Button("Switch to 30 days") { store.select(range: .month) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .lineLimit(1)
                        .help("Switch the report to the last 30 days")
                }
            } else {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2, reservesSpace: true)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator.opacity(0.6)))
        .help(help)
        .accessibilityElement(children: .combine)
    }

    private var planMoney: Money { Money(currency: plan.currency, rate: 1) }
    private var planText: String { "\(planMoney.displayHeadline(plan.amount))/month" }

    private var canSwitch: Bool {
        if case .fixture = store.connection { return false }
        return store.canSendCommands
    }

    private var headline: String {
        if case let .value(m, _, _) = value { return "≈ \(PlanValue.multipleText(m))" }
        return Fmt.dash
    }

    private var caption: String {
        switch value {
        case .notConfigured: return "Set a monthly plan price in Settings ▸ Display"
        case .needsThirtyDays: return "Needs the 30-day range"
        case let .needsRate(c): return "Enter a \(c.code) rate in Settings ▸ Display to compare"
        case let .value(m, _, _): return "Last 30 days at list price ≈ \(PlanValue.multipleText(m)) your \(planText) plan"
        }
    }

    private var help: String {
        switch value {
        case let .value(_, list, _):
            return "Recorded spend over the last 30 calendar days at list price (\(planMoney.displayHeadline(list))) divided by your plan price. A lower bound: some output is missing from transcripts."
        case .needsThirtyDays:
            return "Your plan: \(planText). A monthly price is compared with 30 days of usage only, never a prorated guess."
        default:
            return "A monthly price is compared with 30 days of usage only, never a prorated guess."
        }
    }
}
