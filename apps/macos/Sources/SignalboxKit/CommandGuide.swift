import Foundation

// The Commands screen's logic, kept pure so it can be tested: which entries a filter keeps, how search ranks them,
// how they group into sections, and what the Copy button puts on the clipboard.

/// One built-in command of one agent, as a row of the guide.
public struct CommandEntry: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable { case slash, shell }

    public let agent: AgentID
    public let kind: Kind
    public let command: CatalogCommand

    public init(agent: AgentID, kind: Kind, command: CatalogCommand) {
        self.agent = agent
        self.kind = kind
        self.command = command
    }

    public var id: String { "\(agent.rawValue)|\(kind.rawValue)|\(command.name)" }
}

/// Which commands the "Can Signalbox run it" filter keeps.
public enum CommandRunFilter: String, CaseIterable, Identifiable, Sendable {
    case any, shown, planned, runInSession, notOffered

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .any: "Any"
        case .shown: "Shown in Signalbox"
        case .planned: "Planned"
        case .runInSession: "Run it in the session"
        case .notOffered: "Not offered"
        }
    }

    public func keeps(_ status: CommandRunStatus) -> Bool {
        switch self {
        case .any: true
        case .shown: status == .view
        case .planned: status == .planned
        case .runInSession: status == .no
        case .notOffered: status == .never
        }
    }

    /// Custom commands are run in the session (Signalbox never runs them), except Codex legacy prompts: recent
    /// Codex CLI releases don't load those, so they only show under Any.
    public func keeps(_ c: CustomCommand) -> Bool {
        switch self {
        case .any: true
        case .runInSession: !c.isLegacyPrompt
        default: false
        }
    }
}

/// The Commands screen's filters.
public struct CommandFilter: Equatable, Sendable {
    /// nil: every agent.
    public var agent: AgentID?
    /// nil: every category.
    public var category: CommandCategory?
    public var run: CommandRunFilter
    public var query: String

    public init(agent: AgentID? = nil, category: CommandCategory? = nil, run: CommandRunFilter = .any, query: String = "") {
        self.agent = agent
        self.category = category
        self.run = run
        self.query = query
    }

    public var isSearching: Bool { !CommandGuide.normalize(query).isEmpty }
    /// True when anything other than the search narrows the list.
    public var hasFilters: Bool { agent != nil || category != nil || run != .any }
}

/// A group of rows on the Commands screen.
public struct CommandGuideSection: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        /// The user's own commands, skills and plugin commands.
        case custom
        case category(CommandCategory)
        /// Shell commands such as "claude agents --json".
        case shell
    }

    public let kind: Kind
    public var commands: [CommandEntry]
    public var custom: [CustomCommand]

    public var id: String {
        switch kind {
        case .custom: "custom"
        case let .category(c): "category:\(c.rawValue)"
        case .shell: "shell"
        }
    }

    public var title: String {
        switch kind {
        case .custom: "Your commands"
        case let .category(c): c.title
        case .shell: "Shell commands"
        }
    }

    public var count: Int { commands.count + custom.count }
}

public enum CommandGuide {
    /// Every built-in slash command, then every shell command, of every catalog.
    public static func entries(_ data: CommandsData) -> [CommandEntry] {
        data.catalogs.flatMap { cat in
            cat.commands.map { CommandEntry(agent: cat.agent, kind: .slash, command: $0) }
                + cat.cliCommands.map { CommandEntry(agent: cat.agent, kind: .shell, command: $0) }
        }
    }

