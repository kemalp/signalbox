import Foundation
import os

/// Builds the child environment. A Finder-launched app gets a minimal PATH, so the user's
/// login-shell PATH is resolved once and merged with the usual tool directories.
public enum ShellEnvironment {
    /// The user's login shell from the password database (what Terminal starts), else /bin/zsh.
    public static func userShell() -> String {
        if let pw = getpwuid(getuid()), let raw = pw.pointee.pw_shell {
            let shell = String(cString: raw)
            if !shell.isEmpty, FileManager.default.isExecutableFile(atPath: shell) { return shell }
        }
        return "/bin/zsh"
    }

    /// The command that prints `$PATH` between two markers from an interactive login `shell`. Shells
    /// with a syntax this doesn't speak (csh, tcsh, nu, …) are asked through /bin/zsh instead.
    static func loginInvocation(shell: String, marker: String) -> (executable: String, arguments: [String]) {
        let posix = "printf '%s' '\(marker)'; printf %s \"$PATH\"; printf '%s' '\(marker)'"
        switch (shell as NSString).lastPathComponent {
        case "fish":
            // $PATH is a list in fish; join it explicitly.
            return (shell, ["-l", "-i", "-c", "printf '%s' '\(marker)'; string join : $PATH; printf '%s' '\(marker)'"])
        case "zsh", "bash", "sh", "ksh", "mksh", "dash":
            return (shell, ["-l", "-i", "-c", posix])
        default:
            return ("/bin/zsh", ["-l", "-i", "-c", posix])
        }
    }

    /// Runs the user's shell as an interactive login shell with a unique marker around its `$PATH` and
    /// returns what's between the markers, or nil on timeout, failure, or a shell that printed no markers.
    public static func loginShellPATH(shell: String = userShell(), timeout: Duration = .seconds(4)) async -> String? {
        let marker = "__SIGNALBOX_PATH_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))__"
        let invocation = loginInvocation(shell: shell, marker: marker)
        guard FileManager.default.isExecutableFile(atPath: invocation.executable) else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let out = Pipe()
        process.standardOutput = out
        let reader = PipeReader(out.fileHandleForReading)
        let (exited, exitedContinuation) = AsyncStream<Void>.makeStream()
        process.terminationHandler = { _ in
            exitedContinuation.yield()
            exitedContinuation.finish()
        }
        do {
            try process.run()
        } catch {
            reader.stop()
            return nil
        }
        let pid = process.processIdentifier

        let collected = OSAllocatedUnfairLock(initialState: Data())
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                for await chunk in reader.chunks {
                    collected.withLock { $0.append(chunk) }
                    // Stop as soon as both markers are in: interactive shells can linger.
                    if collected.withLock({ Self.extract(from: $0, marker: marker) }) != nil { return }
                }
            }
            group.addTask {
                for await _ in exited { break }
                // The last chunk can arrive just after the exit notification; let the reader drain.
                try? await Task.sleep(for: .milliseconds(300))
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
            }
            // Whichever finishes first: got the PATH, the shell exited, or the timeout fired.
            await group.next()
            group.cancelAll()
            reader.stop()
            exitedContinuation.finish()
        }
        if process.isRunning { kill(pid, SIGKILL) }
        return collected.withLock { Self.extract(from: $0, marker: marker) }
    }

    static func extract(from data: Data, marker: String) -> String? {
        guard let text = String(data: data, encoding: .utf8),
              let first = text.range(of: marker),
              let second = text.range(of: marker, range: first.upperBound..<text.endIndex)
        else { return nil }
        let path = String(text[first.upperBound..<second.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    /// The directories always appended to PATH, after the login and inherited entries.
    public static func extraDirectories(home: String) -> [String] {
        ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.bun/bin"]
    }

    /// Login-shell PATH first, then the inherited PATH, then the extras; duplicates and empties dropped.
    public static func mergedPATH(login: String?, inherited: String?, home: String) -> String {
        var seen = Set<String>()
        var out: [String] = []
        let parts = (login ?? "").split(separator: ":") + (inherited ?? "").split(separator: ":")
        for p in parts.map(String.init) + extraDirectories(home: home) where !p.isEmpty && seen.insert(p).inserted {
            out.append(p)
        }
        if out.isEmpty { out = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] }
        return out.joined(separator: ":")
    }

    /// The child's environment: the app's own environment (keeps HOME, USER, TMPDIR, …) with PATH replaced.
    public static func childEnvironment(base: [String: String], path: String) -> [String: String] {
        var env = base
        env["PATH"] = path
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        // The CLI prints plain text logs to stderr; colors would just be noise in Diagnostics.
        env["NO_COLOR"] = "1"
        return env
    }

    /// Resolves the merged PATH once (login shell, with a timeout) and builds the child environment.
    public static func resolve(base: [String: String] = ProcessInfo.processInfo.environment) async -> (environment: [String: String], loginPATHResolved: Bool, shell: String) {
        let home = base["HOME"] ?? NSHomeDirectory()
        let shell = userShell()
        let login = await loginShellPATH(shell: shell)
        let path = mergedPATH(login: login, inherited: base["PATH"], home: home)
        return (childEnvironment(base: base, path: path), login != nil, (shell as NSString).lastPathComponent)
    }

    /// First executable named `name` on a PATH string.
    public static func which(_ name: String, path: String, fileManager: FileManager = .default) -> URL? {
        for dir in path.split(separator: ":") where !dir.isEmpty {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }
}
