import Foundation

// Swift mirror of packages/core/src/types.ts. Missing data stays `nil` ("unknown"), never 0.
// Fields that are optional in the TS contract are optional here; unknown keys are ignored and
// unknown enum values decode to a fallback case, so a newer CLI never breaks an older app.

// MARK: - Identifiers and enums

/// Which coding agent a record came from. Open-ended: unknown ids are kept verbatim.
public struct AgentID: RawRepresentable, Codable, Hashable, Sendable, Comparable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static let claudeCode: AgentID = "claude-code"
    public static let codex: AgentID = "codex"
    public static let geminiCLI: AgentID = "gemini-cli"

    /// Known agents first in a fixed order, then the rest alphabetically.
    public static func < (a: AgentID, b: AgentID) -> Bool {
        let known: [AgentID] = [.claudeCode, .codex, .geminiCLI]
        let ia = known.firstIndex(of: a) ?? 99
        let ib = known.firstIndex(of: b) ?? 99
        return ia != ib ? ia < ib : a.rawValue < b.rawValue
    }
}

/// How much we trust a data source to survive upstream releases.
public enum Stability: String, LenientStringEnum {
    case documented, preview, `internal`, unknown
    public static let fallback: Stability = .unknown
}

public enum SessionStatus: String, LenientStringEnum {
    case busy, waiting, idle, ended, unknown
    public static let fallback: SessionStatus = .unknown

    /// Sort order in lists: what needs attention first.
    public var rank: Int {
        switch self {
        case .waiting: 0
        case .busy: 1
        case .idle: 2
        case .unknown: 3
        case .ended: 4
        }
    }
}

public enum ContextQuality: String, LenientStringEnum {
    case official, estimated, unknown
    public static let fallback: ContextQuality = .unknown
}

public enum CompactionTrigger: String, LenientStringEnum {
    case manual, auto, unknown
    public static let fallback: CompactionTrigger = .unknown
}

// MARK: - Tokens and cost

/// Token counts for one response or a sum. Doubles so that any JSON number decodes.
public struct TokenCounts: Codable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite5m: Double
    public var cacheWrite1h: Double
    public var reasoning: Double?

    public init(input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite5m: Double = 0, cacheWrite1h: Double = 0, reasoning: Double? = nil) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite5m = cacheWrite5m
        self.cacheWrite1h = cacheWrite1h
        self.reasoning = reasoning
    }

    /// input + output + cache reads + cache writes.
    public var processed: Double { input + output + cacheRead + cacheWrite5m + cacheWrite1h }
    /// Everything except cache reads.
    public var fresh: Double { input + cacheWrite5m + cacheWrite1h + output }
}

public struct CostBreakdown: Codable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite5m: Double
    public var cacheWrite1h: Double
    public var webSearch: Double
    public var total: Double

    public init(input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite5m: Double = 0, cacheWrite1h: Double = 0, webSearch: Double = 0, total: Double = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite5m = cacheWrite5m
        self.cacheWrite1h = cacheWrite1h
        self.webSearch = webSearch
        self.total = total
    }
}

// MARK: - Sessions, limits, context

public struct ContextSnapshot: Codable, Hashable, Sendable {
    public var agent: AgentID
    public var sessionId: String
    public var tokens: Double
    public var window: Double?
    public var percent: Double?
    /// Where auto-compaction kicks in, as a percent of the window.
    public var autoCompactAtPercent: Double?
    public var observedAt: Date
    public var quality: ContextQuality
    public var source: String?
    /// Where `window` came from, when the CLI says (e.g. the agent reported it, or a known size for the model).
    /// Newer CLIs only; free-form, shown as given.
    public var windowSource: String?

    public init(agent: AgentID, sessionId: String, tokens: Double, window: Double? = nil, percent: Double? = nil, autoCompactAtPercent: Double? = nil, observedAt: Date, quality: ContextQuality, source: String? = nil, windowSource: String? = nil) {
        self.agent = agent
        self.sessionId = sessionId
        self.tokens = tokens
        self.window = window
        self.percent = percent
        self.autoCompactAtPercent = autoCompactAtPercent
        self.observedAt = observedAt
        self.quality = quality
        self.source = source
        self.windowSource = windowSource
    }

