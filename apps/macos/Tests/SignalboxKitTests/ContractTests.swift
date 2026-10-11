import Foundation
import Testing
@testable import SignalboxKit

/// Counts how often each key path occurs in a JSON value: `sessions[].context.window` → 3.
/// Nulls count as absent (the CLI omits `undefined`; JSON null would mean the same thing).
struct KeyPathCensus: Equatable {
    var counts: [String: Int] = [:]

    init(json: Any) {
        walk(json, path: "")
    }

    init(data: Data) throws {
        self.init(json: try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    /// Re-encodes a decoded value with the app's encoder and counts its key paths.
    init(encoding value: some Encodable) throws {
        try self.init(data: SignalboxJSON.encoder().encode(value))
    }

    private mutating func walk(_ value: Any, path: String) {
        if value is NSNull { return }
        if let dict = value as? [String: Any] {
            for (k, v) in dict where !(v is NSNull) {
                let p = path.isEmpty ? k : "\(path).\(k)"
                counts[p, default: 0] += 1
                walk(v, path: p)
            }
        } else if let array = value as? [Any] {
            for v in array { walk(v, path: "\(path)[]") }
        }
    }

    /// Key paths whose count in `raw` is higher than in `self`: fields (or whole elements) the decoder dropped.
    func lost(comparedTo raw: KeyPathCensus) -> [String] {
        raw.counts.compactMap { path, n in
            let kept = counts[path] ?? 0
            return kept < n ? "\(path) (\(kept)/\(n))" : nil
        }.sorted()
    }
}

/// Checks that decoding keeps every field the CLI sends: decode, re-encode, and compare key-path
/// counts with the raw JSON. A lenient decoder would otherwise hide a renamed field (it just
/// becomes nil) or a malformed row (it's skipped).
@Suite("Contract: nothing the CLI sends is lost")
struct ContractTests {
    /// Decodes one stream line and returns the key paths its payload lost (empty when it kept everything).
    static func audit(line: Data) throws -> (type: String, lost: [String]) {
        let message = try StreamMessage.parse(line)
        let object = try #require(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        let raw = object["data"].map { KeyPathCensus(json: $0) }
        switch message {
        case let .hello(_, v, pid):
            #expect(v == streamProtocolVersion)
            #expect(pid != nil)
            return ("hello", [])
        case let .fleet(at, data):
            #expect(at != nil)
            return ("fleet", try KeyPathCensus(encoding: data).lost(comparedTo: try #require(raw)))
        case let .report(at, days, data):
            #expect(at != nil)
            #expect(days != nil)
            return ("report", try KeyPathCensus(encoding: data).lost(comparedTo: try #require(raw)))
        case let .health(at, data):
            #expect(at != nil)
            return ("health", try KeyPathCensus(encoding: data).lost(comparedTo: try #require(raw)))
        case let .commands(at, data):
            #expect(at != nil)
            return ("commands", try KeyPathCensus(encoding: data).lost(comparedTo: try #require(raw)))
        case let .history(at, data):
            #expect(at != nil)
            return ("history", try KeyPathCensus(encoding: data).lost(comparedTo: try #require(raw)))
        case let .error(e):
            #expect(e.scope != .other, "unknown error scope")
            return ("error", [])
        case let .unknown(type):
            Issue.record("unknown line type \(type)")
            return (type, [])
        }
    }

    /// The key paths a `signalbox snapshot --json` object lost in decoding.
    static func audit(snapshot data: Data) throws -> [String] {
        try KeyPathCensus(encoding: try Snapshot.decode(data)).lost(comparedTo: try KeyPathCensus(data: data))
    }

    /// Every field of the real catalogs (catalog/commands/*.json, copied into Fixtures/commands.json) survives decoding.
    @Test func theCommandGuideKeepsEveryField() throws {
        let data = try Data(contentsOf: TestPaths.commandsFixture)
        let lost = try KeyPathCensus(encoding: try CommandsData.decode(data)).lost(comparedTo: try KeyPathCensus(data: data))
        #expect(lost.isEmpty, "commands.json lost: \(lost)")
    }

    /// Every field of the synthetic session history (Fixtures/history.json, the `signalbox history --json` shape).
    @Test func theHistoryKeepsEveryField() throws {
        let data = try Data(contentsOf: TestPaths.historyFixture)
        let lost = try KeyPathCensus(encoding: try HistorySnapshot.decode(data)).lost(comparedTo: try KeyPathCensus(data: data))
        #expect(lost.isEmpty, "history.json lost: \(lost)")
    }

    @Test(arguments: [TestPaths.snapshot, TestPaths.stressSnapshot])
    func theSyntheticFixturesKeepEveryField(_ url: URL) throws {
        let lost = try Self.audit(snapshot: Data(contentsOf: url))
        #expect(lost.isEmpty, "\(url.lastPathComponent) lost: \(lost)")
    }

    /// Lines the real CLI printed for synthetic agent homes (see scripts/make-stream-fixture.ts).
    @Test func theRealCLIsLinesForSyntheticDataKeepEveryField() throws {
        let text = try String(contentsOf: TestPaths.streamFixture, encoding: .utf8)
        var types: [String] = []
        for line in text.split(separator: "\n") where !line.isEmpty {
            let (type, lost) = try Self.audit(line: Data(line.utf8))
            #expect(lost.isEmpty, "\(type) line lost: \(lost)")
            types.append(type)
        }
        for type in ["hello", "fleet", "report", "health", "commands", "history", "error"] {
            #expect(types.contains(type), "the stream fixture has no \(type) line")
        }
        #expect(types.first == "hello")
    }

    /// Opt-in: audit a stream or snapshot captured from this machine. Prints key paths and counts only, never values.
    ///   dist/signalbox watch --ndjson > /tmp/stream.ndjson   (Ctrl-D after a fleet tick)
    ///   SIGNALBOX_STREAM_CAPTURE=/tmp/stream.ndjson swift test --filter Contract
    ///   (or a `signalbox snapshot --json`, `signalbox commands --json` or `signalbox history --json` file)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["SIGNALBOX_STREAM_CAPTURE"] != nil))
    func aCapturedStreamKeepsEveryField() throws {
        let path = ProcessInfo.processInfo.environment["SIGNALBOX_STREAM_CAPTURE"]!
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        if let whole = try? JSONSerialization.jsonObject(with: data) as? [String: Any], whole["type"] == nil, whole["fleet"] != nil {
            let lost = try Self.audit(snapshot: data)
            #expect(lost.isEmpty, "snapshot lost: \(lost)")
            print("contract: snapshot with \(KeyPathCensus(json: whole).counts.count) key paths")
            return
        }
        if let whole = try? JSONSerialization.jsonObject(with: data) as? [String: Any], whole["type"] == nil, whole["entries"] != nil {
            let lost = try KeyPathCensus(encoding: try HistorySnapshot.decode(data)).lost(comparedTo: KeyPathCensus(json: whole))
            #expect(lost.isEmpty, "history lost: \(lost)")
            print("contract: history with \(KeyPathCensus(json: whole).counts.count) key paths")
            return
        }
        if let whole = try? JSONSerialization.jsonObject(with: data) as? [String: Any], whole["type"] == nil, whole["catalogs"] != nil {
            let lost = try KeyPathCensus(encoding: try CommandsData.decode(data)).lost(comparedTo: KeyPathCensus(json: whole))
            #expect(lost.isEmpty, "commands lost: \(lost)")
            print("contract: commands with \(KeyPathCensus(json: whole).counts.count) key paths")
            return
        }
        let text = String(decoding: data, as: UTF8.self)
        var tally: [String: Int] = [:]
        for line in text.split(separator: "\n") where !line.isEmpty {
            let (type, lost) = try Self.audit(line: Data(line.utf8))
            #expect(lost.isEmpty, "\(type) line lost: \(lost)")
            tally[type, default: 0] += 1
        }
        print("contract: \(tally.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
    }

    @Test func theCensusSeesDroppedFieldsAndRows() throws {
        let raw = try KeyPathCensus(data: Data(#"{"a":[{"x":1,"y":null},{"x":2,"z":3}],"b":{"c":true}}"#.utf8))
        #expect(raw.counts == ["a": 1, "a[].x": 2, "a[].z": 1, "b": 1, "b.c": 1])
        let decoded = try KeyPathCensus(data: Data(#"{"a":[{"x":1}],"b":{}}"#.utf8))
        #expect(decoded.lost(comparedTo: raw) == ["a[].x (1/2)", "a[].z (0/1)", "b.c (0/1)"])
    }
}
