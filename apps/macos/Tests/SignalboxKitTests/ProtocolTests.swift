import Foundation
import Testing
@testable import SignalboxKit

@Suite("NDJSON protocol")
struct ProtocolTests {
    @Test func parsesHello() throws {
        let m = try StreamMessage.parse(#"{"type":"hello","v":1,"version":"0.1.0","pid":4242}"#)
        #expect(m == .hello(version: "0.1.0", protocolVersion: 1, pid: 4242))
    }

    @Test func parsesFleetWithUnknownFields() throws {
        let line = #"{"type":"fleet","at":"2026-10-09T14:30:00.000Z","extra":{"a":1},"data":{"generatedAt":"2026-10-09T14:30:00.000Z","sessions":[],"limits":[],"compactions":[],"health":[],"later":true}}"#
        guard case let .fleet(at, data) = try StreamMessage.parse(line) else {
            Issue.record("not a fleet line")
            return
        }
        #expect(at == date("2026-10-09T14:30:00Z"))
        #expect(data.sessions.isEmpty)
    }

    @Test func parsesReportWithDays() throws {
        let s = try TestPaths.loadSnapshot()
        let reportJSON = String(decoding: try SignalboxJSON.encoder().encode(s.report), as: UTF8.self)
        let line = #"{"type":"report","at":"2026-10-09T14:30:00Z","days":30,"data":\#(reportJSON)}"#
        guard case let .report(_, days, report) = try StreamMessage.parse(line) else {
            Issue.record("not a report line")
            return
        }
        #expect(days == 30)
        #expect(report == s.report)
    }

    @Test func parsesHealthAndErrors() throws {
        let h = try StreamMessage.parse(#"{"type":"health","at":"2026-10-09T14:30:00Z","data":[{"name":"a:b","stability":"preview","ok":false,"detail":"nope"},{"bad":1}]}"#)
        #expect(h == .health(at: date("2026-10-09T14:30:00Z"), [AdapterHealth(name: "a:b", stability: .preview, ok: false, detail: "nope")]))

        let e = try StreamMessage.parse(#"{"type":"error","at":"2026-10-09T14:30:00Z","scope":"report","message":"scan failed"}"#)
        #expect(e == .error(StreamError(scope: .report, message: "scan failed", at: date("2026-10-09T14:30:00Z"))))

        let odd = try StreamMessage.parse(#"{"type":"error","at":"2026-10-09T14:30:00Z","scope":"cosmic-rays","message":"?"}"#)
        guard case let .error(err) = odd else {
            Issue.record("not an error line")
            return
        }
        #expect(err.scope == .other)
    }

    @Test func unknownTypesAreToleratedNotFatal() throws {
        #expect(try StreamMessage.parse(#"{"type":"progress","pct":40}"#) == .unknown(type: "progress"))
    }

    @Test func rejectsLinesThatAreNotProtocol() {
        #expect(throws: StreamParseError.notJSONObject) { try StreamMessage.parse("hello world") }
        #expect(throws: StreamParseError.notJSONObject) { try StreamMessage.parse("[1,2]") }
        #expect(throws: StreamParseError.missingType) { try StreamMessage.parse(#"{"data":{}}"#) }
        #expect(throws: StreamParseError.self) { try StreamMessage.parse(#"{"type":"fleet","data":{"sessions":[]}}"#) }
    }

    @Test func encodesCommands() {
        #expect(String(decoding: StreamCommand.report(days: 30).encodedLine(), as: UTF8.self) == "{\"cmd\":\"report\",\"days\":30}\n")
        #expect(String(decoding: StreamCommand.refresh.encodedLine(), as: UTF8.self) == "{\"cmd\":\"refresh\"}\n")
        // Out-of-range windows are clamped to 1...365.
        #expect(String(decoding: StreamCommand.report(days: 0).encodedLine(), as: UTF8.self) == "{\"cmd\":\"report\",\"days\":1}\n")
        #expect(String(decoding: StreamCommand.report(days: 9999).encodedLine(), as: UTF8.self) == "{\"cmd\":\"report\",\"days\":365}\n")
    }
}

@Suite("Line splitting")
struct LineSplitterTests {
    @Test func splitsAcrossChunkBoundaries() {
        var s = LineSplitter()
        #expect(s.append(Data("{\"a\":".utf8)).isEmpty)
        let lines = s.append(Data("1}\n{\"b\":2}\r\n{\"c\"".utf8))
        #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["{\"a\":1}", "{\"b\":2}"])
        #expect(s.append(Data(":3}".utf8)).isEmpty)
        #expect(s.finish().map { String(decoding: $0, as: UTF8.self) } == "{\"c\":3}")
    }

    @Test func keepsUnicodeLineSeparatorsInsideALine() {
        var s = LineSplitter()
        let line = "{\"name\":\"a\u{2028}b\u{2029}c\"}\n"
        let out = s.append(Data(line.utf8))
        #expect(out.count == 1)
        #expect(String(decoding: out[0], as: UTF8.self).contains("\u{2028}"))
    }

    @Test func skipsBlankLines() {
        var s = LineSplitter()
        #expect(s.append(Data("\n\n{}\n\n".utf8)).count == 1)
    }

    @Test func dropsOversizeLinesAndRecovers() {
        var s = LineSplitter(maxLineBytes: 8)
        #expect(s.append(Data("0123456789abcdef".utf8)).isEmpty)
        let out = s.append(Data("more\n{}\n".utf8))
        #expect(out.map { String(decoding: $0, as: UTF8.self) } == ["{}"])
        #expect(s.droppedOversizeLines == 1)
    }
}
