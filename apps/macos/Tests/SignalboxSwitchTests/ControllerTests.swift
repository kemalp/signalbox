import Foundation
import Testing
@testable import SignalboxKit
@testable import SignalboxSwitch

// The verbs against a temporary folder: off by default, the window, the pointer, resume, the sweep, the log.

@Suite("Switch controller")
@MainActor
struct ControllerTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func offByDefaultWritesNothing() {
        let dir = TempDir()
        let c = makeController(dir)
        #expect(!c.isOn())
        #expect(c.pointer == nil && !c.pointerUnreadable)
        #expect((try? c.setPointer(SwitchFolder(path: dir.sub("team"), isDefault: false), account: nil)) == nil)
        c.sweepResumeScripts()
        c.expireIfDue()
        c.disable()
        // Nothing at all while off, not even a refusal's log line.
        #expect(!dir.exists("switch"))
        #expect(c.auditEntries().isEmpty)
    }

    @Test func theWindowExpiresOnceAndKeepsThePointer() throws {
        let dir = TempDir()
        var now = t0
        let defaults = InMemorySettings()
        let c = makeController(dir, now: { now }, defaults: defaults)
        try c.enable(.oneHour)
        #expect(c.isOn())
        #expect(c.enabledUntil == t0.addingTimeInterval(3600))
        #expect(dir.read("switch/bin/claude") == ShimScript.text(pointerPath: c.paths.pointer))
        #expect(dir.mode("switch") == 0o700 && dir.mode("switch/bin/claude") == 0o700 && dir.mode("switch/audit.jsonl") == 0o600)
        try c.setPointer(SwitchFolder(path: dir.sub("team"), isDefault: false), account: AuditAccount(id: "acct-0123456789ab", label: "Team"))
        // A relaunch reads the window from the defaults.
        #expect(makeController(dir, now: { now }, defaults: defaults).isOn())
        now = t0.addingTimeInterval(3601)
        #expect(!c.isOn())
        c.expireIfDue()
        c.expireIfDue()
        #expect(c.enabledUntil == nil && defaults.object(forKey: SwitchController.enabledUntilKey) == nil)
        #expect(c.pointer == .folder(dir.sub("team")), "expiry keeps the pointer")
        let actions = c.auditEntries().map(\.action)
        #expect(actions == ["switch.expired", "pointer.set", "switch.enabled", "shim.written"], "newest first; expired once")
        // Turning on again doesn't rewrite an up-to-date shim.
        try c.enable(.eightHours)
        #expect(c.auditEntries().first?.action == "switch.enabled")
        #expect(!c.auditEntries().prefix(2).contains { $0.action == "shim.written" })
    }

    @Test func thePointerIsAtomicPrivateAndStoresTheDefaultAsDefault() throws {
        let dir = TempDir()
        let c = makeController(dir)
        try c.enable(.oneHour)
        let def = SwitchFolder.list(home: dir.path, extra: [])[0]
        #expect(def.isDefault && def.path == dir.sub(".claude"))
        try c.setPointer(def, account: nil)
        #expect(dir.read("switch/active") == "default\n")
        #expect(dir.mode("switch/active") == 0o600)
        // ~/.claude listed again as an extra folder is still the default, never a path.
        let folders = SwitchFolder.list(home: dir.path, extra: [dir.sub(".claude/"), dir.sub("team"), dir.sub("team")])
        #expect(folders.map(\.path) == [dir.sub(".claude"), dir.sub("team")])
        // ~/.claude reached through a link is still the default: deduped by real path, never stored as a path.
        dir.mkdir(".claude")
        dir.mkdir("team")
        try FileManager.default.createSymbolicLink(atPath: dir.sub("homelink"), withDestinationPath: dir.path)
        let fs = PosixFileSystem()
        let aliased = SwitchFolder.list(home: dir.path, extra: [dir.sub("homelink/.claude"), dir.sub("homelink/team"), dir.sub("team")], realpath: { fs.realpath($0) })
        #expect(aliased.map(\.path) == [dir.sub(".claude"), dir.sub("homelink/team")])
        try c.setPointer(folders[1], account: nil)
        #expect(dir.read("switch/active") == dir.sub("team") + "\n")
        #expect(!dir.tree("switch").contains { $0.hasSuffix(".tmp") })
        let set = try #require(c.auditEntries().first)
        #expect(set.from == "default" && set.to == dir.sub("team") && set.configDir == dir.sub("team"))
        dir.write("switch/active", "not a path\n")
        c.refreshPointer()
        #expect(c.pointer == nil && c.pointerUnreadable)
    }

    @Test func resumeWritesAScriptAndOpensTerminalOnIt() async throws {
        let dir = TempDir()
        let opened = Recorder()
        let c = makeController(dir, opened: { opened.add($0) })
        try c.enable(.oneHour)
        let transcript = dir.write("team/projects/p/11111111-2222-3333-4444-555555555555.jsonl")
        let r = ResumeRequest(sessionId: "11111111-2222-3333-4444-555555555555", cwd: dir.path,
                              folder: SwitchFolder(path: dir.sub("team"), isDefault: false), fork: false, claudePath: "/usr/bin/true")
        try await c.resume(r, transcriptPath: transcript, live: false, account: nil)
        #expect(opened.all.count == 1)
        let file = try #require(opened.all.first)
        #expect(file.hasPrefix(c.paths.resumeDir + "/") && file.hasSuffix(".command"))
        #expect((try? String(contentsOfFile: file, encoding: .utf8)) == r.script)
        #expect(dir.mode("switch/resume") == 0o700)
        let e = try #require(c.auditEntries().first)
        #expect(e.action == "resume.opened" && e.result == "ok" && e.sessionId == r.sessionId && e.terminal == "Terminal" && e.paths == [file])
        // A second Resume With of the same session right away is refused (Terminal may not have started it yet).
        await #expect(throws: SwitchError.self) { try await c.resume(r, transcriptPath: transcript, live: false, account: nil) }
        #expect(opened.all.count == 1)
        #expect(c.auditEntries().first?.reason == "opened less than two minutes ago")
    }

    @Test func resumeChecksAgainAndLogsRefusals() async throws {
        let dir = TempDir()
        let opened = Recorder()
        let c = makeController(dir, opened: { opened.add($0) })
        try c.enable(.oneHour)
        let transcript = dir.write(".claude/projects/p/abc.jsonl")
        dir.mkdir("team")
        let team = ResumeRequest(sessionId: "abc", cwd: nil, folder: SwitchFolder(path: dir.sub("team"), isDefault: false), fork: false, claudePath: "/usr/bin/true")
        await #expect(throws: SwitchError.self) { try await c.resume(team, transcriptPath: transcript, live: false, account: nil) }
        #expect(c.auditEntries().first?.reason == "folder can't see the transcript")
        var def = team
        def.folder = SwitchFolder(path: dir.sub(".claude"), isDefault: true)
        await #expect(throws: SwitchError.self) { try await c.resume(def, transcriptPath: transcript, live: true, account: nil) }
        #expect(c.auditEntries().first?.reason == "session is live")
        #expect(opened.all.isEmpty && dir.tree("switch/resume").isEmpty)
        #expect(c.auditEntries().filter { $0.action == "resume.opened" }.allSatisfy { $0.result == "refused" })
    }

    @Test func aFailedOpenRemovesTheScriptAndIsLogged() async throws {
        let dir = TempDir()
        let c = makeController(dir, opened: { _ in throw SwitchError.terminal("no Terminal") })
        try c.enable(.oneHour)
        let transcript = dir.write("t/projects/p/abc.jsonl")
        let r = ResumeRequest(sessionId: "abc", cwd: nil, folder: SwitchFolder(path: dir.sub("t"), isDefault: false), fork: false, claudePath: "/usr/bin/true")
        await #expect(throws: SwitchError.self) { try await c.resume(r, transcriptPath: transcript, live: false, account: nil) }
        #expect(dir.tree("switch/resume").isEmpty)
        #expect(c.auditEntries().first?.result == "failed")
    }

    @Test func theSweepRemovesOnlyOldScripts() throws {
        let dir = TempDir()
        let now = Date()
        let c = makeController(dir, now: { now })
        let old = dir.write("switch/resume/old.command")
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-7200)], ofItemAtPath: old)
        dir.write("switch/resume/new.command")
        dir.write("switch/resume/keep.txt")
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-7200)], ofItemAtPath: dir.sub("switch/resume/keep.txt"))
        c.sweepResumeScripts()
        #expect(dir.tree("switch/resume") == ["keep.txt", "new.command"])
        let e = try #require(c.auditEntries().first)
        #expect(e.action == "resume.swept" && e.paths == [old])
    }

    @Test func theLogRotatesAndNeverHoldsTitlesOrRawIds() throws {
        let dir = TempDir()
        let paths = SwitchPaths(root: dir.sub("switch"))
        let log = AuditLog(paths: paths, fs: PosixFileSystem())
        dir.write("switch/audit.jsonl", String(repeating: "x", count: AuditLog.rotateBytes))
        try log.append(AuditEntry(ts: t0, action: .switchEnabled, result: .ok, appVersion: "1"))
        #expect(dir.exists("switch/audit.1.jsonl"))
        #expect(log.entries().count == 1, "the old file's junk line doesn't read")
        let line = try String(decoding: AuditEntry(ts: t0, action: .pointerSet, result: .ok, appVersion: "1",
                                                   account: AuditAccount(id: "acct-0123456789ab", label: "Team")).line(), as: UTF8.self)
        #expect(line == #"{"account":{"id":"acct-0123456789ab","label":"Team"},"action":"pointer.set","appVersion":"1","result":"ok","ts":"2027-01-15T08:00:00.000Z","v":1}"# + "\n")
        #expect(line.hasSuffix("}\n") && line.filter { $0 == "\n" }.count == 1)
        #expect(AuditEntry.decode(line: Data(line.utf8))?.account?.label == "Team")
        // The entry type has no field for a title, a prompt or an email.
        let keys = Set(Mirror(reflecting: AuditEntry(ts: t0, action: .resumeOpened, result: .ok, appVersion: "1")).children.compactMap(\.label))
        #expect(keys.isDisjoint(with: ["title", "email", "prompt", "accountUuid", "organizationUuid"]))
    }

    @Test func resumeChoicesFollowTheRules() {
        let dir = TempDir()
        let folders = SwitchFolder.list(home: dir.path, extra: [dir.sub("team")])
        let accounts = [AccountInfo(id: "acct-0123456789ab", loginConfigDirs: [dir.sub("team") + "/"])]
        var e = SessionHistoryEntry(agent: .claudeCode, sessionId: "11111111-2222-3333-4444-555555555555", startedAt: t0, lastActivityAt: t0,
                                    transcriptPath: dir.sub(".claude/projects/p/x.jsonl"))
        var c = ResumePlanner.choices(entry: e, fleet: nil, switchOn: true, folders: folders, accounts: accounts) { $0.isDefault }
        #expect(c.block == nil && !c.copyOnly)
        #expect(c.options.map(\.block) == [nil, .notShared])
        #expect(c.options.map(\.accountID) == [nil, "acct-0123456789ab"], "an unreadable login stays unknown")
        #expect(ResumePlanner.choices(entry: e, fleet: nil, switchOn: false, folders: folders, accounts: []) { _ in true }.block == .off)
        e.live = true
        #expect(ResumePlanner.choices(entry: e, fleet: nil, switchOn: true, folders: folders, accounts: []) { _ in true }.block == .live)
        e.live = false
        let fleet = FleetSnapshot(generatedAt: t0, sessions: [FleetSession(agent: .claudeCode, sessionId: e.sessionId, status: .unknown)])
        #expect(ResumePlanner.choices(entry: e, fleet: fleet, switchOn: true, folders: folders, accounts: []) { _ in true }.block == .live,
                "a status Signalbox can't read counts as running")
        e.entrypoint = "claude-desktop"
        #expect(ResumePlanner.choices(entry: e, fleet: nil, switchOn: true, folders: folders, accounts: []) { _ in true }.copyOnly)
        e.hasTranscript = false
        #expect(ResumePlanner.choices(entry: e, fleet: nil, switchOn: true, folders: folders, accounts: []) { _ in true }.block == .noTranscript)
        var codex = SessionHistoryEntry(agent: .codex, sessionId: "x", startedAt: t0, lastActivityAt: t0, transcriptPath: "/t")
        codex.hasTranscript = true
        #expect(ResumePlanner.choices(entry: codex, fleet: nil, switchOn: true, folders: folders, accounts: []) { _ in true }.block == .notClaudeCode)
    }

    @Test func canSeeFollowsTheRealTree() throws {
        let dir = TempDir()
        let c = makeController(dir)
        let file = dir.write(".claude/projects/p/s.jsonl")
        dir.mkdir("team")
        let def = SwitchFolder(path: dir.sub(".claude"), isDefault: true)
        let team = SwitchFolder(path: dir.sub("team"), isDefault: false)
        #expect(c.canSee(file, from: def))
        #expect(!c.canSee(file, from: team))
        try FileManager.default.createSymbolicLink(atPath: dir.sub("team/projects"), withDestinationPath: dir.sub(".claude/projects"))
        #expect(c.canSee(file, from: team))
    }

    @Test func theLocatorSkipsTheShim() throws {
        let dir = TempDir()
        let c = makeController(dir)
        dir.write("switch/bin/claude", ShimScript.text(pointerPath: c.paths.pointer), mode: 0o700)
        let real = fakeClaude(in: dir)
        dir.write("copy/claude", ShimScript.text(pointerPath: c.paths.pointer), mode: 0o755)
        let found = c.claudePath(searchPATH: "\(c.paths.binDir):\(dir.sub("copy")):\(dir.sub("real bin"))",
                                 environment: ["HOME": dir.sub("nohome"), "SIGNALBOX_BIN_DIRS": ""])
        #expect(found == real)
        // Shims in the fallback folders are skipped too; nothing real anywhere: none, never the shim.
        #expect(c.claudePath(searchPATH: "", environment: ["HOME": dir.sub("nohome"), "SIGNALBOX_BIN_DIRS": "\(dir.sub("copy")):\(dir.sub("real bin"))"]) == real)
        #expect(c.claudePath(searchPATH: c.paths.binDir, environment: ["HOME": dir.sub("nohome"), "SIGNALBOX_BIN_DIRS": dir.sub("copy")]) == nil)
        #expect(c.claudePath(searchPATH: "", environment: ["HOME": dir.sub("nohome"), "SIGNALBOX_CLAUDE_BIN": real]) == real)
    }
}
