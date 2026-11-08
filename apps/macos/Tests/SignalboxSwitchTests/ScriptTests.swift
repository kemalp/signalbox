import Foundation
import Testing
@testable import SignalboxKit
@testable import SignalboxSwitch

// The shell text, run for real: the shim under /bin/sh and dash with a fake claude, the shell-profile lines under
// zsh and bash with a stale alias, resume scripts with awkward paths. Synthetic folders only; the processes get
// an empty environment apart from what each test sets, so no real login or config folder is ever involved.

@Suite("Shim and scripts")
struct ScriptTests {
    struct Shim {
        let dir = TempDir()
        let paths: SwitchPaths
        let shimDir: String
        let realDir: String

        init() {
            paths = SwitchPaths(root: dir.sub("home/Library/Application Support/signalbox/switch"))
            dir.write("home/Library/Application Support/signalbox/switch/bin/claude", ShimScript.text(pointerPath: paths.pointer), mode: 0o700)
            shimDir = paths.binDir
            _ = fakeClaude(in: dir)
            realDir = dir.sub("real bin")
            dir.mkdir("team dir")
        }

        func pointer(_ text: String?) {
            if let text { dir.write("home/Library/Application Support/signalbox/switch/active", text) }
            else { try? FileManager.default.removeItem(atPath: paths.pointer) }
        }

        func run(_ env: [String: String] = [:], shell: String = "/bin/sh", path: String? = nil, args: [String] = ["x"]) -> ShellResult {
            var e = ["HOME": dir.sub("home"), "PATH": path ?? "\(shimDir):\(realDir):/usr/bin:/bin"]
            e.merge(env) { $1 }
            return runProcess(shell, [paths.shim] + args, environment: e)
        }
    }

    @Test func theShimFollowsThePointer() {
        let s = Shim()
        var f = fields(s.run().out)
        #expect(f["CCD"] == "<unset>" && f["CHOSEN"] == "default", "no pointer: the default account")
        s.pointer("default\n")
        f = fields(s.run().out)
        #expect(f["CCD"] == "<unset>" && f["CHOSEN"] == "default")
        s.pointer(s.dir.sub("team dir") + "\n")
        f = fields(s.run(args: ["a", "b c"]).out)
        #expect(f["CCD"] == s.dir.sub("team dir"))
        #expect(f["CHOSEN"] == s.dir.sub("team dir"))
        #expect(f["args"] == "a b c")
        s.pointer(s.dir.sub("team dir"))
        #expect(fields(s.run().out)["CCD"] == s.dir.sub("team dir"), "no trailing newline")
    }

    @Test func anExplicitChoiceWinsAndIsPassedOn() {
        let s = Shim()
        s.pointer(s.dir.sub("team dir") + "\n")
        var f = fields(s.run(["CLAUDE_CONFIG_DIR": "/explicit"]).out)
        #expect(f["CCD"] == "/explicit" && f["CHOSEN"] == "/explicit")
        f = fields(s.run(["CLAUDE_CONFIG_DIR": "relative"]).out)
        #expect(f["CCD"] == "relative" && f["CHOSEN"] == "<unset>", "a relative path isn't carried to nested runs")
        // An outer run chose the default; the pointer has moved on since: the nested run keeps the default.
        f = fields(s.run(["SIGNALBOX_SWITCH_CHOSEN": "default"]).out)
        #expect(f["CCD"] == "<unset>")
        // Claude Code scrubbed CLAUDE_CONFIG_DIR from a subprocess: the choice comes back from SIGNALBOX_SWITCH_CHOSEN.
        s.pointer("default\n")
        f = fields(s.run(["SIGNALBOX_SWITCH_CHOSEN": s.dir.sub("team dir")]).out)
        #expect(f["CCD"] == s.dir.sub("team dir"))
    }

    @Test func aBadPointerNeverFallsBack() {
        let s = Shim()
        s.pointer(s.dir.sub("missing") + "\n")
        var r = s.run()
        #expect(r.status == 1 && r.out.isEmpty && r.err.contains("isn't a folder you own"))
        s.pointer("garbage\n")
        r = s.run()
        #expect(r.status == 1 && r.out.isEmpty && r.err.contains("can't read"))
        s.pointer("/usr\n")
        r = s.run()
        #expect(r.status == 1 && r.out.isEmpty && r.err.contains("isn't a folder you own"), "a folder someone else owns")
    }

