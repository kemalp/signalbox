import Foundation

// The NDJSON protocol between the app and `signalbox watch --ndjson` (version 1).
// CLI → app: one JSON object per stdout line, discriminated by "type" (hello, fleet, report, health, commands,
// history, error; any other type is ignored, so a newer CLI can add lines without breaking this app).
// App → CLI: one JSON object per stdin line, discriminated by "cmd".

public let streamProtocolVersion = 1

/// Where an error line came from. Unknown scopes are kept as `.other`.
public enum StreamErrorScope: String, LenientStringEnum {
    case fleet, report, health, commands, history, `protocol`, other
    public static let fallback: StreamErrorScope = .other
}

public struct StreamError: Hashable, Sendable {
    public var scope: StreamErrorScope
    public var message: String
    public var at: Date

    public init(scope: StreamErrorScope, message: String, at: Date) {
        self.scope = scope
        self.message = message
        self.at = at
    }
}

/// One decoded line from the CLI.
public enum StreamMessage: Sendable, Equatable {
    case hello(version: String, protocolVersion: Int, pid: Int?)
    case fleet(at: Date?, FleetSnapshot)
    case report(at: Date?, days: Int?, Report)
    case health(at: Date?, [AdapterHealth])
    case error(StreamError)
    /// The command guide: catalogs, installed agent versions and custom commands (newer CLIs; protocol stays v1).
    case commands(at: Date?, CommandsData)
    /// Session history: past and live sessions with their titles and stats (newer CLIs; protocol stays v1).
    case history(at: Date?, HistorySnapshot)
    /// A well-formed line with a `type` this app doesn't know (a newer CLI). Ignored, never fatal.
    case unknown(type: String)
}

public enum StreamParseError: Error, Equatable, CustomStringConvertible {
    case notJSONObject
    case missingType
    case invalid(type: String, reason: String)

    public var description: String {
        switch self {
        case .notJSONObject: "line is not a JSON object"
        case .missingType: "line has no \"type\""
        case let .invalid(type, reason): "malformed \"\(type)\" line: \(reason)"
        }
    }
}

extension StreamMessage {
    private struct Envelope: Decodable {
        var type: String?
    }

    private struct Hello: Decodable {
        var v: Int?
        var version: String?
        var pid: Int?
    }

    private struct Payload<T: Decodable>: Decodable {
        var at: Date?
        var days: Int?
        var data: T
    }

    private struct ErrorLine: Decodable {
        var at: Date?
        var scope: StreamErrorScope?
        var message: String?
    }

    private struct HealthList: Decodable {
        var items: [AdapterHealth]
        init(from decoder: any Decoder) throws {
            items = try LossyArray<AdapterHealth>(from: decoder).elements
        }
    }

    /// Parses one stdout line. Unknown `type`s and unknown fields are tolerated.
    public static func parse(_ line: Data, decoder: JSONDecoder = SignalboxJSON.decoder(), now: Date = Date()) throws -> StreamMessage {
        let envelope: Envelope
        do {
            envelope = try decoder.decode(Envelope.self, from: line)
        } catch {
            throw StreamParseError.notJSONObject
        }
        guard let type = envelope.type, !type.isEmpty else { throw StreamParseError.missingType }
        do {
            switch type {
            case "hello":
                let h = try decoder.decode(Hello.self, from: line)
                return .hello(version: h.version ?? "unknown", protocolVersion: h.v ?? 0, pid: h.pid)
            case "fleet":
                let p = try decoder.decode(Payload<FleetSnapshot>.self, from: line)
                return .fleet(at: p.at, p.data)
            case "report":
                let p = try decoder.decode(Payload<Report>.self, from: line)
                return .report(at: p.at, days: p.days, p.data)
            case "health":
                let p = try decoder.decode(Payload<HealthList>.self, from: line)
                return .health(at: p.at, p.data.items)
            case "commands":
                let p = try decoder.decode(Payload<CommandsData>.self, from: line)
                return .commands(at: p.at, p.data)
            case "history":
                let p = try decoder.decode(Payload<HistorySnapshot>.self, from: line)
                return .history(at: p.at, p.data)
            case "error":
                let e = try decoder.decode(ErrorLine.self, from: line)
                return .error(StreamError(scope: e.scope ?? .other, message: e.message ?? "unknown error", at: e.at ?? now))
            default:
                return .unknown(type: type)
            }
        } catch let error as DecodingError {
            throw StreamParseError.invalid(type: type, reason: Self.describe(error))
        }
    }

    public static func parse(_ line: String) throws -> StreamMessage {
        try parse(Data(line.utf8))
    }

    static func describe(_ error: DecodingError) -> String {
        func path(_ ctx: DecodingError.Context) -> String {
            let p = ctx.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
            return p.isEmpty ? "" : " at \(p)"
        }
        switch error {
        case let .keyNotFound(key, ctx): return "missing \"\(key.stringValue)\"\(path(ctx))"
        case let .typeMismatch(_, ctx): return "wrong type\(path(ctx))"
        case let .valueNotFound(_, ctx): return "null value\(path(ctx))"
        case let .dataCorrupted(ctx): return "\(ctx.debugDescription)\(path(ctx))"
        @unknown default: return "\(error)"
        }
    }
}

/// One command line written to the CLI's stdin.
public enum StreamCommand: Sendable, Equatable {
    /// Switch the report window (1...365 calendar days) and emit a report now.
    case report(days: Int)
    /// Emit fleet + report now.
    case refresh

    public static let dayRange = 1...365

    /// The NDJSON line, including the trailing newline.
    public func encodedLine() -> Data {
        let json: String
        switch self {
        case let .report(days):
            json = #"{"cmd":"report","days":\#(min(max(days, Self.dayRange.lowerBound), Self.dayRange.upperBound))}"#
        case .refresh:
            json = #"{"cmd":"refresh"}"#
        }
        return Data((json + "\n").utf8)
    }
}

/// Splits a byte stream into lines on `\n` only (JSON strings may legally contain U+2028,
/// which `AsyncLineSequence` would treat as a line break). Strips a trailing `\r`.
public struct LineSplitter: Sendable {
    private var buffer = Data()
    /// Lines longer than this are dropped (and reported) instead of growing memory without bound.
    public let maxLineBytes: Int
    public private(set) var droppedOversizeLines = 0
    private var discarding = false

    public init(maxLineBytes: Int = 64 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    /// Appends a chunk and returns every complete line in it.
    public mutating func append(_ chunk: Data) -> [Data] {
        var lines: [Data] = []
        var rest = chunk[...]
        while let nl = rest.firstIndex(of: 0x0A) {
            let piece = rest[rest.startIndex..<nl]
            rest = rest[rest.index(after: nl)...]
            if discarding {
                discarding = false
                buffer.removeAll(keepingCapacity: false)
                continue
            }
            var line = buffer
            line.append(contentsOf: piece)
            buffer.removeAll(keepingCapacity: true)
            if line.last == 0x0D { line.removeLast() }
            if !line.isEmpty { lines.append(line) }
        }
        if !discarding {
            buffer.append(contentsOf: rest)
            if buffer.count > maxLineBytes {
                buffer.removeAll(keepingCapacity: false)
                discarding = true
                droppedOversizeLines += 1
            }
        }
        return lines
    }

    /// The unterminated tail at end of stream, if any.
    public mutating func finish() -> Data? {
        defer { buffer.removeAll() }
        guard !discarding, !buffer.isEmpty else { return nil }
        var line = buffer
        if line.last == 0x0D { line.removeLast() }
        return line.isEmpty ? nil : line
    }
}
