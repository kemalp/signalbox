import Foundation
@testable import SignalboxKit
@testable import SignalboxSwitch

/// A fresh folder under the temporary directory (its real path, so realpath comparisons hold), removed afterwards.
final class TempDir {
    let path: String

    init() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("sbx-switch-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        path = PosixFileSystem().realpath(base.path)!
    }

    deinit { try? FileManager.default.removeItem(atPath: path) }

    func sub(_ rel: String) -> String { "\(path)/\(rel)" }

    @discardableResult
    func mkdir(_ rel: String) -> String {
        try! FileManager.default.createDirectory(atPath: sub(rel), withIntermediateDirectories: true)
        return sub(rel)
    }

    @discardableResult
    func write(_ rel: String, _ text: String = "synthetic\n", mode: Int = 0o644) -> String {
        let p = sub(rel)
        try! FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: p, contents: Data(text.utf8), attributes: [.posixPermissions: mode])
        return p
    }

    func read(_ rel: String) -> String? { try? String(contentsOfFile: sub(rel), encoding: .utf8) }
    func exists(_ rel: String) -> Bool { FileManager.default.fileExists(atPath: sub(rel)) }
    func mode(_ rel: String) -> Int? { (try? FileManager.default.attributesOfItem(atPath: sub(rel)))?[.posixPermissions] as? Int }

    /// Every path below the folder, relative, sorted (links listed, not followed).
    func tree(_ rel: String = "") -> [String] {
        let root = rel.isEmpty ? path : sub(rel)
        guard let e = FileManager.default.enumerator(atPath: root) else { return [] }
        return (e.allObjects as? [String] ?? []).sorted()
    }
}

struct ShellResult {
    var status: Int32
    var out: String
    var err: String
}

/// Runs `executable` with exactly `environment` (nothing inherited: no tokens, no real config folders).
func runProcess(_ executable: String, _ args: [String], environment: [String: String], cwd: String? = nil) -> ShellResult {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: executable)
    p.arguments = args
    p.environment = environment
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = FileHandle.nullDevice
    try! p.run()
    let o = out.fileHandleForReading.readDataToEndOfFile()
    let e = err.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return ShellResult(status: p.terminationStatus, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self))
}

/// A fake `claude` that prints its pid, cwd, the two variables and its arguments, one per line.
func fakeClaude(in dir: TempDir, at rel: String = "real bin/claude") -> String {
    dir.write(rel, """
    #!/bin/sh
    echo "pid=$$"
    echo "cwd=$(pwd -P)"
    echo "CCD=${CLAUDE_CONFIG_DIR-<unset>}"
    echo "CHOSEN=${SIGNALBOX_SWITCH_CHOSEN-<unset>}"
    echo "args=$*"

    """, mode: 0o755)
}

/// key=value lines → dictionary.
func fields(_ out: String) -> [String: String] {
    var d: [String: String] = [:]
    for line in out.split(separator: "\n") {
        guard let eq = line.firstIndex(of: "=") else { continue }
        d[String(line[..<eq])] = String(line[line.index(after: eq)...])
    }
    return d
}

/// Collects what a @Sendable closure saw (the opener runs off the main actor).
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
}

@MainActor
func makeController(_ dir: TempDir, now: @escaping () -> Date = { Date() }, defaults: InMemorySettings = InMemorySettings(),
                    fs: any SwitchFileSystem = PosixFileSystem(),
                    opened: @escaping @Sendable (String) throws -> Void = { _ in }) -> SwitchController {
    SwitchController(paths: SwitchPaths(root: dir.sub("switch")), fs: fs, defaults: defaults,
                     appVersion: "0.0.0-test", clock: now, openInTerminal: opened)
}

/// PosixFileSystem with a hook before each exclusive rename (to make a target appear between plan and move).
final class HookedFileSystem: SwitchFileSystem {
    let base = PosixFileSystem()
    var beforeRename: ((String, String) -> Void)?
    func kind(_ path: String) -> FileKind? { base.kind(path) }
    func list(_ path: String) throws -> [String] { try base.list(path) }
    func ensureDirectory(_ path: String, mode: mode_t) throws -> [String] { try base.ensureDirectory(path, mode: mode) }
    func writeAtomically(_ data: Data, to path: String, mode: mode_t) throws { try base.writeAtomically(data, to: path, mode: mode) }
    func append(_ data: Data, to path: String, mode: mode_t) throws { try base.append(data, to: path, mode: mode) }
    func renameExclusive(_ from: String, _ to: String) throws {
        beforeRename?(from, to)
        try base.renameExclusive(from, to)
    }
    func rename(_ from: String, _ to: String) throws { try base.rename(from, to) }
    func removeDirectory(_ path: String) throws { try base.removeDirectory(path) }
    func removeFile(_ path: String) throws { try base.removeFile(path) }
    func makeSymlink(at path: String, target: String) throws { try base.makeSymlink(at: path, target: target) }
    func realpath(_ path: String) -> String? { base.realpath(path) }
    func device(_ path: String) -> UInt64? { base.device(path) }
    func supportsExclusiveRename(_ path: String) -> Bool { base.supportsExclusiveRename(path) }
    func read(_ path: String, maxBytes: Int) -> Data? { base.read(path, maxBytes: maxBytes) }
    func processExists(_ pid: Int32) -> Bool { base.processExists(pid) }
    func caseSensitive(_ path: String) -> Bool? { base.caseSensitive(path) }
}
