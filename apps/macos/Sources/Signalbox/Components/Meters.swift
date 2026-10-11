import SignalboxKit
import SwiftUI

/// A ProgressView-style bar. `fraction == nil` draws an empty track: unknown, not zero.
struct MeterBar: View {
    var fraction: Double?
    var tint: Color = Theme.accent
    /// An optional marker (0...1), e.g. where auto-compaction starts.
    var tick: Double?
    /// What the marker means, for VoiceOver and the pointer ("auto-compact at 97%").
    var tickLabel: String?
    var height: CGFloat = 6
    /// Draws the track lighter, for readings that aren't current.
    var muted = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(.quaternary)
                    .opacity(muted ? 0.6 : 1)
                    .frame(height: height)
                // A sliver for any non-zero value so it stays visible; nothing at all for zero.
                if let f = fraction, f > 0 {
                    Capsule()
                        .fill(tint.gradient)
                        .frame(width: max(height, w * min(1, max(0, f))), height: height)
                }
                if let tick {
                    // A notch that stands out over the fill and the track alike.
                    RoundedRectangle(cornerRadius: 1)
                        .fill(.primary.opacity(0.75))
                        .frame(width: 2, height: height + 6)
                        .overlay(RoundedRectangle(cornerRadius: 1).strokeBorder(.background.opacity(0.9), lineWidth: 0.5))
                        .offset(x: min(w - 2, max(0, w * tick - 1)))
                        .help(tickLabel.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "")
                        .accessibilityElement()
                        .accessibilityLabel(tickLabel ?? "marker")
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: height + 6)
    }
}

/// Context-window fill: a bar coloured by how close it is to auto-compaction, a tick where auto-compaction
/// starts, "319K of 1M (32%)" and the official/estimated marker.
struct ContextGauge: View {
    let context: ContextSnapshot?
    var style: Style = .row

    enum Style { case row, detail }

    var body: some View {
        let m = ContextGaugeModel(context)
        VStack(alignment: .leading, spacing: 3) {
            MeterBar(
                fraction: m.fraction,
                tint: Theme.color(for: m.severity),
                tick: m.tickFraction,
                tickLabel: m.tickLabel,
                height: style == .row ? 5 : 7
            )
            HStack(spacing: 4) {
                Text(m.caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let q = m.quality {
                    QualityMarker(quality: q, iconOnly: style == .row)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .help(help(m))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context window")
        .accessibilityValue(m.accessibilityValue)
    }

    private func help(_ m: ContextGaugeModel) -> String {
        var lines = [m.caption]
        if let t = m.tickLabel { lines.append(t.prefix(1).uppercased() + t.dropFirst() + "; red from \(Fmt.percent(m.critAt))") }
        if let src = Fmt.windowSourceLabel(context?.windowSource) { lines.append("Window: \(src)") }
        return lines.joined(separator: "\n")
    }
}

/// "official" (agent-reported) vs "estimated" (derived) context readings.
struct QualityMarker: View {
    let quality: ContextQuality
    var iconOnly = false

    var body: some View {
        switch quality {
        case .official:
            marker("official", "checkmark.seal.fill")
                .foregroundStyle(Theme.accent)
                .help("Official: reported by the agent")
        case .estimated:
            marker("estimated", "wand.and.rays")
                .help("Estimated from the last main-thread request")
        case .unknown:
            EmptyView()
        }
    }

    @ViewBuilder
    private func marker(_ title: String, _ symbol: String) -> some View {
        if iconOnly {
            Image(systemName: symbol)
                .imageScale(.small)
                .accessibilityLabel(title)
        } else {
            Label(title, systemImage: symbol)
                .labelStyle(.titleAndIcon)
        }
    }
}

/// A headline number with a title and a caption.
struct StatTile: View {
    let title: String
    let systemImage: String
    let value: String
    let caption: String
    var help: String?
    var valueColor: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(caption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator.opacity(0.6)))
        .help(help ?? "")
        .accessibilityElement(children: .combine)
    }
}