    /// Lowercased, trimmed, inner whitespace collapsed.
    public static func normalize(_ query: String) -> String {
        query.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// "/compact" and "$skill" match "compact" and "skill": the leading sigil is optional when searching.
    private static func bare(_ s: String) -> String {
        var t = s.lowercased()
        while let f = t.first, f == "/" || f == "$" { t.removeFirst() }
        return t
    }

    /// How well a command matches the search; lower is better, nil is no match. Every word of the query has to
    /// appear somewhere (name, aliases, arguments, summary, details, category). Exact names rank first, then names
    /// that start with the query, then aliases, then names containing it, then text matches.
    public static func score(name: String, aliases: [String], text: [String], query: String) -> Int? {
        let q = normalize(query)
        guard !q.isEmpty else { return 0 }
        let words = q.split(separator: " ").map(String.init)
        let names = ([name] + aliases).map { $0.lowercased() }
        let haystack = (names + text.map { $0.lowercased() }).joined(separator: "\n")
        guard words.allSatisfy({ haystack.contains($0) || haystack.contains(bare($0)) }) else { return nil }
        let bq = bare(q)
        let bn = bare(name)
        let ba = aliases.map(bare)
        if bn == bq { return 0 }
        if ba.contains(bq) { return 1 }
        if bn.hasPrefix(bq) { return 2 }
        if ba.contains(where: { $0.hasPrefix(bq) }) { return 3 }
        if bn.contains(bq) || ba.contains(where: { $0.contains(bq) }) { return 4 }
        return 5
    }

    public static func score(_ c: CatalogCommand, query: String) -> Int? {
        score(name: c.name, aliases: c.allAliases, text: [c.args, c.summary, c.details, c.category.title].compactMap { $0 }, query: query)
    }

    public static func score(_ c: CustomCommand, query: String) -> Int? {
        score(name: c.name, aliases: [], text: [c.shortDescription, c.kindTitle, c.scope.title, c.source, c.project.flatMap { Fmt.basename($0) }].compactMap { $0 }, query: query)
    }

    /// The sections the filter leaves, in display order: the user's own commands, then categories in their fixed
    /// order (unknown ones after, by name), then shell commands. Empty sections are dropped. Rows sort by search
    /// rank when searching, then by name, then by agent (so the same command of different agents sits together).
    public static func sections(_ data: CommandsData, filter: CommandFilter) -> [CommandGuideSection] {
        let searching = filter.isSearching
        var out: [CommandGuideSection] = []

        if filter.category == nil {
            let custom = data.custom
                .filter { filter.agent == nil || $0.agent == filter.agent }
                .filter { filter.run.keeps($0) }
                .compactMap { c in score(c, query: filter.query).map { (c, $0) } }
                .sorted { a, b in
                    if searching, a.1 != b.1 { return a.1 < b.1 }
                    return order(a.0.name, a.0.agent, b.0.name, b.0.agent)
                }
                .map(\.0)
            if !custom.isEmpty { out.append(CommandGuideSection(kind: .custom, commands: [], custom: custom)) }
        }

        let kept = entries(data)
            .filter { filter.agent == nil || $0.agent == filter.agent }
            .filter { filter.category == nil || $0.command.category == filter.category }
            .filter { filter.run.keeps($0.command.signalbox.status) }
            .compactMap { e in score(e.command, query: filter.query).map { (e, $0) } }
        func sorted(_ rows: [(CommandEntry, Int)]) -> [CommandEntry] {
            rows.sorted { a, b in
                if searching, a.1 != b.1 { return a.1 < b.1 }
                return order(a.0.command.name, a.0.agent, b.0.command.name, b.0.agent)
            }.map(\.0)
        }
        let slash = Dictionary(grouping: kept.filter { $0.0.kind == .slash }, by: { $0.0.command.category })
        for category in slash.keys.sorted() {
            out.append(CommandGuideSection(kind: .category(category), commands: sorted(slash[category] ?? []), custom: []))
        }
        let shell = kept.filter { $0.0.kind == .shell }
        if !shell.isEmpty { out.append(CommandGuideSection(kind: .shell, commands: sorted(shell), custom: [])) }
        return out
    }

    private static func order(_ na: String, _ aa: AgentID, _ nb: String, _ ab: AgentID) -> Bool {
        let a = bare(na), b = bare(nb)
        if a != b { return a < b }
        if aa != ab { return aa < ab }
        return na < nb
    }

    /// Categories that have at least one built-in command for `agent` (every agent when nil), in display order.
    public static func categories(_ data: CommandsData, agent: AgentID?) -> [CommandCategory] {
        let cats = entries(data).filter { agent == nil || $0.agent == agent }.map(\.command.category)
        return Set(cats).sorted()
    }

    /// Finds a guide row (built-in or custom) by its id.
    public static func row(id: String?, in data: CommandsData) -> GuideRow? {
        guard let id else { return nil }
        if let c = data.custom.first(where: { $0.id == id }) { return .custom(c) }
        if let e = entries(data).first(where: { $0.id == id }) { return .builtIn(e) }
        return nil
    }

    // MARK: Copy

    /// What Copy puts on the clipboard for a built-in command: the command as you would type it, without argument
    /// placeholders ("/compact", "claude agents --json"; Gemini's "@<path>" copies "@").
    public static func copyText(_ c: CatalogCommand) -> String {
        let name = c.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let cut = name.firstIndex(where: { $0 == "<" || $0 == "[" }) else { return name }
        let head = name[..<cut].trimmingCharacters(in: .whitespaces)
        return head.isEmpty ? name : head
    }

    /// What Copy puts on the clipboard for a custom command: its name as the agent shows it ("/my-cmd", "$skill").
    public static func copyText(_ c: CustomCommand) -> String {
        c.name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The command and its arguments as a usage line: "/compact [instructions]".
    public static func usage(_ c: CatalogCommand) -> String {
        guard let args = c.args?.trimmingCharacters(in: .whitespaces), !args.isEmpty else { return c.name }
        return "\(c.name) \(args)"
    }

    // MARK: Versions

    /// Whether the installed version differs from the one the catalog was checked against.
    public static func versionNote(catalog: CommandCatalog?, installed: String?) -> VersionNote {
        guard let installed else { return .notInstalled }
        guard let checked = catalog?.verifiedVersion, !checked.isEmpty else { return .unchecked(installed: installed) }
        return checked == installed ? .matches(installed) : .differs(installed: installed, checked: checked)
    }

    public enum VersionNote: Equatable, Sendable {
        case matches(String)
        case differs(installed: String, checked: String)
        case unchecked(installed: String)
        case notInstalled
    }
}

/// A selected row: a built-in command or one of the user's own.
public enum GuideRow: Hashable, Sendable {
    case builtIn(CommandEntry)
    case custom(CustomCommand)

    public var agent: AgentID {
        switch self {
        case let .builtIn(e): e.agent
        case let .custom(c): c.agent
        }
    }

    public var copyText: String {
        switch self {
        case let .builtIn(e): CommandGuide.copyText(e.command)
        case let .custom(c): CommandGuide.copyText(c)
        }
    }
}
