import Foundation
import Observation

/// What the menu bar item shows next to its symbol.
public enum MenuBarLabelMode: String, CaseIterable, Identifiable, Sendable {
    case iconOnly
    /// The highest fresh 5-hour-window reading (the default; what milestone 2 showed).
    case fiveHour
    /// The highest fresh weekly reading.
    case weekly
    /// Today's recorded spend, from the current report.
    case todaySpend

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .iconOnly: "Icon only"
        case .fiveHour: "Highest 5-hour %"
        case .weekly: "Weekly %"
        case .todaySpend: "Today's spend"
        }
    }
}

/// Where settings are kept: the app's `UserDefaults`, or `InMemorySettings` in tests and the snapshot renderer.
/// (A throwaway `UserDefaults` suite is no substitute: removing it still leaves an empty plist behind in
/// ~/Library/Preferences.)
public protocol SettingsBackend: AnyObject {
    func object(forKey key: String) -> Any?
    func set(_ value: Any?, forKey key: String)
    func removeObject(forKey key: String)
}

extension UserDefaults: SettingsBackend {}

/// Settings that live only as long as this object. Values are bridged to Foundation objects on the way in,
/// so they read back the way `UserDefaults` hands them out (an `Int` reads as a `Double`, arrays as `[Any]`).
public final class InMemorySettings: SettingsBackend {
    private var values: [String: Any] = [:]

    public init(_ values: [String: Any] = [:]) {
        for (k, v) in values { set(v, forKey: k) }
    }

    public func object(forKey key: String) -> Any? { values[key] }

    public func set(_ value: Any?, forKey key: String) {
        values[key] = value.map { $0 as AnyObject }
    }

    public func removeObject(forKey key: String) {
        values[key] = nil
    }
}

/// Every user setting, persisted in the backend it is given (the app's defaults; tests use `InMemorySettings`).
///
/// Nothing is written until the user changes something, so launching the app never touches its defaults.
/// The first write also stamps `settings.schemaVersion`, which future migrations key off.
@MainActor
@Observable
public final class SettingsStore {
    public static let schemaVersion = 1

    enum Key {
        static let schema = "settings.schemaVersion"
        static let showDockIcon = "general.showDockIcon"
        static let menuBarLabel = "general.menuBarLabel"
        static let notifyWaiting = "notify.waiting"
        static let notifyLongTask = "notify.longTask"
        static let longTaskMinutes = "notify.longTaskMinutes"
        static let notifyLimits = "notify.limits"
        static let limitThresholds = "notify.limitThresholds"
        static let notifyCLIFailure = "notify.cliFailure"
        static let quietWhenViewing = "notify.quietWhenViewing"
        static let bannerDismissed = "notify.bannerDismissed"
        static let mutes = "notify.mutedSessions"
        static let currency = "display.currency"
        static let rates = "display.rates"
        static let ratesAsOf = "display.ratesAsOf"
        static let planPrice = "display.planPrice"
        static let planCurrency = "display.planCurrency"
        static let cliPath = "advanced.cliPathOverride"
        static let includeClaudeApp = "advanced.includeClaudeAppSessions"

        static let all = [schema, showDockIcon, menuBarLabel, notifyWaiting, notifyLongTask, longTaskMinutes, notifyLimits,
                          limitThresholds, notifyCLIFailure, quietWhenViewing, bannerDismissed, mutes, currency, rates,
                          ratesAsOf, planPrice, planCurrency, cliPath, includeClaudeApp]
    }

    public static let defaultThresholds = [80, 95]
    public static let longTaskMinuteRange = 1...120

    // MARK: General

    public var showDockIcon = true { didSet { write(Key.showDockIcon, showDockIcon) } }
    public var menuBarLabel = MenuBarLabelMode.fiveHour { didSet { write(Key.menuBarLabel, menuBarLabel.rawValue) } }

    // MARK: Notifications

    public var notifyWaiting = true { didSet { write(Key.notifyWaiting, notifyWaiting) } }
    public var notifyLongTask = true { didSet { write(Key.notifyLongTask, notifyLongTask) } }
    /// Clamped to `longTaskMinuteRange`.
    public var longTaskMinutes = 3 {
        didSet {
            let clamped = Self.clamp(longTaskMinutes, Self.longTaskMinuteRange)
            if clamped != longTaskMinutes { longTaskMinutes = clamped; return }
            write(Key.longTaskMinutes, longTaskMinutes)
        }
    }
    public var notifyLimits = true { didSet { write(Key.notifyLimits, notifyLimits) } }
    /// Two percents, each 1...100. Duplicates are allowed here (the policy uses each once).
    public var limitThresholds = SettingsStore.defaultThresholds {
        didSet {
            let clean = Self.cleanThresholds(limitThresholds)
            if clean != limitThresholds { limitThresholds = clean; return }
            write(Key.limitThresholds, limitThresholds)
        }
    }
    public var notifyCLIFailure = false { didSet { write(Key.notifyCLIFailure, notifyCLIFailure) } }
    public var quietWhenViewing = true { didSet { write(Key.quietWhenViewing, quietWhenViewing) } }
    /// The Sessions banner ("Get notified when a session needs you") was dismissed.
    public var notificationBannerDismissed = false { didSet { write(Key.bannerDismissed, notificationBannerDismissed) } }
    public private(set) var mutes = MuteList()