    enum CodingKeys: String, CodingKey { case agent, sessionId, tokens, window, percent, autoCompactAtPercent, observedAt, quality, source, windowSource }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        tokens = try c.decode(Double.self, forKey: .tokens)
        // Optional extras never cost the session its context: a wrong type reads as unknown.
        window = try? c.decodeIfPresent(Double.self, forKey: .window)
        percent = try? c.decodeIfPresent(Double.self, forKey: .percent)
        autoCompactAtPercent = try? c.decodeIfPresent(Double.self, forKey: .autoCompactAtPercent)
        observedAt = try c.decode(Date.self, forKey: .observedAt)
        quality = try c.decodeIfPresent(ContextQuality.self, forKey: .quality) ?? .unknown
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        windowSource = try? c.decodeIfPresent(String.self, forKey: .windowSource)
    }

    /// The agent's own percent, else tokens over a known window, else unknown.
    public var effectivePercent: Double? {
        if let percent { return percent }
        if let window, window > 0 { return tokens / window * 100 }
        return nil
    }
}

/// A live or recently seen session (`SessionInfo` plus the fleet extras).
public struct FleetSession: Codable, Hashable, Sendable, Identifiable {
    public var agent: AgentID
    public var sessionId: String
    public var pid: Int?
    public var cwd: String?
    public var name: String?
    public var status: SessionStatus
    public var statusSince: Date?
    /// What a waiting session waits for, as the agent labels it ("permission prompt", "input needed", …).
    /// A short label, never message content; set only while waiting, by newer CLIs.
    public var waitingFor: String?
    public var entrypoint: String?
    public var kind: String?
    public var version: String?
    public var model: String?
    public var effort: String?
    public var startedAt: Date?
    public var lastActivity: Date?
    public var source: String?
    public var costUsd: Double?
    public var context: ContextSnapshot?
    /// Tokens on models with no price row, left out of `costUsd`.
    public var unpricedTokens: Double?

    public var id: String { "\(agent.rawValue)/\(sessionId)" }

    public init(agent: AgentID, sessionId: String, pid: Int? = nil, cwd: String? = nil, name: String? = nil, status: SessionStatus, statusSince: Date? = nil, waitingFor: String? = nil, entrypoint: String? = nil, kind: String? = nil, version: String? = nil, model: String? = nil, effort: String? = nil, startedAt: Date? = nil, lastActivity: Date? = nil, source: String? = nil, costUsd: Double? = nil, context: ContextSnapshot? = nil, unpricedTokens: Double? = nil) {
        self.agent = agent
        self.sessionId = sessionId
        self.pid = pid
        self.cwd = cwd
        self.name = name
        self.status = status
        self.statusSince = statusSince
        self.waitingFor = waitingFor
        self.entrypoint = entrypoint
        self.kind = kind
        self.version = version
        self.model = model
        self.effort = effort
        self.startedAt = startedAt
        self.lastActivity = lastActivity
        self.source = source
        self.costUsd = costUsd
        self.context = context
        self.unpricedTokens = unpricedTokens
    }

    /// The longest `waitingFor` label shown; the CLI drops anything longer (48 characters, adapter-claude `label`).
    public static let maxWaitingLabel = 48

    /// `waitingFor` while the session is waiting, on one line and at most `maxWaitingLabel` characters (the CLI
    /// already drops anything longer; this is a second guard so a label can never carry content).
    public var waitingLabel: String? {
        guard status == .waiting, let w = waitingFor?.trimmingCharacters(in: .whitespacesAndNewlines), !w.isEmpty,
              w.count <= Self.maxWaitingLabel, !w.contains(where: \.isNewline)
        else { return nil }
        return w
    }

    /// Name, else the cwd's last component, else the first 8 characters of the id.
    public var title: String {
        if let name, !name.isEmpty { return name }
        if let base = Fmt.basename(cwd) { return base }
        return Fmt.shortID(sessionId)
    }
}

/// A plan/rate-limit reading. The freshest reading per (agent, kind) wins.
public struct LimitSnapshot: Codable, Hashable, Sendable, Identifiable {
    public var agent: AgentID
    /// e.g. "five_hour", "seven_day", "codex.primary". Unknown kinds are kept verbatim.
    public var kind: String
    public var label: String?
    public var usedPercent: Double
    public var resetsAt: Date?
    public var windowMinutes: Double?
    public var observedAt: Date
    public var plan: String?
    public var sessionId: String?
    public var source: String?

