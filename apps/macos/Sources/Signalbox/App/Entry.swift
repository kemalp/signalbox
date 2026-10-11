import AppKit
import SignalboxKit

/// Command-line options. Unknown arguments (Xcode adds some) are ignored.
struct LaunchOptions: Sendable {
    /// Show this snapshot JSON instead of running the CLI.
    var fixture: URL?
    /// Render PNGs of every screen into this directory and exit.
    var renderSnapshotsTo: URL?
    /// Rendering only: real Today and 30-day snapshots (`signalbox snapshot --json --days 1` / `--days 30`) for
    /// the `usage-today`, `usage-30d` and matching menu bar shots. Without them those shots use scaled copies of `fixture`.
    var renderTodayFixture: URL?
    var renderMonthFixture: URL?
    /// A saved command guide (`signalbox commands --json`) to show with `fixture`. Without it, a `commands.json`
    /// next to the fixture is used when there is one.
    var commandsFixture: URL?
    /// A saved session history (`signalbox history --json`) to show with `fixture`. Without it, a `history.json`
    /// next to the fixture is used when there is one.
    var historyFixture: URL?
    /// Rendering only: redact everything marked privacy-sensitive (titles, project names, paths, ids, branches, your
    /// own commands) into placeholder bars, for screenshots that are shared, such as the README's.
    var redact = false

    static let current = LaunchOptions(arguments: CommandLine.arguments)

    /// The command guide file to show with the fixture: `--fixture-commands`, else `commands.json` beside it.
    var resolvedCommandsFixture: URL? {
        if let commandsFixture { return commandsFixture }
        guard let sibling = fixture?.deletingLastPathComponent().appendingPathComponent("commands.json"),
              FileManager.default.fileExists(atPath: sibling.path) else { return nil }
        return sibling
    }

    /// The session history file to show with the fixture: `--fixture-history`, else `history.json` beside it.
    var resolvedHistoryFixture: URL? {
        if let historyFixture { return historyFixture }
        guard let sibling = fixture?.deletingLastPathComponent().appendingPathComponent("history.json"),
              FileManager.default.fileExists(atPath: sibling.path) else { return nil }
        return sibling
    }

    init(arguments: [String]) {
        var i = 1
        while i < arguments.count {
            let a = arguments[i]
            let next = i + 1 < arguments.count ? arguments[i + 1] : nil
            switch a {
            case "--fixture":
                if let next { fixture = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--render-snapshots":
                if let next { renderSnapshotsTo = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--fixture-today":
                if let next { renderTodayFixture = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--fixture-30d":
                if let next { renderMonthFixture = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--fixture-commands":
                if let next { commandsFixture = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--fixture-history":
                if let next { historyFixture = URL(fileURLWithPath: (next as NSString).expandingTildeInPath); i += 1 }
            case "--redact":
                redact = true
            default:
                break
            }
            i += 1
        }
    }
}

@main
enum SignalboxEntry {
    @MainActor
    static func main() {
        let options = LaunchOptions.current
        if let out = options.renderSnapshotsTo {
            guard let fixture = options.fixture else {
                FileHandle.standardError.write(Data("usage: Signalbox --render-snapshots <outDir> --fixture <snapshot.json> [--fixture-today <1-day.json>] [--fixture-30d <30-day.json>] [--fixture-commands <commands.json>] [--fixture-history <history.json>] [--redact]\n".utf8))
                exit(2)
            }
            exit(SnapshotRenderer.run(outDir: out, fixture: fixture, today: options.renderTodayFixture, month: options.renderMonthFixture,
                                      commands: options.resolvedCommandsFixture, history: options.resolvedHistoryFixture, redact: options.redact))
        }
        if #available(macOS 15.0, *) {
            SignalboxApp15.main()
        } else {
            SignalboxApp.main()
        }
    }
}
