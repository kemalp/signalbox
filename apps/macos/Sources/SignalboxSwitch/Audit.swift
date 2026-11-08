import Foundation

// The audit log: switch/audit.jsonl, 0600, opened O_APPEND | O_CREAT | O_NOFOLLOW. One JSON object per line (keys
// sorted), one line per action, refusals and failures included. At 5 MiB it becomes audit.1.jsonl (one older file kept). Never
// message content or titles; accounts as Step 1's hashed ids with your own label. Format: docs/SWITCH.md §5.

public enum AuditAction: String, CaseIterable, Sendable {
    case switchEnabled = "switch.enabled"
    case switchDisabled = "switch.disabled"
    case switchExpired = "switch.expired"
    case shimWritten = "shim.written"
    case pointerSet = "pointer.set"
    case resumeOpened = "resume.opened"
    case resumeSwept = "resume.swept"
    case setupChecked = "setup.checked"
    case setupStep = "setup.step"
    case setupStopped = "setup.stopped"
    case setupFinished = "setup.finished"

    public var title: String {
        switch self {
        case .switchEnabled: "Turned on"
        case .switchDisabled: "Turned off"
        case .switchExpired: "Expired"
        case .shimWritten: "Wrote the shim"
        case .pointerSet: "Terminal account"
        case .resumeOpened: "Resume in Terminal"
        case .resumeSwept: "Removed unused resume scripts"
        case .setupChecked: "Setup checked"
        case .setupStep: "Setup step"
        case .setupStopped: "Setup stopped"
        case .setupFinished: "Setup finished"
        }
    }
}

public enum AuditResult: String, Sendable {
    case ok, refused, failed, cancelled
}

public struct AuditMove: Codable, Hashable, Sendable {
    public var from: String
    public var to: String
    public init(from: String, to: String) {
        self.from = from
        self.to = to
    }
}

public struct AuditAccount: Codable, Hashable, Sendable {
    /// Step 1's hashed id (acct- and 12 hex), never a vendor id.
    public var id: String
    public var label: String?
    public init(id: String, label: String? = nil) {
        self.id = id
        self.label = label
    }
}

/// One line of the log. `action` and `result` stay strings, so a line from a newer Signalbox still reads.
public struct AuditEntry: Codable, Hashable, Sendable, Identifiable {
    public var v: Int = 1
    public var ts: Date
    public var action: String
    public var result: String
    public var reason: String?
    public var until: Date?
    public var from: String?
    public var to: String?
    public var account: AuditAccount?
    public var configDir: String?
    public var sessionId: String?
    public var fork: Bool?
    public var terminal: String?
    /// One shared-sessions setup: every setup line of it carries the same id.
    public var run: String?
    public var step: Int?
    public var moves: [AuditMove]?
    /// For `setup.step`: the folders it created (the undo removes them again when they are empty).
    public var created: [String]?
    public var paths: [String]?
    public var appVersion: String

    public init(ts: Date, action: AuditAction, result: AuditResult, appVersion: String, reason: String? = nil, until: Date? = nil,
                from: String? = nil, to: String? = nil, account: AuditAccount? = nil, configDir: String? = nil,
                sessionId: String? = nil, fork: Bool? = nil, terminal: String? = nil, run: String? = nil, step: Int? = nil,
                moves: [AuditMove]? = nil, created: [String]? = nil, paths: [String]? = nil) {
        self.ts = ts
        self.action = action.rawValue
        self.result = result.rawValue
        self.reason = reason
        self.until = until
        self.from = from
        self.to = to
        self.account = account
        self.configDir = configDir
        self.sessionId = sessionId
        self.fork = fork
        self.terminal = terminal
        self.run = run
        self.step = step
        self.moves = moves
        self.created = created
        self.paths = paths
        self.appVersion = appVersion
    }

    public var id: String { "\(AuditEntry.timestamp(ts))/\(action)/\(run ?? "")/\(step ?? 0)/\(sessionId ?? "")/\(result)" }
    public var knownAction: AuditAction? { AuditAction(rawValue: action) }

    /// ISO 8601 in UTC with milliseconds.
    public static func timestamp(_ d: Date) -> String {
        d.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: TimeZone(identifier: "UTC")!))
    }

    static func parseTimestamp(_ s: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
    }

    public func line() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(AuditEntry.timestamp(date))
        }
        var data = try e.encode(self)
        data.append(0x0A)
        return data
    }

    public static func decode(line: Data) -> AuditEntry? {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = parseTimestamp(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an ISO 8601 date")
            }
            return date
        }
        return try? d.decode(AuditEntry.self, from: line)
    }
}

public struct AuditLog {
    public static let rotateBytes = 5 * 1024 * 1024
    let paths: SwitchPaths
    let fs: any SwitchFileSystem

    public init(paths: SwitchPaths, fs: any SwitchFileSystem) {
        self.paths = paths
        self.fs = fs
    }

    public func append(_ entry: AuditEntry) throws {
        _ = try fs.ensureDirectory(paths.root, mode: 0o700)
        if case let .file(size, _)? = fs.kind(paths.audit), size >= Self.rotateBytes {
            try fs.rename(paths.audit, paths.auditOld)
        }
        try fs.append(entry.line(), to: paths.audit, mode: 0o600)
    }

    /// Both files, newest first; lines that don't read are skipped.
    public func entries(limit: Int = 5000) -> [AuditEntry] {
        var out: [AuditEntry] = []
        for path in [paths.audit, paths.auditOld] {
            guard let data = fs.read(path, maxBytes: Self.rotateBytes * 2) else { continue }
            for line in data.split(separator: 0x0A).reversed() {
                if let e = AuditEntry.decode(line: Data(line)) { out.append(e) }
                if out.count >= limit { return out }
            }
        }
        return out
    }
}