    // MARK: Display

    public var currency = DisplayCurrency.usd { didSet { write(Key.currency, currency.rawValue) } }
    /// Units per USD, per non-USD currency. Only positive finite rates are kept.
    public private(set) var rates: [DisplayCurrency: Double] = [:]
    /// When the user says each rate was taken.
    public private(set) var ratesAsOf: [DisplayCurrency: Date] = [:]
    /// Monthly plan price in `planCurrency`; nil when not set.
    public var planPrice: Double? {
        didSet {
            if let p = planPrice, !(p.isFinite && p > 0) { planPrice = nil; return }
            write(Key.planPrice, planPrice)
        }
    }
    public var planCurrency = DisplayCurrency.usd { didSet { write(Key.planCurrency, planCurrency.rawValue) } }

    // MARK: Advanced

    /// A CLI path (or `bun:/abs/main.ts`) to use instead of the bundled one; empty for none.
    public var cliPathOverride = "" { didSet { write(Key.cliPath, cliPathOverride.isEmpty ? nil : cliPathOverride) } }
    /// History includes the Claude app's session list (the CLI reads the app's session records, read-only). Off
    /// starts the CLI with --no-claude-app; changing it restarts the CLI.
    public var includeClaudeAppSessions = true { didSet { write(Key.includeClaudeApp, includeClaudeAppSessions) } }

    /// The `watch` flags these settings ask for.
    public var watchOptions: CLIWatchOptions { CLIWatchOptions(includeClaudeApp: includeClaudeAppSessions) }

    @ObservationIgnored private let defaults: any SettingsBackend
    /// The schema version found in the defaults (nil when they hold no settings yet).
    public let loadedSchemaVersion: Int?
    @ObservationIgnored private var loading = false

    public init(defaults: any SettingsBackend) {
        self.defaults = defaults
        loadedSchemaVersion = defaults.object(forKey: Key.schema) as? Int
        load()
    }

    /// Reads every value, falling back to the default for anything missing or of the wrong type. A newer
    /// schema version is read as far as this version understands it.
    private func load() {
        loading = true
        defer { loading = false }
        let d = defaults
        showDockIcon = d.object(forKey: Key.showDockIcon) as? Bool ?? true
        menuBarLabel = (d.object(forKey: Key.menuBarLabel) as? String).flatMap(MenuBarLabelMode.init(rawValue:)) ?? .fiveHour
        notifyWaiting = d.object(forKey: Key.notifyWaiting) as? Bool ?? true
        notifyLongTask = d.object(forKey: Key.notifyLongTask) as? Bool ?? true
        longTaskMinutes = Self.clamp(d.object(forKey: Key.longTaskMinutes) as? Int ?? 3, Self.longTaskMinuteRange)
        notifyLimits = d.object(forKey: Key.notifyLimits) as? Bool ?? true
        limitThresholds = Self.cleanThresholds((d.object(forKey: Key.limitThresholds) as? [Any])?.compactMap { $0 as? Int } ?? Self.defaultThresholds)
        notifyCLIFailure = d.object(forKey: Key.notifyCLIFailure) as? Bool ?? false
        quietWhenViewing = d.object(forKey: Key.quietWhenViewing) as? Bool ?? true
        notificationBannerDismissed = d.object(forKey: Key.bannerDismissed) as? Bool ?? false
        mutes = (d.object(forKey: Key.mutes) as? Data).flatMap { try? JSONDecoder().decode(MuteList.self, from: $0) } ?? MuteList()
        currency = (d.object(forKey: Key.currency) as? String).flatMap(DisplayCurrency.init(rawValue:)) ?? .usd
        var r: [DisplayCurrency: Double] = [:]
        for (k, v) in d.object(forKey: Key.rates) as? [String: Any] ?? [:] {
            if let c = DisplayCurrency(rawValue: k), c != .usd, let n = v as? Double, n.isFinite, n > 0 { r[c] = n }
        }
        rates = r
        var asOf: [DisplayCurrency: Date] = [:]
        for (k, v) in d.object(forKey: Key.ratesAsOf) as? [String: Any] ?? [:] {
            if let c = DisplayCurrency(rawValue: k), c != .usd, let date = v as? Date { asOf[c] = date }
        }
        ratesAsOf = asOf
        planPrice = (d.object(forKey: Key.planPrice) as? Double).flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        planCurrency = (d.object(forKey: Key.planCurrency) as? String).flatMap(DisplayCurrency.init(rawValue:)) ?? .usd
        cliPathOverride = d.object(forKey: Key.cliPath) as? String ?? ""
        includeClaudeAppSessions = d.object(forKey: Key.includeClaudeApp) as? Bool ?? true
    }

