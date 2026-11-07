import Foundation

// Accounts: which subscription a session runs under (core's AccountRef and AccountInfo). The CLI hashes the vendor's
// account and organization ids as soon as it reads them, so only an opaque id ("acct-" + 12 hex) arrives here, never
// an email or a vendor id. A session with no `account` is "Account unknown", never a default account.

/// A session's (or a limit reading's) account.
public struct AccountRef: Codable, Hashable, Sendable {
    public var id: String
    /// False when only the account half was found (no organization): its plan limits can't be told apart.
    public var orgKnown: Bool
    /// "claude-app-folder", "transcript", "config-login", "tap-config-dir"; anything newer passes through.
    public var source: String
    /// "recorded" (the session's own files name it) or "inferred" (a config dir's current login).
    public var quality: String

    public init(id: String, orgKnown: Bool = true, source: String, quality: String) {
        self.id = id
        self.orgKnown = orgKnown
        self.source = source
        self.quality = quality
    }

    enum CodingKeys: String, CodingKey { case id, orgKnown, source, quality }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        orgKnown = (try? c.decodeIfPresent(Bool.self, forKey: .orgKnown)).flatMap { $0 } ?? false
        source = (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0 } ?? "unknown"
        // An unknown quality reads as inferred: the weaker claim.
        quality = (try? c.decodeIfPresent(String.self, forKey: .quality)).flatMap { $0 } ?? "inferred"
    }

    /// Anything but "recorded": shown dashed, with "from this folder's current login".
    public var isInferred: Bool { quality != "recorded" }
    public var shortID: String { AccountNaming.shortID(id) }
}

/// One account the CLI has seen (the fleet's `accounts`).
public struct AccountInfo: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var orgKnown: Bool
    /// From Signalbox's accounts.json, as the CLI read it.
    public var label: String?
    public var sources: [String]
    /// Config dirs whose terminal login is this account now.
    public var loginConfigDirs: [String]?
    /// The Claude app's session list has a folder for it (desktop sessions).
    public var claudeAppFolder: Bool?
    public var liveSessions: Int?

    public init(id: String, orgKnown: Bool = true, label: String? = nil, sources: [String] = [], loginConfigDirs: [String]? = nil,
                claudeAppFolder: Bool? = nil, liveSessions: Int? = nil) {
        self.id = id
        self.orgKnown = orgKnown
        self.label = label
        self.sources = sources
        self.loginConfigDirs = loginConfigDirs
        self.claudeAppFolder = claudeAppFolder
        self.liveSessions = liveSessions
    }

    enum CodingKeys: String, CodingKey { case id, orgKnown, label, sources, loginConfigDirs, claudeAppFolder, liveSessions }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        orgKnown = (try? c.decodeIfPresent(Bool.self, forKey: .orgKnown)).flatMap { $0 } ?? false
        label = (try? c.decodeIfPresent(String.self, forKey: .label)).flatMap { $0 }
        sources = c.lossyArray(String.self, forKey: .sources)
        loginConfigDirs = (try? c.decodeIfPresent([String].self, forKey: .loginConfigDirs)).flatMap { $0 }
        claudeAppFolder = (try? c.decodeIfPresent(Bool.self, forKey: .claudeAppFolder)).flatMap { $0 }
        liveSessions = (try? c.decodeIfPresent(Int.self, forKey: .liveSessions)).flatMap { $0 }
    }
}

public enum AccountNaming {
    /// The 6 characters after "acct-" (core's accountShortId).
    public static func shortID(_ id: String) -> String {
        id.hasPrefix("acct-") ? String(id.dropFirst(5).prefix(6)) : String(id.prefix(6))
    }

    public static let maxLabelLength = 40