    public var id: String { "\(agent.rawValue)/\(kind)" }

    public init(agent: AgentID, kind: String, label: String? = nil, usedPercent: Double, resetsAt: Date? = nil, windowMinutes: Double? = nil, observedAt: Date, plan: String? = nil, sessionId: String? = nil, source: String? = nil) {
        self.agent = agent
        self.kind = kind
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.windowMinutes = windowMinutes
        self.observedAt = observedAt
        self.plan = plan
        self.sessionId = sessionId
        self.source = source
    }
}

public struct CompactionEvent: Codable, Hashable, Sendable {
    public var agent: AgentID
    public var sessionId: String
    public var ts: Date
    public var trigger: CompactionTrigger
    public var preTokens: Double?
}

public struct AdapterHealth: Codable, Hashable, Sendable, Identifiable {
    /// e.g. "claude-code:transcripts".
    public var name: String
    public var stability: Stability
    public var ok: Bool
    public var detail: String

    public var id: String { name }

    public init(name: String, stability: Stability, ok: Bool, detail: String) {
        self.name = name
        self.stability = stability
        self.ok = ok
        self.detail = detail
    }

    /// The agent part of "claude-code:transcripts".
    public var agent: AgentID? {
        guard let i = name.firstIndex(of: ":") else { return nil }
        return AgentID(rawValue: String(name[..<i]))
    }

    /// The source part of "claude-code:transcripts".
    public var sourceName: String {
        guard let i = name.firstIndex(of: ":") else { return name }
        return String(name[name.index(after: i)...])
    }
}

public struct FleetSnapshot: Codable, Hashable, Sendable {
    public var generatedAt: Date
    public var sessions: [FleetSession]
    public var limits: [LimitSnapshot]
    public var compactions: [CompactionEvent]
    public var health: [AdapterHealth]

    public init(generatedAt: Date, sessions: [FleetSession] = [], limits: [LimitSnapshot] = [], compactions: [CompactionEvent] = [], health: [AdapterHealth] = []) {
        self.generatedAt = generatedAt
        self.sessions = sessions
        self.limits = limits
        self.compactions = compactions
        self.health = health
    }

    enum CodingKeys: String, CodingKey { case generatedAt, sessions, limits, compactions, health }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        sessions = c.lossyArray(FleetSession.self, forKey: .sessions)
        limits = c.lossyArray(LimitSnapshot.self, forKey: .limits)
        compactions = c.lossyArray(CompactionEvent.self, forKey: .compactions)
        health = c.lossyArray(AdapterHealth.self, forKey: .health)
    }
}

// MARK: - Report

/// A row of a report grouping (byAgent, byModel, byProject, byKind, byDay).
public struct GroupTotals: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var tokens: TokenCounts
    public var cost: CostBreakdown
    public var responses: Int
    public var placeholderResponses: Int
    public var unpricedTokens: Double
    public var unpricedModels: [String]
    /// Present on byDay rows only.
    public var byModel: [GroupTotals]?
    public var byKind: [GroupTotals]?

    public var id: String { key }

    public init(key: String, tokens: TokenCounts = .init(), cost: CostBreakdown = .init(), responses: Int = 0, placeholderResponses: Int = 0, unpricedTokens: Double = 0, unpricedModels: [String] = [], byModel: [GroupTotals]? = nil, byKind: [GroupTotals]? = nil) {
        self.key = key
        self.tokens = tokens
        self.cost = cost
        self.responses = responses
        self.placeholderResponses = placeholderResponses
        self.unpricedTokens = unpricedTokens
        self.unpricedModels = unpricedModels
        self.byModel = byModel
        self.byKind = byKind
    }

    enum CodingKeys: String, CodingKey { case key, tokens, cost, responses, placeholderResponses, unpricedTokens, unpricedModels, byModel, byKind }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        tokens = try c.decode(TokenCounts.self, forKey: .tokens)
        cost = try c.decode(CostBreakdown.self, forKey: .cost)
        responses = try c.decodeIfPresent(Int.self, forKey: .responses) ?? 0
        placeholderResponses = try c.decodeIfPresent(Int.self, forKey: .placeholderResponses) ?? 0
        unpricedTokens = try c.decodeIfPresent(Double.self, forKey: .unpricedTokens) ?? 0
        unpricedModels = c.lossyArray(String.self, forKey: .unpricedModels)
        byModel = c.lossyArrayIfPresent(GroupTotals.self, forKey: .byModel)
        byKind = c.lossyArrayIfPresent(GroupTotals.self, forKey: .byKind)
    }

    /// True when some of this row's tokens have no price row (so its $ is a lower bound).
    public var hasUnpriced: Bool { unpricedTokens > 0 || !unpricedModels.isEmpty }
}

