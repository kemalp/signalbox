import Foundation

// The command guide: what `signalbox commands --json` prints and the watch stream's "commands" line carries.
// Catalogs come from catalog/commands/<agent>.json (embedded in the CLI); custom commands are found by the CLI
// at runtime (names and descriptions only, never file bodies). Everything decodes leniently: unknown categories,
// statuses, kinds, scopes and surfaces are kept verbatim, and a malformed command is dropped, not fatal.

/// A string value from an open-ended set: known values get names and an order, unknown ones are kept as sent.
public protocol OpenStringValue: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral where RawValue == String {
    init(rawValue: String)
}

extension OpenStringValue {
    public init(stringLiteral value: String) { self.init(rawValue: value) }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    /// "remote_control" or "plugin-skill" → "Remote control" / "Plugin skill".
    public var readable: String {
        let words = rawValue.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// What a command is about. Known categories come in a fixed order; unknown ones sort after them by name.
public struct CommandCategory: OpenStringValue, Comparable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let session: CommandCategory = "session"
    public static let context: CommandCategory = "context"
    public static let model: CommandCategory = "model"
    public static let info: CommandCategory = "info"
    public static let config: CommandCategory = "config"
    public static let account: CommandCategory = "account"
    public static let tools: CommandCategory = "tools"
    public static let navigation: CommandCategory = "navigation"
    public static let integrations: CommandCategory = "integrations"
    public static let debug: CommandCategory = "debug"
    public static let other: CommandCategory = "other"

    public static let known: [CommandCategory] = [.session, .context, .model, .info, .config, .account, .tools, .navigation, .integrations, .debug, .other]

    public var title: String {
        switch self {
        case .session: "Session"
        case .context: "Context"
        case .model: "Model"
        case .info: "Information"
        case .config: "Settings"
        case .account: "Account"
        case .tools: "Tools"
        case .navigation: "Navigation"
        case .integrations: "Integrations"
        case .debug: "Debugging"
        case .other: "Other"
        default: readable
        }
    }

    public static func < (a: CommandCategory, b: CommandCategory) -> Bool {
        let ia = known.firstIndex(of: a) ?? known.count
        let ib = known.firstIndex(of: b) ?? known.count
        return ia != ib ? ia < ib : a.rawValue < b.rawValue
    }
}

/// Whether Signalbox can do something with a command (`signalbox.status` in the catalog).
public struct CommandRunStatus: OpenStringValue {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    /// Signalbox already shows this information.
    public static let view: CommandRunStatus = "view"
    /// Could be run from Signalbox later, through the opt-in session mod.
    public static let planned: CommandRunStatus = "planned"
    /// Interactive or only useful inside the session: copy it and run it there.
    public static let no: CommandRunStatus = "no"
    /// Deliberately never offered (destructive or sensitive).
    public static let never: CommandRunStatus = "never"
}

/// Whether a command works on one surface: the catalog writes true, false, "partial" or "unknown".
public enum SurfaceSupport: Hashable, Sendable, Codable {
    case yes, no, partial, unknown

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) {
            self = b ? .yes : .no
        } else if let s = try? c.decode(String.self) {
            switch s.lowercased() {
            case "partial": self = .partial
            case "true", "yes": self = .yes
            case "false", "no": self = .no
            default: self = .unknown
            }
        } else {
            self = .unknown
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .yes: try c.encode(true)
        case .no: try c.encode(false)
        case .partial: try c.encode("partial")
        case .unknown: try c.encode("unknown")
        }
    }

    /// Works there, fully or in part.
    public var isAvailable: Bool { self == .yes || self == .partial }
}

/// Where a command works. Known surfaces have accessors; any other surface a newer catalog adds is kept.
public struct CommandSurfaces: Hashable, Sendable, Codable {
    public var values: [String: SurfaceSupport]

    public static let knownKeys = ["terminal", "desktop", "headless", "remoteControl"]

    public init(values: [String: SurfaceSupport] = [:]) { self.values = values }

    public init(terminal: SurfaceSupport = .unknown, desktop: SurfaceSupport = .unknown, headless: SurfaceSupport = .unknown, remoteControl: SurfaceSupport = .unknown) {
        values = ["terminal": terminal, "desktop": desktop, "headless": headless, "remoteControl": remoteControl]
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        var out: [String: SurfaceSupport] = [:]
        for key in c.allKeys {
            out[key.stringValue] = (try? c.decode(SurfaceSupport.self, forKey: key)) ?? .unknown
        }
        values = out
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        for (k, v) in values { try c.encode(v, forKey: AnyKey(k)) }
    }

