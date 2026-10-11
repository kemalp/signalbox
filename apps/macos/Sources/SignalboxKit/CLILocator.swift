import Foundation

/// How to start the CLI: an executable plus the arguments that come before `watch --ndjson`.
public struct CLILaunch: Sendable, Equatable {
    public var executable: URL
    public var leadingArguments: [String]
    /// Where this launch came from, for Diagnostics.
    public var origin: Origin

    public enum Origin: Sendable, Equatable {
        /// SIGNALBOX_CLI pointing at a binary.
        case environmentBinary
        /// SIGNALBOX_CLI="bun:/abs/path/main.ts" (development).
        case environmentBun(script: String)
        /// Settings ▸ Advanced ▸ CLI path, pointing at a binary.
        case settingsOverride
        /// Settings ▸ Advanced ▸ CLI path set to "bun:/abs/path/main.ts".
        case settingsBun(script: String)
        /// The CLI bundled in the app's Resources.
        case bundled
        /// Set directly (tests).
        case custom
    }

    public init(executable: URL, leadingArguments: [String] = [], origin: Origin = .custom) {
        self.executable = executable
        self.leadingArguments = leadingArguments
        self.origin = origin
    }

    /// The full argv for `watch --ndjson --days N` and the flags `options` adds, not including the executable.
    public func watchArguments(days: Int, options: CLIWatchOptions = CLIWatchOptions()) -> [String] {
        leadingArguments + ["watch", "--ndjson", "--days", String(days)] + options.arguments
    }

    /// Where the CLI came from, without its path: "bundled", "SIGNALBOX_CLI binary", ….
    public var originDescription: String {
        switch origin {
        case .environmentBinary: "SIGNALBOX_CLI binary"
        case .environmentBun: "SIGNALBOX_CLI bun script"
        case .settingsOverride: "CLI path from Settings"
        case .settingsBun: "bun script from Settings"
        case .bundled: "bundled"
        case .custom: "custom"
        }
    }

    public var displayCommand: String {
        ([executable.path] + leadingArguments).joined(separator: " ")
    }
}

/// The `watch` flags that come from Settings. The defaults add none, so a CLI from before a flag still starts.
public struct CLIWatchOptions: Sendable, Equatable {
    /// Read the Claude app's session list for History (the CLI's default). Off adds `--no-claude-app`.
    public var includeClaudeApp: Bool

    public init(includeClaudeApp: Bool = true) {
        self.includeClaudeApp = includeClaudeApp
    }

    public static let noClaudeAppFlag = "--no-claude-app"

    /// The flags, in the order they follow `watch --ndjson --days N`.
    public var arguments: [String] {
        includeClaudeApp ? [] : [Self.noClaudeAppFlag]
    }
}

public enum CLILocation: Sendable, Equatable {
    case found(CLILaunch)
    case missing(reason: String)
}

public enum CLILocator {
    public static let environmentKey = "SIGNALBOX_CLI"
    public static let bundledName = "signalbox"

    /// Order: SIGNALBOX_CLI (a binary path, or "bun:/abs/path/to/main.ts"), then the Settings override (same
    /// forms), then the app bundle's Resources/signalbox. An explicit choice that doesn't work is reported, not skipped.
    public static func locate(
        environment: [String: String],
        override: String? = nil,
        bundleResources: URL?,
        searchPATH: String,
        fileManager: FileManager = .default
    ) -> CLILocation {
        if let raw = environment[environmentKey]?.trimmingCharacters(in: .whitespaces), !raw.isEmpty {
            return resolve(raw, name: environmentKey, binaryOrigin: .environmentBinary, bunOrigin: { .environmentBun(script: $0) },
                           searchPATH: searchPATH, fileManager: fileManager)
        }
        if let raw = override?.trimmingCharacters(in: .whitespaces), !raw.isEmpty {
            return resolve(raw, name: "The CLI path in Settings", binaryOrigin: .settingsOverride, bunOrigin: { .settingsBun(script: $0) },
                           searchPATH: searchPATH, fileManager: fileManager)
        }
        if let resources = bundleResources {
            let bundled = resources.appendingPathComponent(bundledName)
            if fileManager.isExecutableFile(atPath: bundled.path) {
                return .found(CLILaunch(executable: bundled, origin: .bundled))
            }
        }
        return .missing(reason: "The signalbox CLI isn't bundled with this build. Build the app with apps/macos/scripts/build-app.sh, or set \(environmentKey) to a signalbox binary (or bun:/path/to/apps/cli/src/main.ts).")
    }

    /// A binary path or "bun:/abs/main.ts" chosen by `name` (the environment variable or Settings).
    private static func resolve(_ raw: String, name: String, binaryOrigin: CLILaunch.Origin, bunOrigin: (String) -> CLILaunch.Origin,
                                searchPATH: String, fileManager: FileManager) -> CLILocation {
        if raw.hasPrefix("bun:") {
            let script = (String(raw.dropFirst(4)) as NSString).expandingTildeInPath
            guard script.hasPrefix("/") else {
                return .missing(reason: "\(name) (bun:…) needs an absolute path to main.ts (got \"\(script)\").")
            }
            guard fileManager.fileExists(atPath: script) else {
                return .missing(reason: "\(name) points at \(script), which doesn't exist.")
            }
            guard let bun = ShellEnvironment.which("bun", path: searchPATH, fileManager: fileManager) else {
                return .missing(reason: "\(name) asks for bun, but no bun executable was found on PATH (\(searchPATH)).")
            }
            return .found(CLILaunch(executable: bun, leadingArguments: [script], origin: bunOrigin(script)))
        }
        let path = (raw as NSString).expandingTildeInPath
        guard fileManager.isExecutableFile(atPath: path) else {
            return .missing(reason: "\(name) points at \(path), which isn't an executable file.")
        }
        return .found(CLILaunch(executable: URL(fileURLWithPath: path), origin: binaryOrigin))
    }
}
