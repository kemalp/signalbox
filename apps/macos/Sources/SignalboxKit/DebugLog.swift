import Foundation

/// `SIGNALBOX_DEBUG=1` makes the app print one line per transport event to stderr. The app's own lines
/// carry counts, timings and statuses, never session names, paths or line content. The CLI inherits the
/// variable and prints its per-tick timings; its stderr and error lines are forwarded as written (with a
/// `cli:` prefix) and can contain file paths.
public enum DebugLog {
    public static let environmentKey = "SIGNALBOX_DEBUG"
    /// Values that mean "off". The CLI (apps/cli/src/main.ts `debugEnabled`) uses the same list.
    public static let offValues: Set<String> = ["", "0", "false", "no", "off"]

    public static func isEnabled(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        guard let v = environment[environmentKey] else { return false }
        return !offValues.contains(v.trimmingCharacters(in: .whitespaces).lowercased())
    }

    public static func write(_ line: String) {
        FileHandle.standardError.write(Data("signalbox-app: \(line)\n".utf8))
    }

    /// One line describing a transport event.
    public static func describe(_ event: TransportEvent) -> String {
        switch event {
        case let .started(pid, command):
            return "started pid=\(pid)" + (watchArguments(command).map { " args=\($0)" } ?? "")
        case let .message(m):
            return describe(m)
        case let .protocolError(reason, _):
            // The reason says what was wrong and how long the line was; the preview stays in Diagnostics.
            return "protocol-error \(reason.prefix(160))"
        case let .stderr(line):
            return "cli: \(line.prefix(300))"
        case let .exited(status, signaled):
            return signaled ? "exited signal=\(status)" : "exited status=\(status)"
        case let .launchFailed(reason):
            return "launch-failed \(reason)"
        case let .restarting(attempt, delay):
            return "restarting attempt=\(attempt) delay=\(delay)"
        }
    }

    /// The connection state without its reason (which quotes CLI stderr): "failed attempt=3".
    public static func describe(_ connection: ConnectionState) -> String {
        switch connection {
        case .idle: "idle"
        case .starting: "starting"
        case .connected: "connected"
        case let .restarting(attempt, _, _): "restarting attempt=\(attempt)"
        case .cliMissing: "cli-missing"
        case let .failed(_, attempt, _): "failed attempt=\(attempt) (the window says the CLI couldn't start)"
        case .fixture: "fixture"
        }
    }

    /// "watch --ndjson --days 7" from a full command line, without the executable or script paths before it.
    static func watchArguments(_ command: String) -> String? {
        let parts = command.split(separator: " ")
        guard let i = parts.lastIndex(of: "watch") else { return nil }
        return parts[i...].joined(separator: " ")
    }

    public static func describe(_ message: StreamMessage) -> String {
        switch message {
        case let .hello(version, v, pid):
            return "hello v=\(v) version=\(version) pid=\(pid.map(String.init) ?? "?")"
        case let .fleet(_, f):
            let byStatus = SessionStatus.allCases.compactMap { s -> String? in
                let n = f.sessions.filter { $0.status == s }.count
                return n > 0 ? "\(s.rawValue)=\(n)" : nil
            }.joined(separator: ",")
            let agents = Set(f.sessions.map(\.agent.rawValue)).sorted().joined(separator: ",")
            // How many context readings came with a window (so the bar can fill), counts only.
            let contexts = f.sessions.compactMap(\.context)
            let windowed = contexts.filter { ($0.window ?? 0) > 0 }.count
            return "fleet sessions=\(f.sessions.count) [\(byStatus)] agents=[\(agents)] limits=\(f.limits.count) compactions=\(f.compactions.count) health=\(f.health.count) contexts=\(contexts.count) windowed=\(windowed)"
        case let .report(_, days, r):
            let usd = String(format: "%.2f", r.totals.cost.total)
            return "report days=\(days.map(String.init) ?? "?") responses=\(r.totals.responses) usd=\(usd) models=\(r.byModel.count) unpriced=\(r.totals.unpricedModels.count)"
        case let .health(_, list):
            return "health sources=\(list.count) ok=\(list.filter(\.ok).count)"
        case let .commands(_, c):
            // Counts only: custom command names can say what someone works on.
            let built = c.catalogs.map { "\($0.agent.rawValue)=\($0.commands.count)" }.joined(separator: ",")
            return "commands catalogs=[\(built)] installed=\(c.installed.count) custom=\(c.custom.count)"
        case let .history(_, h):
            // Counts only: titles say what someone works on.
            let agents = Set(h.entries.map(\.agent.rawValue)).sorted().joined(separator: ",")
            let titled = h.entries.filter { $0.title != nil }.count
            let app = h.sources?.claudeApp.map { $0.enabled ? "on" : "off" } ?? "absent"
            return "history entries=\(h.entries.count) total=\(h.total) truncated=\(h.truncated) titled=\(titled) live=\(h.entries.filter(\.live).count) agents=[\(agents)] claudeApp=\(app) appOnly=\(h.entries.filter(\.isAppOnly).count) archived=\(h.entries.filter(\.isArchived).count)"
        case let .error(e):
            return "error scope=\(e.scope.rawValue) message=\(e.message.prefix(200))"
        case let .unknown(type):
            return "unknown type=\(type)"
        }
    }
}
