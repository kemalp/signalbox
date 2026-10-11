import Foundation

/// A command (or a plain hint) the session inspector suggests for a session's current state.
public struct SessionSuggestion: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        /// Waiting for an answer: nothing to copy, answer it in the session.
        case answer
        /// Context is filling up: summarize to free space.
        case compact
        /// Idle with a lot of context: start a fresh conversation instead.
        case clear
    }

    public let kind: Kind
    /// Why this is suggested, from the session's state: "Context 78% full · ≈780K of 1M".
    public let reason: String
    /// What the command does (the catalog's summary) or what to do.
    public let detail: String
    /// What Copy puts on the clipboard; nil for hints without a command.
    public let command: String?
    /// The catalog's note when Signalbox plans to run it itself (status "planned").
    public let plannedNote: String?

    public var id: String { kind.rawValue }

    public init(kind: Kind, reason: String, detail: String, command: String? = nil, plannedNote: String? = nil) {
        self.kind = kind
        self.reason = reason
        self.detail = detail
        self.command = command
        self.plannedNote = plannedNote
    }
}

/// Suggestions driven by a session's state. Commands come only from that agent's catalog, so an agent without
/// one (or whose catalog lacks the command) gets no command suggestion.
public enum SessionSuggestions {
    /// Context at or above this percent suggests compacting (the context bar turns amber here too).
    public static let highContextPercent: Double = 75
    /// Idle at least this long with at least `idleContextPercent` in use suggests compacting or starting fresh.
    public static let idleAfter: TimeInterval = 30 * 60
    public static let idleContextPercent: Double = 50

    /// Command names per suggestion kind, in preference order. A catalog's own name wins over an alias, so
    /// Gemini (where /compact is an alias of /compress) suggests /compress.
    static let compactNames = ["/compact", "/compress"]
    static let clearNames = ["/clear"]

    public static func suggest(for session: FleetSession, commands: CommandsData?, now: Date) -> [SessionSuggestion] {
        guard session.status != .ended else { return [] }
        var out: [SessionSuggestion] = []
        let catalog = commands?.catalog(for: session.agent)

        if session.status == .waiting {
            let label = session.waitingLabel
            let detail: String
            if let label, label.lowercased().contains("permission") {
                detail = "It's stopped at a permission prompt. Signalbox never answers those; switch to the session to allow or deny."
            } else if let label {
                detail = "It's waiting for: \(label). Signalbox can't answer for you; switch to the session."
            } else {
                detail = "It's waiting for you. Signalbox can't answer for you; switch to the session."
            }
            out.append(SessionSuggestion(kind: .answer, reason: "Answer it in the session", detail: detail))
        }

        guard let context = session.context, let pct = context.effectivePercent else { return out }
        let idleFor = idleDuration(session, now: now)
        let longIdle = session.status == .idle && (idleFor ?? 0) >= idleAfter
        let high = pct >= highContextPercent
        guard high || (longIdle && pct >= idleContextPercent) else { return out }

        let usage = contextUsage(context, percent: pct)
        if let compact = catalog?.command(compactNames) {
            var reason = high ? "Context \(Fmt.percent(pct)) full · \(usage)" : "Idle \(Fmt.duration(idleFor ?? 0)) with \(Fmt.percent(pct)) of context in use"
            if high, let ac = context.autoCompactAtPercent, ac > pct {
                reason += " · auto-compacts at \(Fmt.percent(ac))"
            }
            var detail = compact.summary.isEmpty ? "Summarizes the conversation so far to free context." : compact.summary
            // A command can't be typed while a turn runs or a prompt waits for an answer.
            if session.status == .busy { detail = Fmt.sentence(detail) + " Run it once the current turn finishes." }
            if session.status == .waiting { detail = Fmt.sentence(detail) + " Answer the prompt first, then run it." }
            out.append(SessionSuggestion(kind: .compact, reason: reason, detail: detail,
                                         command: CommandGuide.copyText(compact),
                                         plannedNote: compact.signalbox.status == .planned ? "Running this from Signalbox is planned." : nil))
        }
        if longIdle, let clear = catalog?.command(clearNames) {
            let reason = high ? "Or start fresh: idle \(Fmt.duration(idleFor ?? 0))" : "Or start fresh if you're switching tasks"
            out.append(SessionSuggestion(kind: .clear, reason: reason,
                                         detail: clear.summary.isEmpty ? "Starts a new conversation with an empty context." : clear.summary,
                                         command: CommandGuide.copyText(clear)))
        }
        return out
    }

    /// How long an idle session has been idle: since its status changed, else since its last activity.
    static func idleDuration(_ s: FleetSession, now: Date) -> TimeInterval? {
        guard s.status == .idle, let since = s.statusSince ?? s.lastActivity else { return nil }
        return max(0, now.timeIntervalSince(since))
    }

    /// "≈780K of 1M", or "≈780K tokens" without a known window.
    public static func contextUsage(_ c: ContextSnapshot, percent: Double) -> String {
        if let window = c.window, window > 0 { return "≈\(Fmt.tokens(c.tokens)) of \(Fmt.tokens(window))" }
        return "≈\(Fmt.tokens(c.tokens)) tokens"
    }
}
