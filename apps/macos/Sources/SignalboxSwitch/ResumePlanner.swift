import Foundation
import SignalboxKit

/// Why a session can't be resumed under an account (docs/SWITCH.md §4).
public enum ResumeBlock: Equatable, Sendable {
    case off
    case notClaudeCode
    case noTranscript
    case unsafeID
    case live
    case notShared
    case noClaude

    public var text: String {
        switch self {
        case .off: "Turn account switching on in Settings ▸ Advanced"
        case .notClaudeCode: "Only Claude Code sessions"
        case .noTranscript: "Its transcript isn't on this Mac"
        case .unsafeID: "Its id isn't safe to put in a command"
        case .live: "It is still running: quit it first"
        case .notShared: "This folder can't see its transcript: set up shared sessions first"
        case .noClaude: "No claude found on your PATH"
        }
    }
}

/// One "Resume with" target: a folder, the account its login uses now, and why it can't be used, if it can't.
public struct ResumeOption: Identifiable, Hashable, Sendable {
    public var folder: SwitchFolder
    public var accountID: String?
    public var block: ResumeBlock?
    public var id: String { folder.id }
}

public struct ResumeChoices: Sendable {
    /// Blocks every folder (the session itself can't be resumed now).
    public var block: ResumeBlock?
    public var options: [ResumeOption]
    /// A desktop session: the Claude app may write to it again at any time, so only a copy (--fork-session).
    public var copyOnly: Bool
}

public enum ResumePlanner {
    /// Running in the fleet now, or live when History was built. A fleet status Signalbox can't read counts as running.
    public static func isLive(_ entry: SessionHistoryEntry, fleet: FleetSnapshot?) -> Bool {
        if let s = fleet?.sessions.first(where: { $0.agent == entry.agent && $0.sessionId == entry.sessionId }) {
            return s.status != .ended
        }
        return entry.live
    }

    public static func choices(entry: SessionHistoryEntry, fleet: FleetSnapshot?, switchOn: Bool, folders: [SwitchFolder],
                               accounts: [AccountInfo], visible: (SwitchFolder) -> Bool) -> ResumeChoices {
        let block: ResumeBlock? =
            if !switchOn { .off }
            else if entry.agent != .claudeCode { .notClaudeCode }
            else if !entry.hasTranscript || entry.transcriptPath == nil { .noTranscript }
            else if !ResumeRequest.isSafeID(entry.sessionId) { .unsafeID }
            else if isLive(entry, fleet: fleet) { .live }
            else { nil }
        let options = folders.map { f in
            ResumeOption(folder: f, accountID: f.account(in: accounts)?.id, block: block == nil && !visible(f) ? .notShared : nil)
        }
        return ResumeChoices(block: block, options: options, copyOnly: entry.entrypoint == "claude-desktop")
    }
}
