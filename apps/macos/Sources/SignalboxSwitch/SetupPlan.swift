import Foundation

// The one-time "Set up shared sessions" plan (docs/SWITCH.md §1): pure, from a listing of both trees and the facts the
// checks need. The controller gathers the inputs, shows the plan, and runs one step at a time after asking, planning
// again before each step. Every move is one entry of a project folder (a transcript, a session's folder, memory/), so
// an undo moves back exactly what the setup moved, and sessions created later stay where they are.

/// One folder's retention, as the setup judges it.
public struct RetentionInput: Hashable, Sendable {
    public var folder: String
    /// Days Claude Code keeps transcripts there; nil when unknown or invalid.
    public var days: Int?
    public init(folder: String, days: Int?) {
        self.folder = folder
        self.days = days
    }
}

/// What the second folder's `projects` is now.
public enum ProjectsState: Equatable, Sendable {
    case directory
    case linkToShared
    case linkElsewhere(String)
    case missing
    case notADirectory
}

public struct SetupInputs: Sendable {
    public var switchOn: Bool
    /// The real path of the default folder's projects/; nil when it is missing.
    public var sharedTree: String?
    public var second: SwitchFolder
    public var secondState: ProjectsState
    /// The second folder is the default folder under another spelling, or its projects/ is inside the shared tree or
    /// holds it (through a link anywhere on the way). Planning anything then could empty the shared tree.
    public var overlapsShared: Bool
    /// Folders at the top of the second tree → the names inside each.
    public var secondDirectories: [String: [String]]
    /// Anything else at the top of the second tree.
    public var secondFiles: [String]
    /// Every name at the top of the shared tree.
    public var sharedNames: Set<String>
    /// For the shared folders whose names match a second-tree folder: the names inside, by the shared folder's name.
    public var sharedDirectories: [String: [String]]
    /// What is running in a folder that will share the tree, described for the sheet; empty when nothing is.
    public var running: [String]
    /// Every folder that will share the tree, the default folder first.
    public var retention: [RetentionInput]
    /// The warning threshold in Settings (0: off).
    public var threshold: Int
    public var sameVolume: Bool?
    public var exclusiveRename: Bool?
    /// The shared tree's volume ignores case (APFS's default), so `Code` and `code` are one name there.
    public var caseInsensitive: Bool

    public init(switchOn: Bool, sharedTree: String?, second: SwitchFolder, secondState: ProjectsState, overlapsShared: Bool = false,
                secondDirectories: [String: [String]] = [:], secondFiles: [String] = [], sharedNames: Set<String> = [],
                sharedDirectories: [String: [String]] = [:], running: [String] = [], retention: [RetentionInput] = [],
                threshold: Int, sameVolume: Bool?, exclusiveRename: Bool?, caseInsensitive: Bool = true) {
        self.switchOn = switchOn
        self.sharedTree = sharedTree
        self.second = second
        self.secondState = secondState
        self.overlapsShared = overlapsShared
        self.secondDirectories = secondDirectories
        self.secondFiles = secondFiles
        self.sharedNames = sharedNames
        self.sharedDirectories = sharedDirectories
        self.running = running
        self.retention = retention
        self.threshold = threshold
        self.sameVolume = sameVolume
        self.exclusiveRename = exclusiveRename
        self.caseInsensitive = caseInsensitive
    }
}

public struct SetupCheck: Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var passed: Bool
    public var detail: String
}

public enum SetupStepKind: String, Sendable {
    case moveProjects, moveEntries, setAside, link
}

public struct SetupStep: Identifiable, Hashable, Sendable {
    public var kind: SetupStepKind
    public var number: Int
    public var title: String
    public var createDirectories: [String] = []
    public var moves: [AuditMove] = []
    public var removeDirectories: [String] = []
    /// `from`: the link to create; `to`: its target.
    public var link: AuditMove?

    public var id: String { kind.rawValue }

    /// The same work, whatever its number (a step is planned again before it runs).
    public func sameWork(as other: SetupStep) -> Bool {
        kind == other.kind && createDirectories == other.createDirectories && moves == other.moves
            && removeDirectories == other.removeDirectories && link == other.link
    }
}

public struct SetupPlan: Sendable {
    public var checks: [SetupCheck]
    /// Paths relative to the second tree that exist in both trees.
    public var clashes: [String]
    public var steps: [SetupStep]
    public var alreadyDone: Bool
    public var setAside: Bool