    public subscript(_ key: String) -> SurfaceSupport { values[key] ?? .unknown }

    public var terminal: SurfaceSupport { self["terminal"] }
    public var desktop: SurfaceSupport { self["desktop"] }
    public var headless: SurfaceSupport { self["headless"] }
    public var remoteControl: SurfaceSupport { self["remoteControl"] }

    /// Known surfaces in a fixed order, then any others by name.
    public var orderedKeys: [String] {
        Self.knownKeys + values.keys.filter { !Self.knownKeys.contains($0) }.sorted()
    }

    /// "terminal" → "Terminal", "remoteControl" → "Remote Control", unknown keys made readable.
    public static func title(_ key: String) -> String {
        switch key {
        case "terminal": "Terminal"
        case "desktop": "Desktop app"
        case "headless": "Headless (-p)"
        case "remoteControl": "Remote Control"
        default:
            // camelCase → words
            key.reduce(into: "") { s, ch in
                if ch.isUppercase, !s.isEmpty { s.append(" ") }
                s.append(s.isEmpty ? Character(ch.uppercased()) : Character(ch.lowercased()))
            }
        }
    }

    /// The short label used on list rows.
    public static func shortTitle(_ key: String) -> String {
        switch key {
        case "terminal": "Terminal"
        case "desktop": "Desktop"
        case "headless": "Headless"
        case "remoteControl": "Remote"
        default: title(key)
        }
    }
}

/// What Signalbox does with a command, and why.
public struct CommandAvailability: Hashable, Sendable, Codable {
    public var status: CommandRunStatus
    /// For status "view": which screen shows it ("sessions", "usage", "limits", "health"; kept as sent).
    public var view: String?
    public var note: String?

    public init(status: CommandRunStatus, view: String? = nil, note: String? = nil) {
        self.status = status
        self.view = view
        self.note = note
    }

    enum CodingKeys: String, CodingKey { case status, view, note }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decodeIfPresent(CommandRunStatus.self, forKey: .status)) ?? "unknown"
        view = try? c.decodeIfPresent(String.self, forKey: .view)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
    }
}

/// How a catalog entry was checked: read from the binary, from --help, from the docs, or seen running.
public struct CommandVerification: Hashable, Sendable, Codable {
    public var method: String?
    public var version: String?

    public init(method: String? = nil, version: String? = nil) {
        self.method = method
        self.version = version
    }

    enum CodingKeys: String, CodingKey { case method, version }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        method = try? c.decodeIfPresent(String.self, forKey: .method)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
    }

    /// "Read from the binary", "From --help", … for the method; unknown methods as given.
    public var methodLabel: String? {
        guard let method, !method.isEmpty else { return nil }
        switch method {
        case "binary": return "Read from the installed program"
        case "help": return "From its --help output"
        case "docs": return "From the official docs"
        case "observed": return "Seen running"
        default: return method
        }
    }
}

/// One built-in slash command (or, in `cliCommands`, one shell command such as "claude agents --json").
public struct CatalogCommand: Hashable, Sendable, Codable {
    public var name: String
    public var aliases: [String]?
    public var args: String?
    public var summary: String
    public var details: String?
    public var category: CommandCategory
    public var surfaces: CommandSurfaces
    public var sideEffects: String?
    public var signalbox: CommandAvailability
    public var verified: CommandVerification?
    public var sourceUrl: String?

    public init(name: String, aliases: [String]? = nil, args: String? = nil, summary: String, details: String? = nil,
                category: CommandCategory = .other, surfaces: CommandSurfaces = .init(), sideEffects: String? = nil,
                signalbox: CommandAvailability = .init(status: .no), verified: CommandVerification? = nil, sourceUrl: String? = nil) {
        self.name = name
        self.aliases = aliases
        self.args = args
        self.summary = summary
        self.details = details
        self.category = category
        self.surfaces = surfaces
        self.sideEffects = sideEffects
        self.signalbox = signalbox
        self.verified = verified
        self.sourceUrl = sourceUrl
    }