    private func write(_ key: String, _ value: Any?) {
        guard !loading else { return }
        if defaults.object(forKey: Key.schema) as? Int != Self.schemaVersion {
            // Stamp the version on first write. Never downgrade a newer app's stamp.
            if (defaults.object(forKey: Key.schema) as? Int ?? 0) < Self.schemaVersion { defaults.set(Self.schemaVersion, forKey: Key.schema) }
        }
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    /// Removes every setting, mutes included, and goes back to the defaults.
    public func resetAll() {
        for k in Key.all { defaults.removeObject(forKey: k) }
        load()
    }

    // MARK: Rates

    public func rate(for currency: DisplayCurrency) -> Double? {
        currency == .usd ? 1 : rates[currency]
    }

    /// Sets (or with nil, clears) the rate for a non-USD currency. Anything not positive and finite clears it.
    public func setRate(_ rate: Double?, for currency: DisplayCurrency) {
        guard currency != .usd else { return }
        rates[currency] = rate.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        write(Key.rates, rates.isEmpty ? nil : Dictionary(uniqueKeysWithValues: rates.map { ($0.key.rawValue, $0.value) }))
    }

    public func rateAsOf(for currency: DisplayCurrency) -> Date? { ratesAsOf[currency] }

    public func setRateAsOf(_ date: Date?, for currency: DisplayCurrency) {
        guard currency != .usd else { return }
        ratesAsOf[currency] = date
        write(Key.ratesAsOf, ratesAsOf.isEmpty ? nil : Dictionary(uniqueKeysWithValues: ratesAsOf.map { ($0.key.rawValue, $0.value) }))
    }

    /// The formatter every money figure goes through. GBP/EUR without a rate show USD (never a guessed rate).
    public var money: Money {
        Money(currency: currency, rate: rate(for: currency), rateAsOf: rateAsOf(for: currency))
    }

    /// True when a non-USD currency is chosen but has no rate yet (so figures stay in USD).
    public var currencyNeedsRate: Bool { currency != .usd && rates[currency] == nil }

    public var plan: PlanPrice? { PlanPrice(amount: planPrice, currency: planCurrency) }

    // MARK: Notifications

    public var notificationSettings: NotificationSettings {
        NotificationSettings(
            waiting: notifyWaiting,
            longTask: notifyLongTask,
            longTaskMinutes: Double(longTaskMinutes),
            limits: notifyLimits,
            limitThresholds: limitThresholds.map(Double.init),
            cliFailure: notifyCLIFailure,
            quietWhenViewing: quietWhenViewing
        )
    }

    public func isMuted(_ sessionID: String) -> Bool { mutes.contains(sessionID) }

    public func setMuted(_ muted: Bool, sessionID: String, now: Date = Date()) {
        guard muted != mutes.contains(sessionID) else { return }
        if muted { mutes.mute(sessionID, now: now) } else { mutes.unmute(sessionID) }
        saveMutes()
    }

    public func unmuteAll() {
        guard !mutes.isEmpty else { return }
        mutes.removeAll()
        saveMutes()
    }

    /// Forgets mutes of sessions that ended or are long gone.
    public func pruneMutes(fleet: FleetSnapshot, now: Date) {
        if mutes.prune(fleet: fleet, now: now) { saveMutes() }
    }

    private func saveMutes() {
        write(Key.mutes, mutes.isEmpty ? nil : try? JSONEncoder().encode(mutes))
    }

    // MARK: Helpers

    static func clamp(_ v: Int, _ range: ClosedRange<Int>) -> Int { min(max(v, range.lowerBound), range.upperBound) }

    /// Exactly two values in 1...100; anything missing comes from the defaults.
    static func cleanThresholds(_ values: [Int]) -> [Int] {
        var out = values.prefix(2).map { clamp($0, 1...100) }
        while out.count < 2 { out.append(defaultThresholds[out.count]) }
        return out
    }
}