    /// A label fit to keep and show: one line, no control or bidi characters, at most 40 characters; nil when empty.
    public static func sanitize(_ raw: String) -> String? {
        let invisible = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "\u{061C}\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}\u{FEFF}"))
        let spaced = raw.unicodeScalars.map { CharacterSet.whitespacesAndNewlines.contains($0) ? " " : String($0) }.joined()
        let kept = String(String.UnicodeScalarView(spaced.unicodeScalars.filter { !invisible.contains($0) }))
        let collapsed = kept.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        return collapsed.count <= maxLabelLength ? collapsed : String(collapsed.prefix(maxLabelLength - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Your label (the app's own, then the one the CLI read), else the short id.
    public static func name(_ id: String, accounts: [AccountInfo], local: [String: String] = [:]) -> String {
        local[id] ?? accounts.first { $0.id == id }?.label ?? shortID(id)
    }

    /// A name short enough for the menu bar: the label if it fits in 8 characters, else its start and "…".
    public static func compact(_ name: String) -> String {
        name.count <= 8 ? name : String(name.prefix(6)).trimmingCharacters(in: .whitespaces) + "…"
    }

    public static func sourceText(_ source: String) -> String {
        switch source {
        case "claude-app-folder": "the Claude app's session folders"
        case "transcript": "the session's transcript"
        case "config-login": "this folder's current login"
        case "tap-config-dir": "the tap's folder and its current login"
        default: source
        }
    }

    /// The chip's tooltip: where the account came from, and the short id.
    public static func help(_ ref: AccountRef, name: String) -> String {
        let how = ref.isInferred ? "Inferred from \(sourceText(ref.source)); a later sign-in there would make it wrong" : "From \(sourceText(ref.source))"
        let org = ref.orgKnown ? "" : " Organization unknown, so its limits can't be told apart."
        return "\(name) (account \(ref.shortID)). \(how).\(org)"
    }
}

/// The plan windows of one (agent, account), for one card or one row of rings.
public struct LimitGroup: Identifiable, Hashable, Sendable {
    public var agent: AgentID
    /// nil: readings from sessions whose account is unknown.
    public var account: AccountRef?
    /// Shortest window first.
    public var limits: [LimitSnapshot]

    public var id: String { "\(agent.rawValue)/\(account?.id ?? "")" }

    public init(agent: AgentID, account: AccountRef?, limits: [LimitSnapshot]) {
        self.agent = agent
        self.account = account
        self.limits = limits
    }

    /// One group per (agent, account): agents in the usual order, then accounts by name, the unknown group last.
    public static func groups(_ limits: [LimitSnapshot], name: (String) -> String) -> [LimitGroup] {
        var order: [String] = []
        var byKey: [String: LimitGroup] = [:]
        for l in limits {
            let key = "\(l.agent.rawValue)/\(l.account?.id ?? "")"
            if byKey[key] == nil {
                order.append(key)
                byKey[key] = LimitGroup(agent: l.agent, account: l.account, limits: [])
            }
            byKey[key]!.limits.append(l)
        }
        let sorted = order.compactMap { byKey[$0] }.map { g -> LimitGroup in
            var g = g
            g.limits.sort {
                let wa = $0.windowMinutes ?? .greatestFiniteMagnitude
                let wb = $1.windowMinutes ?? .greatestFiniteMagnitude
                return wa != wb ? wa < wb : $0.kind < $1.kind
            }
            return g
        }
        return sorted.sorted { a, b in
            if a.agent != b.agent { return a.agent < b.agent }
            switch (a.account, b.account) {
            case (nil, nil): return false
            case (nil, _): return false
            case (_, nil): return true
            case let (x?, y?):
                let nx = name(x.id).lowercased(), ny = name(y.id).lowercased()
                return nx != ny ? nx < ny : x.id < y.id
            }
        }
    }
}

/// Where your account labels are kept: Signalbox's own accounts.json, which the CLI reads too (the web page and
/// `signalbox history` show the same names). Ids are hashes, so the file holds no vendor ids or emails.
@MainActor
public protocol AccountLabelStore: AnyObject {
    func load() -> [String: String]
    func save(_ labels: [String: String]) throws
}

/// Labels in memory only (tests, fixtures, the snapshot renderer).
@MainActor
public final class InMemoryAccountLabels: AccountLabelStore {
    public private(set) var labels: [String: String]
    public init(_ labels: [String: String] = [:]) { self.labels = labels }
    public func load() -> [String: String] { labels }
    public func save(_ labels: [String: String]) throws { self.labels = labels }
}

/// ~/Library/Application Support/signalbox/accounts.json (or $SIGNALBOX_ACCOUNTS_FILE): written atomically, 0600,
/// in a 0700 folder, only when you rename an account.
@MainActor
public final class FileAccountLabels: AccountLabelStore {
    public static let environmentKey = "SIGNALBOX_ACCOUNTS_FILE"
    public static let maxBytes = 64 * 1024
    public let url: URL

    public init(url: URL) { self.url = url }

    public static func defaultURL(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let path = environment[environmentKey], !path.isEmpty { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/signalbox/accounts.json")
    }

    public func load() -> [String: String] {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let size = attrs[.size] as? Int, size <= Self.maxBytes,
              let data = try? Data(contentsOf: url) else { return [:] }
        return Self.parse(data)
    }

    public func save(_ labels: [String: String]) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let body: [String: Any] = ["v": 1, "labels": labels]
        let data = try JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// `{ "v": 1, "labels": { "<acct-…>": "label" } }` → id → label; ids of another shape and empty labels are dropped.
    public nonisolated static func parse(_ data: Data) -> [String: String] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let labels = obj["labels"] as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (id, raw) in labels {
            guard id.range(of: #"^acct-[0-9a-f]{12}$"#, options: .regularExpression) != nil,
                  let s = raw as? String, let label = AccountNaming.sanitize(s) else { continue }
            out[id] = label
        }
        return out
    }
}