public struct ReportTotals: Codable, Hashable, Sendable {
    public var tokens: TokenCounts
    public var cost: CostBreakdown
    public var responses: Int
    public var placeholderResponses: Int
    public var unpricedTokens: Double
    public var unpricedModels: [String]
    public var processedTokens: Double
    public var freshTokens: Double
    /// cacheRead / all prompt tokens; 0 when there are none (check processedTokens).
    public var cacheHitRatio: Double
    /// Gross, at list price.
    public var savedByCachingUsd: Double

    public init(tokens: TokenCounts = .init(), cost: CostBreakdown = .init(), responses: Int = 0, placeholderResponses: Int = 0, unpricedTokens: Double = 0, unpricedModels: [String] = [], processedTokens: Double = 0, freshTokens: Double = 0, cacheHitRatio: Double = 0, savedByCachingUsd: Double = 0) {
        self.tokens = tokens
        self.cost = cost
        self.responses = responses
        self.placeholderResponses = placeholderResponses
        self.unpricedTokens = unpricedTokens
        self.unpricedModels = unpricedModels
        self.processedTokens = processedTokens
        self.freshTokens = freshTokens
        self.cacheHitRatio = cacheHitRatio
        self.savedByCachingUsd = savedByCachingUsd
    }

    enum CodingKeys: String, CodingKey { case tokens, cost, responses, placeholderResponses, unpricedTokens, unpricedModels, processedTokens, freshTokens, cacheHitRatio, savedByCachingUsd }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = try c.decode(TokenCounts.self, forKey: .tokens)
        cost = try c.decode(CostBreakdown.self, forKey: .cost)
        responses = try c.decodeIfPresent(Int.self, forKey: .responses) ?? 0
        placeholderResponses = try c.decodeIfPresent(Int.self, forKey: .placeholderResponses) ?? 0
        unpricedTokens = try c.decodeIfPresent(Double.self, forKey: .unpricedTokens) ?? 0
        unpricedModels = c.lossyArray(String.self, forKey: .unpricedModels)
        processedTokens = try c.decodeIfPresent(Double.self, forKey: .processedTokens) ?? tokens.processed
        freshTokens = try c.decodeIfPresent(Double.self, forKey: .freshTokens) ?? tokens.fresh
        cacheHitRatio = try c.decodeIfPresent(Double.self, forKey: .cacheHitRatio) ?? 0
        savedByCachingUsd = try c.decodeIfPresent(Double.self, forKey: .savedByCachingUsd) ?? 0
    }
}

public struct ReconciliationRow: Codable, Hashable, Sendable {
    public var agent: AgentID
    public var sessionId: String
    public var project: String?
    public var transcriptUsd: Double
    public var ledgerUsd: Double?
    public var k: Double?
    public var placeholderShare: Double?
}

public struct ReportEstimate: Codable, Hashable, Sendable {
    /// Sum of transcript-priced records: a lower bound.
    public var recordedUsd: Double
    public var estimatedLowUsd: Double
    public var estimatedHighUsd: Double
    public var method: String?

    public init(recordedUsd: Double, estimatedLowUsd: Double, estimatedHighUsd: Double, method: String? = nil) {
        self.recordedUsd = recordedUsd
        self.estimatedLowUsd = estimatedLowUsd
        self.estimatedHighUsd = estimatedHighUsd
        self.method = method
    }
}

public struct PriceTableInfo: Codable, Hashable, Sendable, Identifiable {
    public var provider: String
    /// A date string as written in the price file (e.g. "2026-10-09").
    public var asOf: String
    public var sourceUrl: String?

    public var id: String { provider }

    public init(provider: String, asOf: String, sourceUrl: String? = nil) {
        self.provider = provider
        self.asOf = asOf
        self.sourceUrl = sourceUrl
    }
}

