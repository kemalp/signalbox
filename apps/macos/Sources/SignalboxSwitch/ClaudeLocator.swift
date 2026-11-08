import Darwin
import Foundation

/// Finds the real `claude` for resume scripts, never the shim: $SIGNALBOX_CLAUDE_BIN, then the login shell's PATH,
/// then the usual install folders (the CLI's apps/cli/src/binaries.ts order). A folder that resolves to the shim's,
/// and any file whose first two lines carry the shim's marker, are skipped. Only stat and two lines are read.
public enum ClaudeLocator {
    public static let environmentKey = "SIGNALBOX_CLAUDE_BIN"

    public static func locate(environment: [String: String], searchPATH: String, home: String, shimDir: String,
                              fs: any SwitchFileSystem) -> String? {
        if let override = environment[environmentKey], override.hasPrefix("/") {
            return isUsable(override, fs: fs) ? override : nil
        }
        let shimReal = fs.realpath(shimDir) ?? shimDir
        var seen = Set<String>()
        for dir in searchPATH.split(separator: ":").map(String.init) + fallbackDirs(home: home, environment: environment, fs: fs) {
            guard dir.hasPrefix("/"), seen.insert(dir).inserted else { continue }
            if (fs.realpath(dir) ?? dir) == shimReal { continue }
            let candidate = dir + "/claude"
            if isUsable(candidate, fs: fs) { return candidate }
        }
        return nil
    }

    /// An executable regular file (after links) that isn't a copy of the shim.
    static func isUsable(_ path: String, fs: any SwitchFileSystem) -> Bool {
        var st = stat()
        guard stat(path, &st) == 0, st.st_mode & S_IFMT == S_IFREG, access(path, X_OK) == 0 else { return false }
        let real = fs.realpath(path) ?? path
        let fd = open(real, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var buf = [UInt8](repeating: 0, count: 512)
        let n = read(fd, &buf, buf.count)
        return n < 0 ? false : !ShimScript.isShim(head: Data(buf.prefix(max(n, 0))))
    }

    static func fallbackDirs(home: String, environment: [String: String], fs: any SwitchFileSystem) -> [String] {
        // $SIGNALBOX_BIN_DIRS replaces the list, as in the CLI (empty: none).
        if let override = environment["SIGNALBOX_BIN_DIRS"] { return override.split(separator: ":").map(String.init).filter { $0.hasPrefix("/") } }
        let nvm = environment["NVM_DIR"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? home + "/.nvm"
        let versions = ((try? fs.list(nvm + "/versions/node")) ?? [])
            .compactMap { name -> (String, [Int])? in
                let parts = name.drop(while: { $0 == "v" }).split(separator: ".").compactMap { Int($0) }
                return parts.count == 3 ? (name, parts) : nil
            }
            .sorted { $0.1.lexicographicallyPrecedes($1.1) }
            .reversed()
            .map { "\(nvm)/versions/node/\($0.0)/bin" }
        return ["\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
            + versions + ["\(home)/.volta/bin", "\(home)/.asdf/shims"]
    }
}
