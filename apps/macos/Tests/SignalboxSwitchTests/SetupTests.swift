import Foundation
import Testing
@testable import SignalboxKit
@testable import SignalboxSwitch

// The shared-sessions setup: the plan's checks, and every step run for real on a synthetic layout in a temporary
// folder, then undone with the generated script.

@Suite("Shared-sessions setup")
@MainActor
struct SetupTests {
    /// ~/.claude with two projects; a second folder with one project of its own, one shared project, and a clash.
    @MainActor
    struct Layout {
        let dir = TempDir()
        let def: SwitchFolder
        let team: SwitchFolder
        let controller: SwitchController

        init(clash: Bool = true, fs: any SwitchFileSystem = PosixFileSystem()) {
            def = SwitchFolder(path: dir.sub("home/.claude"), isDefault: true)
            team = SwitchFolder(path: dir.sub("home/.claude-team"), isDefault: false)
            dir.write("home/.claude/projects/-code-app/aaaaaaaa-0000-0000-0000-000000000001.jsonl")
            dir.write("home/.claude/projects/-code-app/memory/MEMORY.md")
            dir.write("home/.claude/projects/-code-site/aaaaaaaa-0000-0000-0000-000000000002.jsonl")
            dir.write("home/.claude-team/projects/-code-app/bbbbbbbb-0000-0000-0000-000000000001.jsonl")
            dir.write("home/.claude-team/projects/-code-app/bbbbbbbb-0000-0000-0000-000000000001/subagents/agent-1.jsonl")
            if clash { dir.write("home/.claude-team/projects/-code-app/memory/MEMORY.md", "the team's own notes\n") }
            dir.write("home/.claude-team/projects/-code-app/.DS_Store")
            dir.write("home/.claude-team/projects/-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl")
            dir.mkdir("home/.claude-team/sessions")
            controller = makeController(dir, fs: fs)
        }

        func inputs(threshold: Int = 90, days: [Int?] = [365, 365], running: [String] = [], second: SwitchFolder? = nil,
                    joining: [SwitchFolder] = []) -> SetupInputs {
            controller.setupInputs(second: second ?? team, defaultFolder: def, joining: joining,
                                   retention: [RetentionInput(folder: def.path, days: days[0]), RetentionInput(folder: (second ?? team).path, days: days[1])],
                                   threshold: threshold, runningSessions: running)
        }

        func runAll(setAside: Bool, run: String) throws {
            var plan = SetupPlanner.make(inputs(), setAside: setAside)
            while let step = plan.steps.first {
                try controller.runSetupStep(step, inputs: inputs(), setAside: setAside, run: run)
                plan = SetupPlanner.make(inputs(), setAside: setAside)
            }
        }
    }

    @Test func theChecksBlockWhatTheyShould() throws {
        let l = Layout()
        var plan = SetupPlanner.make(l.inputs(), setAside: false)
        #expect(plan.checks.first { $0.id == "on" }?.passed == false, "switching is off")
        try l.controller.enable(.oneHour)
        plan = SetupPlanner.make(l.inputs(), setAside: false)
        #expect(plan.checksPass, "\(plan.checks.filter { !$0.passed })")
        #expect(plan.clashes == ["-code-app/memory"])
        #expect(!plan.canRun && plan.blockedByClashes)
        #expect(SetupPlanner.make(l.inputs(), setAside: true).canRun)

        func failing(_ i: SetupInputs) -> [String] { SetupPlanner.make(i, setAside: true).checks.filter { !$0.passed }.map(\.id) }
        #expect(failing(l.inputs(days: [365, 30])) == ["retention:\(l.team.path)"])
        #expect(failing(l.inputs(days: [365, 200])) == ["retention:\(l.team.path)"], "shorter than the default folder's")
        #expect(failing(l.inputs(days: [365, nil])) == ["retention:\(l.team.path)"], "unknown blocks")
        #expect(failing(l.inputs(threshold: 0, days: [60, 60])) == ["retention:\(l.def.path)", "retention:\(l.team.path)"], "90 days when the warning is off")
        #expect(failing(l.inputs(threshold: 30, days: [60, 60])).isEmpty)
        #expect(failing(l.inputs(running: ["session 1a2b3c"])) == ["running"])
        var i = l.inputs()
        i.sameVolume = false
        #expect(failing(i) == ["volume"])
        i = l.inputs()
        i.exclusiveRename = false
        #expect(failing(i) == ["rename"])
        // A registered process that still exists counts as running (this test's own pid).
        l.dir.write("home/.claude-team/sessions/\(getpid()).json", "{}")
        #expect(failing(l.inputs()) == ["running"])
        l.dir.write("home/.claude-team/sessions/999999.json", "{}")
        try FileManager.default.removeItem(atPath: l.dir.sub("home/.claude-team/sessions/\(getpid()).json"))
        #expect(failing(l.inputs()).isEmpty, "a stale registry file whose process is gone doesn't block")
        // So does one in a third folder that already shares the second folder's tree.
        l.dir.write("home/.claude-third/sessions/\(getpid()).json", "{}")
        #expect(failing(l.inputs(joining: [SwitchFolder(path: l.dir.sub("home/.claude-third"), isDefault: false)])) == ["running"])
    }