public struct DateRange: Codable, Hashable, Sendable {
    public var since: Date
    public var until: Date

    public init(since: Date, until: Date) {
        self.since = since
        self.until = until
    }
}

public struct Report: Codable, Hashable, Sendable {
    public var generatedAt: Date
    public var range: DateRange?
    public var totals: ReportTotals
    public var byAgent: [GroupTotals]
    public var byModel: [GroupTotals]
    public var byProject: [GroupTotals]
    public var byKind: [GroupTotals]
    public var byDay: [GroupTotals]
    public var reconciliation: [ReconciliationRow]
    public var estimate: ReportEstimate?
    public var priceTables: [PriceTableInfo]
    public var notes: [String]

    public init(generatedAt: Date, range: DateRange? = nil, totals: ReportTotals = .init(), byAgent: [GroupTotals] = [], byModel: [GroupTotals] = [], byProject: [GroupTotals] = [], byKind: [GroupTotals] = [], byDay: [GroupTotals] = [], reconciliation: [ReconciliationRow] = [], estimate: ReportEstimate? = nil, priceTables: [PriceTableInfo] = [], notes: [String] = []) {
        self.generatedAt = generatedAt
        self.range = range
        self.totals = totals
        self.byAgent = byAgent
        self.byModel = byModel
        self.byProject = byProject
        self.byKind = byKind
        self.byDay = byDay
        self.reconciliation = reconciliation
        self.estimate = estimate
        self.priceTables = priceTables
        self.notes = notes
    }

    enum CodingKeys: String, CodingKey { case generatedAt, range, totals, byAgent, byModel, byProject, byKind, byDay, reconciliation, estimate, priceTables, notes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        range = try? c.decodeIfPresent(DateRange.self, forKey: .range)
        totals = try c.decode(ReportTotals.self, forKey: .totals)
        byAgent = c.lossyArray(GroupTotals.self, forKey: .byAgent)
        byModel = c.lossyArray(GroupTotals.self, forKey: .byModel)
        byProject = c.lossyArray(GroupTotals.self, forKey: .byProject)
        byKind = c.lossyArray(GroupTotals.self, forKey: .byKind)
        byDay = c.lossyArray(GroupTotals.self, forKey: .byDay)
        reconciliation = c.lossyArray(ReconciliationRow.self, forKey: .reconciliation)
        estimate = try? c.decodeIfPresent(ReportEstimate.self, forKey: .estimate)
        priceTables = c.lossyArray(PriceTableInfo.self, forKey: .priceTables)
        notes = c.lossyArray(String.self, forKey: .notes)
    }
}

// MARK: - Snapshot (`signalbox snapshot --json`)

/// One self-contained reading: the `signalbox snapshot --json` shape and the app's fixture format.
public struct Snapshot: Codable, Hashable, Sendable {
    public var v: Int
    public var generatedAt: Date
    public var days: Int
    public var fleet: FleetSnapshot
    public var report: Report
    public var health: [AdapterHealth]
    /// The command guide, when the snapshot carries one (newer CLIs may add it; fixtures may not).
    public var commands: CommandsData?
    /// Session history, when the snapshot carries it (newer CLIs may add it; fixtures may not).
    public var history: HistorySnapshot?

    public init(v: Int = 1, generatedAt: Date, days: Int, fleet: FleetSnapshot, report: Report, health: [AdapterHealth], commands: CommandsData? = nil, history: HistorySnapshot? = nil) {
        self.v = v
        self.generatedAt = generatedAt
        self.days = days
        self.fleet = fleet
        self.report = report
        self.health = health
        self.commands = commands
        self.history = history
    }

    enum CodingKeys: String, CodingKey { case v, generatedAt, days, fleet, report, health, commands, history }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        days = try c.decodeIfPresent(Int.self, forKey: .days) ?? 7
        fleet = try c.decode(FleetSnapshot.self, forKey: .fleet)
        report = try c.decode(Report.self, forKey: .report)
        health = c.lossyArray(AdapterHealth.self, forKey: .health)
        commands = try? c.decodeIfPresent(CommandsData.self, forKey: .commands)
        history = try? c.decodeIfPresent(HistorySnapshot.self, forKey: .history)
    }

    public static func decode(_ data: Data) throws -> Snapshot {
        try SignalboxJSON.decoder().decode(Snapshot.self, from: data)
    }
}