    @Test func itExecsTheRealClaudeAndSkipsCopiesOfItself() throws {
        let s = Shim()
        // exec: the shell's pid is the fake claude's pid.
        let r = runProcess("/bin/sh", ["-c", "echo shell=$$; exec \"$0\" x", s.paths.shim],
                           environment: ["HOME": s.dir.sub("home"), "PATH": "\(s.shimDir):\(s.realDir):/usr/bin:/bin"])
        let f = fields(r.out)
        #expect(f["shell"] != nil && f["shell"] == f["pid"])
        // A symlinked copy of the shim earlier on PATH: no loop, the real claude still runs.
        s.dir.mkdir("other")
        try FileManager.default.createSymbolicLink(atPath: s.dir.sub("other/claude"), withDestinationPath: s.paths.shim)
        #expect(fields(s.run(path: "\(s.dir.sub("other")):\(s.shimDir):\(s.realDir):/usr/bin:/bin").out)["args"] == "x")
        // Nothing else on PATH.
        let none = s.run(path: "\(s.shimDir):/usr/bin:/bin")
        #expect(none.status == 127 && none.err.contains("no claude found"))
    }

    @Test func itRunsUnderDash() throws {
        guard FileManager.default.isExecutableFile(atPath: "/bin/dash") else { return }
        let s = Shim()
        s.pointer(s.dir.sub("team dir") + "\n")
        #expect(fields(s.run(shell: "/bin/dash").out)["CCD"] == s.dir.sub("team dir"))
    }

    @Test func theProfileLinesSurviveAStaleAlias() {
        let s = Shim()
        let rc = s.dir.write("rc", "alias claude='echo aliased'\n\(ShimScript.functionLines(shimPath: s.paths.shim))\nclaude hooked\n")
        let env = ["HOME": s.dir.sub("home"), "PATH": "\(s.realDir):/usr/bin:/bin"]
        let zsh = runProcess("/bin/zsh", ["-f", "-c", "source \(HistoryBrowser.shellQuote(rc))"], environment: env)
        #expect(fields(zsh.out)["args"] == "hooked", "zsh: \(zsh.err)")
        let bash = runProcess("/bin/bash", ["-c", "shopt -s expand_aliases; source \(HistoryBrowser.shellQuote(rc))"], environment: env)
        #expect(fields(bash.out)["args"] == "hooked", "bash: \(bash.err)")
        #expect(ShimScript.fishFunction(shimPath: "/a b/it's") == #"function claude; '/a b/it\'s' $argv; end"#)
        #expect(ShimScript.isShim(head: Data(ShimScript.text(pointerPath: "/p").utf8)))
        #expect(!ShimScript.isShim(head: Data("#!/bin/sh\nexec node cli.js\n".utf8)))
    }

    @Test func resumeScriptsQuoteEverythingAndDeleteThemselves() throws {
        let dir = TempDir()
        let claude = fakeClaude(in: dir, at: "it's \"bin\"/claude")
        let project = dir.mkdir("code/my app 'é'")
        let team = dir.mkdir("team $HOME `x`")
        let request = ResumeRequest(sessionId: "11111111-2222-3333-4444-555555555555", cwd: project,
                                    folder: SwitchFolder(path: team, isDefault: false), fork: true, claudePath: claude)
        let script = try #require(request.script)
        let file = dir.write("resume/one.command", script, mode: 0o700)
        let r = runProcess(file, [], environment: ["PATH": "/usr/bin:/bin", "CLAUDE_CONFIG_DIR": "/inherited"])
        let f = fields(r.out)
        #expect(f["cwd"] == project)
        #expect(f["CCD"] == team)
        #expect(f["CHOSEN"] == team)
        #expect(f["args"] == "--resume 11111111-2222-3333-4444-555555555555 --fork-session")
        #expect(!dir.exists("resume/one.command"), "the script removes itself")
        #expect(request.displayCommand?.contains("CLAUDE_CONFIG_DIR='\(team)'") == true)

        var plain = request
        plain.folder = SwitchFolder(path: dir.sub(".claude"), isDefault: true)
        plain.fork = false
        plain.cwd = nil
        let file2 = dir.write("resume/two.command", try #require(plain.script), mode: 0o700)
        let f2 = fields(runProcess(file2, [], environment: ["PATH": "/usr/bin:/bin", "CLAUDE_CONFIG_DIR": "/inherited"], cwd: dir.path).out)
        #expect(f2["CCD"] == "<unset>" && f2["CHOSEN"] == "default" && f2["args"] == "--resume 11111111-2222-3333-4444-555555555555")
        #expect(plain.displayCommand?.hasPrefix("env -u CLAUDE_CONFIG_DIR ") == true)
    }

    @Test func unfitRequestsGetNoScript() {
        let base = ResumeRequest(sessionId: "abc", cwd: "/p", folder: SwitchFolder(path: "/t", isDefault: false), fork: false, claudePath: "/c")
        #expect(base.script != nil)
        for bad in ["", "-rf", "a b", "a;b", "$(x)", String(repeating: "a", count: 200)] {
            var r = base
            r.sessionId = bad
            #expect(r.script == nil && r.displayCommand == nil, "\(bad)")
        }
        var r = base
        r.cwd = "/p\nrm -rf ~"
        #expect(r.script == nil)
        r = base
        r.claudePath = "claude"
        #expect(r.script == nil, "only an absolute claude path")
    }
}
