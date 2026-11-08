import Foundation
import SignalboxKit

// signalbox-switch's plain values: where its files live, the pointer that names the Terminal account, the account
// folders it knows, and how long it stays on. Pure; docs/SWITCH.md is the design.

/// Where signalbox-switch keeps its own files: ~/Library/Application Support/signalbox/switch, or
/// $SIGNALBOX_SWITCH_ROOT (tests and test copies of the app).
public struct SwitchPaths: Sendable, Equatable {
    public static let environmentKey = "SIGNALBOX_SWITCH_ROOT"
    public let root: String

    public init(root: String) {
        self.root = SwitchFolder.normalize(root)
    }

    /// One line: `default` or a config folder's absolute path.
    public var pointer: String { root + "/active" }
    public var binDir: String { root + "/bin" }
    /// The `claude` shim.
    public var shim: String { binDir + "/claude" }
    /// One-shot resume scripts, each deleting itself when Terminal runs it.
    public var resumeDir: String { root + "/resume" }
    public var audit: String { root + "/audit.jsonl" }
    public var auditOld: String { root + "/audit.1.jsonl" }

    /// $HOME first, like the CLI and the labels file, so every copy of Signalbox names the same folder.
    public static func standard(environment: [String: String] = ProcessInfo.processInfo.environment) -> SwitchPaths {
        if let r = environment[environmentKey], r.hasPrefix("/") { return SwitchPaths(root: r) }
        return SwitchPaths(root: home(environment) + "/Library/Application Support/signalbox/switch")
    }

    public static func home(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        environment["HOME"].flatMap { $0.hasPrefix("/") ? SwitchFolder.normalize($0) : nil }
            ?? FileManager.default.homeDirectoryForCurrentUser.path
    }
}

/// What the pointer file says.
public enum PointerValue: Hashable, Sendable {
    /// `CLAUDE_CONFIG_DIR` unset: a plain `claude`, ~/.claude. Never stored as a path: setting the variable to
    /// ~/.claude moves the global config file into that folder.
    case defaultFolder
    case folder(String)

    public static let maxBytes = 4096

    /// The first line of the file; nil when it is neither `default` nor a clean absolute path.
    public static func parse(_ data: Data) -> PointerValue? {
        guard data.count <= maxBytes, let text = String(data: data, encoding: .utf8) else { return nil }
        let line = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return parse(line: line)
    }

    public static func parse(line: String) -> PointerValue? {
        if line == "default" { return .defaultFolder }
        guard line.hasPrefix("/"), isCleanPath(line) else { return nil }
        return .folder(line)
    }

    public var line: String {
        switch self {
        case .defaultFolder: "default"
        case let .folder(path): path
        }
    }

    public var fileContents: Data { Data((line + "\n").utf8) }
}

/// No control characters (newlines included): such a path could break a script line or mislead on screen.
func isCleanPath(_ s: String) -> Bool {
    !s.isEmpty && !s.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
}

/// A Claude Code config folder the switch can point at.
public struct SwitchFolder: Hashable, Sendable, Identifiable {
    public var path: String
    /// ~/.claude, used with `CLAUDE_CONFIG_DIR` unset.
    public var isDefault: Bool

    public init(path: String, isDefault: Bool) {
        self.path = SwitchFolder.normalize(path)
        self.isDefault = isDefault
    }

    public var id: String { path }
    public var pointerValue: PointerValue { isDefault ? .defaultFolder : .folder(path) }
    public var projects: String { path + "/projects" }
    public var sessions: String { path + "/sessions" }

    /// ~/.claude first, then every other config folder Signalbox reads, each once. Two spellings of one folder (a
    /// symlink on the way, /System/Volumes/Data/…) are one folder: `realpath` tells them apart, and ~/.claude under
    /// another spelling is still the default, never a path (which would move Claude Code's global config).
    public static func list(home: String, extra: [String], realpath: (String) -> String? = { _ in nil }) -> [SwitchFolder] {
        let def = SwitchFolder(path: normalize(home) + "/.claude", isDefault: true)
        var out = [def]
        var seen: Set<String> = [realpath(def.path) ?? def.path]
        for raw in extra {
            let p = normalize(raw)
            guard p.hasPrefix("/"), isCleanPath(p), seen.insert(realpath(p) ?? p).inserted else { continue }
            out.append(SwitchFolder(path: p, isDefault: false))
        }
        return out
    }

    /// The folder a pointer names, if it is one of `folders`.
    public static func folder(for pointer: PointerValue?, in folders: [SwitchFolder]) -> SwitchFolder? {
        guard let pointer else { return nil }
        return folders.first { $0.pointerValue == pointer }
    }

    public static func normalize(_ p: String) -> String {
        var s = p
        while s.count > 1, s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// The account whose terminal login this folder uses now (Step 1's hashed id), if the CLI could read it.
    public func account(in accounts: [AccountInfo]) -> AccountInfo? {
        accounts.first { a in (a.loginConfigDirs ?? []).contains { SwitchFolder.normalize($0) == path } }
    }
}

/// How long account switching stays on once you turn it on.
public enum SwitchDuration: Int, CaseIterable, Identifiable, Sendable {
    case oneHour = 1
    case eightHours = 8
    case oneDay = 24

    public static let standard: SwitchDuration = .eightHours
    public var id: Int { rawValue }
    public var seconds: TimeInterval { TimeInterval(rawValue) * 3600 }
    public var title: String {
        switch self {
        case .oneHour: "1 hour"
        case .eightHours: "8 hours"
        case .oneDay: "24 hours"
        }
    }
}