    enum CodingKeys: String, CodingKey { case name, aliases, args, summary, details, category, surfaces, sideEffects, signalbox, verified, sourceUrl }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "empty command name")
        }
        aliases = c.lossyArrayIfPresent(String.self, forKey: .aliases)
        args = try? c.decodeIfPresent(String.self, forKey: .args)
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        details = try? c.decodeIfPresent(String.self, forKey: .details)
        category = (try? c.decodeIfPresent(CommandCategory.self, forKey: .category)) ?? .other
        surfaces = (try? c.decodeIfPresent(CommandSurfaces.self, forKey: .surfaces)) ?? .init()
        sideEffects = try? c.decodeIfPresent(String.self, forKey: .sideEffects)
        signalbox = (try? c.decodeIfPresent(CommandAvailability.self, forKey: .signalbox)) ?? .init(status: "unknown")
        verified = try? c.decodeIfPresent(CommandVerification.self, forKey: .verified)
        sourceUrl = try? c.decodeIfPresent(String.self, forKey: .sourceUrl)
    }

    /// Aliases that differ from the name, in catalog order.
    public var allAliases: [String] { (aliases ?? []).filter { !$0.isEmpty && $0 != name } }

    /// True when `name` (or one of its aliases) is `candidate`.
    public func answers(to candidate: String) -> Bool {
        name == candidate || allAliases.contains(candidate)
    }
}

/// One agent's catalog file (catalog/commands/<agent>.json).
public struct CommandCatalog: Hashable, Sendable, Codable, Identifiable {
    public var agent: AgentID
    public var displayName: String?
    /// The agent version the catalog was checked against.
    public var verifiedVersion: String?
    /// The date the catalog was written ("2026-10-10").
    public var asOf: String?
    public var sources: [String]?
    public var commands: [CatalogCommand]
    public var cliCommands: [CatalogCommand]

    public var id: AgentID { agent }

    public init(agent: AgentID, displayName: String? = nil, verifiedVersion: String? = nil, asOf: String? = nil, sources: [String]? = nil,
                commands: [CatalogCommand] = [], cliCommands: [CatalogCommand] = []) {
        self.agent = agent
        self.displayName = displayName
        self.verifiedVersion = verifiedVersion
        self.asOf = asOf
        self.sources = sources
        self.commands = commands
        self.cliCommands = cliCommands
    }

    enum CodingKeys: String, CodingKey { case agent, displayName, verifiedVersion, asOf, sources, commands, cliCommands }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        displayName = try? c.decodeIfPresent(String.self, forKey: .displayName)
        verifiedVersion = try? c.decodeIfPresent(String.self, forKey: .verifiedVersion)
        asOf = try? c.decodeIfPresent(String.self, forKey: .asOf)
        sources = c.lossyArrayIfPresent(String.self, forKey: .sources)
        commands = c.lossyArray(CatalogCommand.self, forKey: .commands)
        cliCommands = c.lossyArray(CatalogCommand.self, forKey: .cliCommands)
    }

    /// The slash command `name` answers to, by its own name first and then by alias (so Gemini's "/compact"
    /// alias finds "/compress" only when no command is called "/compact" outright).
    public func command(_ candidates: [String]) -> CatalogCommand? {
        for n in candidates { if let c = commands.first(where: { $0.name == n }) { return c } }
        for n in candidates { if let c = commands.first(where: { $0.allAliases.contains(n) }) { return c } }
        return nil
    }
}

/// What kind of custom command the CLI found.
public struct CustomCommandKind: OpenStringValue {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let command: CustomCommandKind = "command"
    public static let skill: CustomCommandKind = "skill"
    public static let prompt: CustomCommandKind = "prompt"
    public static let pluginCommand: CustomCommandKind = "plugin-command"
    public static let pluginSkill: CustomCommandKind = "plugin-skill"

    public var title: String {
        switch self {
        case .command: "Command"
        case .skill: "Skill"
        case .prompt: "Prompt"
        case .pluginCommand: "Plugin command"
        case .pluginSkill: "Plugin skill"
        default: readable
        }
    }
}

/// Where a custom command comes from.
public struct CustomCommandScope: OpenStringValue {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let user: CustomCommandScope = "user"
    public static let project: CustomCommandScope = "project"
    public static let plugin: CustomCommandScope = "plugin"

    public var title: String {
        switch self {
        case .user: "User"
        case .project: "Project"
        case .plugin: "Plugin"
        default: readable
        }
    }
}

/// A command, skill or prompt the user (or a plugin) added. Names and descriptions only.
public struct CustomCommand: Hashable, Sendable, Codable, Identifiable {
    public var agent: AgentID
    public var name: String
    public var description: String?
    public var kind: CustomCommandKind
    public var scope: CustomCommandScope
    /// The file it came from ("~/.claude/commands/x.md") or the plugin's name.
    public var source: String?
    /// The project directory, for project scope.
    public var project: String?

    public var id: String { "custom|\(agent.rawValue)|\(scope.rawValue)|\(project ?? "")|\(source ?? "")|\(name)" }