    @Test func theDefaultFolderUnderAnotherSpellingIsRefused() throws {
        let l = Layout()
        try l.controller.enable(.oneHour)
        try FileManager.default.createSymbolicLink(atPath: l.dir.sub("homelink"), withDestinationPath: l.dir.sub("home"))
        let alias = SwitchFolder(path: l.dir.sub("homelink/.claude"), isDefault: false)
        let plan = SetupPlanner.make(l.inputs(second: alias), setAside: true)
        #expect(!plan.canRun && plan.steps.isEmpty && !plan.alreadyDone)
        #expect(plan.checks.first { $0.id == "folder" }?.passed == false)
        // A projects folder that is a link into the shared tree, through its parent, is refused too.
        l.dir.mkdir("odd")
        try FileManager.default.createSymbolicLink(atPath: l.dir.sub("odd/.claude-x"), withDestinationPath: l.dir.sub("home/.claude"))
        let inside = SetupPlanner.make(l.inputs(second: SwitchFolder(path: l.dir.sub("odd/.claude-x"), isDefault: false)), setAside: true)
        #expect(!inside.canRun && inside.steps.isEmpty)
    }

    @Test func runningEveryStepThenUndoingRestoresTheSecondFolderAndKeepsLaterSessions() throws {
        let l = Layout()
        try l.controller.enable(.oneHour)
        let teamBefore = l.dir.tree("home/.claude-team")
        let sharedBefore = l.dir.tree("home/.claude/projects")
        let run = "run-1"
        let plan = SetupPlanner.make(l.inputs(), setAside: true)
        #expect(plan.steps.map(\.kind) == [.moveProjects, .moveEntries, .setAside, .link])
        let shared = try #require(plan.steps.last?.link?.to)
        try l.runAll(setAside: true, run: run)
        #expect(SetupPlanner.make(l.inputs(), setAside: true).alreadyDone)
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: l.team.projects)) == shared)
        let tree = l.dir.tree("home/.claude/projects")
        #expect(tree.contains("-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl"))
        #expect(tree.contains("-code-app/bbbbbbbb-0000-0000-0000-000000000001/subagents/agent-1.jsonl"))
        #expect(l.dir.read("home/.claude/projects/-code-app/memory/MEMORY.md") == "synthetic\n", "the default folder's copy stays")
        #expect(l.dir.read("home/.claude-team/projects-set-aside/-code-app/memory/MEMORY.md") == "the team's own notes\n")
        #expect(l.dir.exists("home/.claude-team/projects-set-aside/-code-app/.DS_Store"))
        let actions = l.controller.auditEntries().filter { $0.run == run }.map(\.action)
        #expect(actions.first == "setup.finished" && actions.last == "setup.checked")
        #expect(actions.filter { $0 == "setup.step" }.count == 4)

        // New sessions after the setup, in a project folder the setup created and in one both trees had.
        l.dir.write("home/.claude/projects/-code-work/cccccccc-0000-0000-0000-000000000001.jsonl")
        l.dir.write("home/.claude/projects/-code-app/cccccccc-0000-0000-0000-000000000002.jsonl")

        // The undo script, run by "you", puts every logged entry back and leaves the new sessions where they are.
        let script = try #require(l.controller.undoScript(run: run))
        let r = runProcess(l.dir.write("undo.sh", script, mode: 0o700), [], environment: ["PATH": "/usr/bin:/bin"])
        #expect(r.status == 0, "\(r.err)")
        #expect(l.dir.tree("home/.claude-team").filter { !$0.hasPrefix("projects-set-aside") } == teamBefore)
        #expect(l.dir.tree("home/.claude/projects") == (sharedBefore + ["-code-work", "-code-work/cccccccc-0000-0000-0000-000000000001.jsonl",
                                                                         "-code-app/cccccccc-0000-0000-0000-000000000002.jsonl"]).sorted())
    }

    @Test func undoBeforeTheLinkChangesNothingWhenAPlaceIsTaken() throws {
        let l = Layout(clash: false)
        try l.controller.enable(.oneHour)
        let first = try #require(SetupPlanner.make(l.inputs(), setAside: false).steps.first)
        try l.controller.runSetupStep(first, inputs: l.inputs(), setAside: false, run: "r")
        l.controller.setupClosed(run: "r", folder: l.team)
        #expect(l.controller.auditEntries().first?.result == "cancelled")
        #expect(l.controller.unfinishedRun(for: l.team) == "r", "reopening continues the same run")
        // Something new takes an original place: the undo refuses before moving anything.
        l.dir.write("home/.claude-team/projects/-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl", "new")
        let script = try #require(l.controller.undoScript(run: "r"))
        let r = runProcess(l.dir.write("undo.sh", script, mode: 0o700), [], environment: ["PATH": "/usr/bin:/bin"])
        #expect(r.status == 1 && r.err.contains("nothing was changed"))
        #expect(l.dir.exists("home/.claude/projects/-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl"))
        #expect(UndoScript.text(secondFolder: l.team.path, sharedTree: nil, moves: [AuditMove(from: "/a\nb", to: "/c")], run: "r", at: Date()) == nil,
                "an unclean path refuses the whole script")
    }

    @Test func aChangeBetweenStepsStopsTheSetup() throws {
        let l = Layout(clash: false)
        try l.controller.enable(.oneHour)
        let first = try #require(SetupPlanner.make(l.inputs(), setAside: false).steps.first)
        // A new project appears in the second tree after the sheet showed the plan.
        l.dir.write("home/.claude-team/projects/-code-new/cccccccc-0000-0000-0000-000000000001.jsonl")
        #expect(throws: SwitchError.self) { try l.controller.runSetupStep(first, inputs: l.inputs(), setAside: false, run: "r") }
        #expect(l.dir.exists("home/.claude-team/projects/-code-work"), "nothing moved")
        #expect(l.controller.auditEntries().first?.action == "setup.stopped")
    }

    @Test func anExclusiveRenameNeverReplacesWhatAppearedAfterThePlan() throws {
        let fs = HookedFileSystem()
        let l = Layout(clash: false, fs: fs)
        try l.controller.enable(.oneHour)
        let first = try #require(SetupPlanner.make(l.inputs(), setAside: false).steps.first)
        #expect(first.kind == .moveProjects)
        let inputs = l.inputs()
        // Between the last check and the move, the target appears.
        fs.beforeRename = { _, to in try? Data("appeared".utf8).write(to: URL(fileURLWithPath: to)) }
        #expect(throws: SwitchError.self) { try l.controller.runSetupStep(first, inputs: inputs, setAside: false, run: "r") }
        #expect(l.dir.read("home/.claude/projects/-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl") == "appeared")
        #expect(l.dir.read("home/.claude-team/projects/-code-work/bbbbbbbb-0000-0000-0000-000000000002.jsonl") == "synthetic\n")
        let log = l.controller.auditEntries()
        #expect(log.first?.action == "setup.stopped" && log.first?.result == "failed")
        #expect(log.dropFirst().first?.action == "setup.step" && log.dropFirst().first?.result == "failed")
    }

    @Test func namesThatDifferOnlyByCaseAreOneNameOnACaseInsensitiveVolume() throws {
        let dir = TempDir()
        dir.write("home/.claude/projects/-code-app/a.jsonl")
        dir.write("home/.claude/projects/-code-app/MEMORY")
        dir.write("home/.claude-team/projects/-Code-App/b.jsonl")
        dir.write("home/.claude-team/projects/-Code-App/memory")
        let c = makeController(dir)
        try c.enable(.oneHour)
        let def = SwitchFolder(path: dir.sub("home/.claude"), isDefault: true)
        let team = SwitchFolder(path: dir.sub("home/.claude-team"), isDefault: false)
        var i = c.setupInputs(second: team, defaultFolder: def, retention: [RetentionInput(folder: def.path, days: 365), RetentionInput(folder: team.path, days: 365)],
                              threshold: 90, runningSessions: [])
        i.caseInsensitive = true
        let plan = SetupPlanner.make(i, setAside: false)
        #expect(plan.clashes == ["-Code-App/memory"])
        #expect(plan.steps.first { $0.kind == .moveEntries }?.moves == [AuditMove(from: "\(team.projects)/-Code-App/b.jsonl", to: "\(i.sharedTree!)/-code-app/b.jsonl")])
        i.caseInsensitive = false
        #expect(SetupPlanner.make(i, setAside: false).clashes.isEmpty, "a case-sensitive volume keeps them apart")
    }

    @Test func aMissingProjectsFolderOnlyNeedsTheLink() throws {
        let dir = TempDir()
        dir.write("home/.claude/projects/p/s.jsonl")
        dir.mkdir("home/.claude-team")
        let c = makeController(dir)
        try c.enable(.oneHour)
        let def = SwitchFolder(path: dir.sub("home/.claude"), isDefault: true)
        let team = SwitchFolder(path: dir.sub("home/.claude-team"), isDefault: false)
        let i = c.setupInputs(second: team, defaultFolder: def, retention: [RetentionInput(folder: def.path, days: 365), RetentionInput(folder: team.path, days: 365)],
                              threshold: 90, runningSessions: [])
        let plan = SetupPlanner.make(i, setAside: false)
        #expect(plan.canRun && plan.steps.map(\.kind) == [.link] && plan.steps[0].removeDirectories.isEmpty)
        // A link somewhere else is refused.
        try FileManager.default.createSymbolicLink(atPath: team.projects, withDestinationPath: dir.sub("elsewhere"))
        let other = SetupPlanner.make(c.setupInputs(second: team, defaultFolder: def, retention: i.retention, threshold: 90, runningSessions: []), setAside: false)
        #expect(!other.canRun && other.checks.first { $0.id == "state" }?.passed == false)
    }
}