    public var checksPass: Bool { checks.allSatisfy(\.passed) }
    public var blockedByClashes: Bool { !clashes.isEmpty && !setAside }
    public var canRun: Bool { !alreadyDone && checksPass && !blockedByClashes && !steps.isEmpty }
}

public enum SetupPlanner {
    /// The retention the setup asks for when the warning is off (Settings ▸ Advanced ▸ Never warn).
    public static let minimumDaysWhenWarningOff = 90
    public static let setAsideFolder = "projects-set-aside"
    /// Finder's folder metadata: always moved aside, never a clash.
    static let finderMetadata = ".DS_Store"

    /// How the volume compares names: APFS ignores Unicode normalization always, and case unless formatted otherwise.
    public static func key(_ name: String, caseInsensitive: Bool) -> String {
        let n = name.precomposedStringWithCanonicalMapping
        return caseInsensitive ? n.lowercased() : n
    }

    public static func make(_ i: SetupInputs, setAside: Bool) -> SetupPlan {
        var checks: [SetupCheck] = []
        checks.append(SetupCheck(id: "on", title: "Account switching is on", passed: i.switchOn,
                                 detail: i.switchOn ? "On" : "Turn it on in Settings ▸ Advanced"))
        let folderOK = !i.second.isDefault && !i.overlapsShared
        checks.append(SetupCheck(id: "folder", title: "A second folder to link", passed: folderOK,
                                 detail: i.second.isDefault ? "~/.claude holds the shared tree; choose another folder"
                                     : i.overlapsShared ? "\(i.second.path) is ~/.claude or overlaps its projects folder (through a link)" : i.second.path))
        checks.append(SetupCheck(id: "tree", title: "The shared tree exists", passed: i.sharedTree != nil,
                                 detail: i.sharedTree ?? "~/.claude/projects is missing"))
        checks.append(contentsOf: retentionChecks(i))
        checks.append(SetupCheck(id: "running", title: "Nothing is running in the folders that will share", passed: i.running.isEmpty,
                                 detail: i.running.isEmpty ? "Nothing" : "Quit first: \(i.running.joined(separator: ", "))"))
        let isDirectory = i.secondState == .directory
        if isDirectory {
            checks.append(SetupCheck(id: "volume", title: "Both trees are on one volume", passed: i.sameVolume == true,
                                     detail: i.sameVolume == nil ? "Can't tell" : i.sameVolume! ? "Yes: every move is a rename" : "No: Signalbox never copies and deletes"))
            checks.append(SetupCheck(id: "rename", title: "The volume supports exclusive renames", passed: i.exclusiveRename == true,
                                     detail: i.exclusiveRename == true ? "Yes" : "No: a move could replace a file that appeared meanwhile"))
        }
        let state: SetupCheck = switch i.secondState {
        case .directory: SetupCheck(id: "state", title: "Its projects folder is a real folder", passed: true, detail: "Yes")
        case .missing: SetupCheck(id: "state", title: "Its projects folder", passed: true, detail: "Not there yet: the setup only creates the link")
        case .linkToShared: SetupCheck(id: "state", title: "Its projects folder", passed: true, detail: "Already a link to the shared tree")
        case let .linkElsewhere(t): SetupCheck(id: "state", title: "Its projects folder is a real folder", passed: false, detail: "It is a link to \(t)")
        case .notADirectory: SetupCheck(id: "state", title: "Its projects folder is a real folder", passed: false, detail: "It isn't a folder")
        }
        checks.append(state)

        guard i.secondState != .linkToShared, !i.overlapsShared else {
            return SetupPlan(checks: checks, clashes: [], steps: [], alreadyDone: i.secondState == .linkToShared && !i.overlapsShared, setAside: setAside)
        }
        guard let shared = i.sharedTree, isDirectory || i.secondState == .missing else {
            return SetupPlan(checks: checks, clashes: [], steps: [], alreadyDone: false, setAside: setAside)
        }

        let fold = { (n: String) in key(n, caseInsensitive: i.caseInsensitive) }
        var sharedByKey: [String: String] = [:]
        for n in i.sharedNames.sorted() where sharedByKey[fold(n)] == nil { sharedByKey[fold(n)] = n }
        let source = i.second.projects
        let aside = i.second.path + "/" + setAsideFolder
        var newFolders: [String] = []
        var projects: [AuditMove] = []
        var entries: [AuditMove] = []
        var clashes: [String] = []
        var finder: [String] = []
        var emptied: [String] = []
        for name in i.secondDirectories.keys.sorted() {
            let inside = (i.secondDirectories[name] ?? []).sorted()
            if let sharedName = sharedByKey[fold(name)] {
                guard let inShared = i.sharedDirectories[sharedName] else {
                    clashes.append(name)
                    continue
                }
                let there = Set(inShared.map(fold))
                for e in inside {
                    if e == finderMetadata { finder.append("\(name)/\(e)") }
                    else if there.contains(fold(e)) { clashes.append("\(name)/\(e)") }
                    else { entries.append(AuditMove(from: "\(source)/\(name)/\(e)", to: "\(shared)/\(sharedName)/\(e)")) }
                }
            } else {
                let movable = inside.filter { $0 != finderMetadata }
                finder += inside.filter { $0 == finderMetadata }.map { "\(name)/\($0)" }
                if !movable.isEmpty { newFolders.append("\(shared)/\(name)") }
                projects += movable.map { AuditMove(from: "\(source)/\(name)/\($0)", to: "\(shared)/\(name)/\($0)") }
            }
            emptied.append("\(source)/\(name)")
        }
        for name in i.secondFiles.sorted() {
            if name == finderMetadata { finder.append(name) }
            else if sharedByKey[fold(name)] != nil { clashes.append(name) }
            else { projects.append(AuditMove(from: "\(source)/\(name)", to: "\(shared)/\(name)")) }
        }

        var steps: [SetupStep] = []
        func add(_ s: SetupStep) {
            var s = s
            s.number = steps.count + 1
            steps.append(s)
        }
        if !projects.isEmpty {
            let n = newFolders.count
            add(SetupStep(kind: .moveProjects, number: 0,
                          title: n == 0 ? "Move \(count(projects.count, "entry", "entries")) into the shared tree"
                              : "Create \(count(n, "project folder", "project folders")) in the shared tree and move \(count(projects.count, "entry", "entries")) into them",
                          createDirectories: newFolders, moves: projects))
        }
        if !entries.isEmpty {
            add(SetupStep(kind: .moveEntries, number: 0, title: "Move \(count(entries.count, "entry", "entries")) into project folders both trees have", moves: entries))
        }
        let asideNames = (setAside ? clashes : []) + finder
        if !asideNames.isEmpty {
            let moves = asideNames.map { AuditMove(from: "\(source)/\($0)", to: "\(aside)/\($0)") }
            var dirs = [aside]
            for m in moves {
                let parent = (m.to as NSString).deletingLastPathComponent
                if parent != aside, !dirs.contains(parent) { dirs.append(parent) }
            }
            let what = clashes.isEmpty || !setAside ? "Finder's folder files" : count(asideNames.count, "clashing entry", "clashing entries")
            add(SetupStep(kind: .setAside, number: 0, title: "Set \(what) aside in \(aside)", createDirectories: dirs, moves: moves))
        }
        add(SetupStep(kind: .link, number: 0,
                      title: isDirectory ? "Remove the emptied folders and link \(source) to the shared tree" : "Link \(source) to the shared tree",
                      removeDirectories: isDirectory ? emptied + [source] : [],
                      link: AuditMove(from: source, to: shared)))
        return SetupPlan(checks: checks, clashes: clashes, steps: steps, alreadyDone: false, setAside: setAside)
    }

    static func retentionChecks(_ i: SetupInputs) -> [SetupCheck] {
        let required = i.threshold > 0 ? i.threshold : minimumDaysWhenWarningOff
        let defaultDays = i.retention.first?.days
        return i.retention.enumerated().map { index, r in
            let floor = index == 0 ? required : max(required, defaultDays ?? required)
            let title = "\(r.folder) keeps transcripts at least \(floor) days"
            guard let days = r.days else {
                return SetupCheck(id: "retention:\(r.folder)", title: title, passed: false, detail: "Unknown or invalid: see Health")
            }
            return SetupCheck(id: "retention:\(r.folder)", title: title, passed: days >= floor,
                              detail: days >= floor ? "\(days) days" : "\(days) days: raise cleanupPeriodDays first")
        }
    }

    private static func count(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n) \(n == 1 ? one : many)"
    }
}