    public init(agent: AgentID, name: String, description: String? = nil, kind: CustomCommandKind = .command, scope: CustomCommandScope = .user, source: String? = nil, project: String? = nil) {
        self.agent = agent
        self.name = name
        self.description = description
        self.kind = kind
        self.scope = scope
        self.source = source
        self.project = project
    }

    enum CodingKeys: String, CodingKey { case agent, name, description, kind, scope, source, project }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        name = try c.decode(String.self, forKey: .name).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "empty command name")
        }
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        kind = (try? c.decodeIfPresent(CustomCommandKind.self, forKey: .kind)) ?? .command
        scope = (try? c.decodeIfPresent(CustomCommandScope.self, forKey: .scope)) ?? .user
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        project = try? c.decodeIfPresent(String.self, forKey: .project)
    }

    /// A Codex custom prompt (~/.codex/prompts). Codex deprecated these in favour of skills, and recent Codex CLI
    /// releases don't load them, so the guide marks them instead of presenting them as working commands.
    public var isLegacyPrompt: Bool { agent == .codex && kind == .prompt }

    /// The kind as shown on rows: "Skill", "Plugin command", "Legacy prompt", …
    public var kindTitle: String { isLegacyPrompt ? "Legacy prompt" : kind.title }

    /// The name split for display: a plugin entry's "/<plugin>:" or "$<plugin>:" lead (which the scope tag already
    /// names) and the part that tells it apart from the plugin's other entries. Rows dim the lead and truncate in
    /// the middle, so long names that share a lead stay distinguishable. Copy always uses the whole name.
    public var nameParts: (lead: String, rest: String) {
        guard scope == .plugin, let plugin = source, !plugin.isEmpty, let sigil = name.first, sigil == "/" || sigil == "$" else {
            return ("", name)
        }
        let lead = "\(sigil)\(plugin):"
        guard name.hasPrefix(lead), name.count > lead.count else { return ("", name) }
        return (lead, String(name.dropFirst(lead.count)))
    }

    /// The longest description shown; the CLI already cuts at 200 characters on one line.
    public static let maxDescription = 200

    /// The description on one line, at most `maxDescription` characters (a second guard: never more than a label).
    public var shortDescription: String? {
        guard let d = description else { return nil }
        let line = d.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { return nil }
        return line.count > Self.maxDescription ? String(line.prefix(Self.maxDescription - 1)) + "…" : line
    }
}

/// `signalbox commands --json`, and the data of the watch stream's "commands" line.
public struct CommandsData: Hashable, Sendable, Codable {
    public var v: Int?
    public var generatedAt: Date?
    /// Installed agent versions by agent id; an agent that isn't installed is absent.
    public var installed: [String: String]
    public var catalogs: [CommandCatalog]
    public var custom: [CustomCommand]

    public init(v: Int? = 1, generatedAt: Date? = nil, installed: [String: String] = [:], catalogs: [CommandCatalog] = [], custom: [CustomCommand] = []) {
        self.v = v
        self.generatedAt = generatedAt
        self.installed = installed
        self.catalogs = catalogs
        self.custom = custom
    }

    enum CodingKeys: String, CodingKey { case v, generatedAt, installed, catalogs, custom }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try? c.decodeIfPresent(Int.self, forKey: .v)
        generatedAt = try? c.decodeIfPresent(Date.self, forKey: .generatedAt)
        var installed: [String: String] = [:]
        if let map = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: .installed) {
            for key in map.allKeys {
                if let version = try? map.decode(String.self, forKey: key), !version.isEmpty { installed[key.stringValue] = version }
            }
        }
        self.installed = installed
        catalogs = c.lossyArray(CommandCatalog.self, forKey: .catalogs)
        custom = c.lossyArray(CustomCommand.self, forKey: .custom)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(v, forKey: .v)
        try c.encodeIfPresent(generatedAt, forKey: .generatedAt)
        try c.encode(installed, forKey: .installed)
        try c.encode(catalogs, forKey: .catalogs)
        try c.encode(custom, forKey: .custom)
    }

    public static func decode(_ data: Data) throws -> CommandsData {
        try SignalboxJSON.decoder().decode(CommandsData.self, from: data)
    }

    public func catalog(for agent: AgentID) -> CommandCatalog? {
        catalogs.first { $0.agent == agent }
    }

    public func installedVersion(_ agent: AgentID) -> String? {
        installed[agent.rawValue]
    }

    /// Agents with a catalog or an installed version, in display order.
    public var agents: [AgentID] {
        Set(catalogs.map(\.agent) + installed.keys.map { AgentID(rawValue: $0) }).sorted()
    }
}

/// A coding key for dictionaries whose keys aren't known in advance.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}
