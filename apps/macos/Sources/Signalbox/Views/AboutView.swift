import AppKit
import SignalboxKit
import SwiftUI

/// Signalbox ▸ About Signalbox: versions (app, CLI, protocol, command guide), what the app is and isn't, and links.
struct AboutView: View {
    @Environment(SignalboxStore.self) private var store
    /// The renderer passes the icon (unbundled, the app has the generic one); the app uses its own.
    var icon: NSImage?

    static let width: CGFloat = 420
    static let repoURL = URL(string: "https://github.com/kemalp/signalbox")!
    static let readmeURL = URL(string: "https://github.com/kemalp/signalbox#readme")!
    static let appNotesURL = URL(string: "https://github.com/kemalp/signalbox/blob/main/apps/macos/README.md")!

    var body: some View {
        VStack(spacing: 16) {
            Image(nsImage: icon ?? NSApp.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            VStack(spacing: 3) {
                Text("Signalbox")
                    .font(.title2.weight(.semibold))
                Text(Self.appVersion.map { "Version \($0)" } ?? "Development build")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Text("A local control room for AI coding agents. It reads what Claude Code, Codex and Gemini CLI already write on this Mac, needs no credentials, and sends nothing anywhere.")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
                versionRow("App", Self.appVersion ?? "development build")
                versionRow("CLI", cliText)
                versionRow("Protocol", protocolText)
                versionRow("Command guide", guideText)
            }
            .font(.callout)
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            Text("Unofficial — not affiliated with Anthropic, OpenAI or Google.")
                .font(.callout.weight(.medium))
                .multilineTextAlignment(.center)

            HStack(spacing: 16) {
                Link(destination: Self.readmeURL) { Label("Read Me", systemImage: "book") }
                Link(destination: Self.appNotesURL) { Label("macOS App Notes", systemImage: "macwindow") }
                Link(destination: Self.repoURL) { Label("Repository", systemImage: "chevron.left.forwardslash.chevron.right") }
            }
            .font(.callout)
        }
        .padding(.horizontal, 28)
        .padding(.top, 24)
        .padding(.bottom, 22)
        .frame(width: Self.width)
    }

    private func versionRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.trailing)
            Text(value)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// "0.1.0 (1)" from the bundle; nil outside an app bundle (swift run, the snapshot renderer).
    static var appVersion: String? {
        guard let info = Bundle.main.infoDictionary, let short = info["CFBundleShortVersionString"] as? String else { return nil }
        if let build = info["CFBundleVersion"] as? String, !build.isEmpty, build != short { return "\(short) (\(build))" }
        return short
    }

    private var cliText: String {
        if let v = store.cliVersion { return "signalbox \(v)" }
        if case .fixture = store.connection { return "not running (showing a snapshot)" }
        return "not connected"
    }

    private var protocolText: String {
        let app = "v\(streamProtocolVersion)"
        guard let cli = store.cliProtocolVersion else { return app }
        return cli == streamProtocolVersion ? app : "\(app) (the CLI speaks v\(cli))"
    }

    private var guideText: String {
        guard let data = store.commands, !data.catalogs.isEmpty else { return "not loaded" }
        let checked = data.catalogs.map { c in
            [c.displayName ?? Fmt.agentName(c.agent), c.verifiedVersion].compactMap { $0 }.joined(separator: " ")
        }
        return "checked on " + checked.joined(separator: ", ")
    }
}
