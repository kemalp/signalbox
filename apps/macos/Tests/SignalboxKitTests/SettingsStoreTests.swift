import Foundation
import Testing
@testable import SignalboxKit

/// Settings storage per test, in memory: never the app's real domain, and no plist left in ~/Library/Preferences
/// (a removed UserDefaults suite still leaves an empty one behind).
final class TestDefaults: @unchecked Sendable {
    let defaults = InMemorySettings()
}

@MainActor
@Suite("Settings store")
struct SettingsStoreTests {
    @Test func emptyDefaultsGiveTheDocumentedDefaultsAndWriteNothing() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        #expect(s.loadedSchemaVersion == nil)
        #expect(s.showDockIcon)
        #expect(s.menuBarLabel == .fiveHour)
        #expect(s.notifyWaiting)
        #expect(s.notifyLongTask)
        #expect(s.longTaskMinutes == 3)
        #expect(s.notifyLimits)
        #expect(s.limitThresholds == [80, 95])
        #expect(!s.notifyCLIFailure)
        #expect(s.quietWhenViewing)
        #expect(!s.notificationBannerDismissed)
        #expect(s.mutes.isEmpty)
        #expect(s.currency == .usd)
        #expect(s.rates.isEmpty)
        #expect(s.planPrice == nil)
        #expect(s.planCurrency == .usd)
        #expect(s.cliPathOverride.isEmpty)
        #expect(s.money == .usd)
        #expect(s.notificationSettings == NotificationSettings.defaults)
        // Launching must not touch the defaults at all.
        for key in SettingsStore.Key.all {
            #expect(d.defaults.object(forKey: key) == nil, "\(key) was written on launch")
        }
    }

    @Test func changesPersistAcrossInstancesAndStampTheSchema() {
        let d = TestDefaults()
        let now = date("2026-10-09T14:30:00Z")
        do {
            let s = SettingsStore(defaults: d.defaults)
            s.showDockIcon = false
            s.menuBarLabel = .todaySpend
            s.notifyWaiting = false
            s.longTaskMinutes = 12
            s.limitThresholds = [70, 90]
            s.notifyCLIFailure = true
            s.quietWhenViewing = false
            s.notificationBannerDismissed = true
            s.currency = .gbp
            s.setRate(0.79, for: .gbp)
            s.setRateAsOf(now, for: .gbp)
            s.planPrice = 180
            s.planCurrency = .gbp
            s.cliPathOverride = "/opt/signalbox"
            s.setMuted(true, sessionID: "claude-code/a", now: now)
        }
        #expect(d.defaults.object(forKey: SettingsStore.Key.schema) as? Int == SettingsStore.schemaVersion)
        let s = SettingsStore(defaults: d.defaults)
        #expect(s.loadedSchemaVersion == SettingsStore.schemaVersion)
        #expect(!s.showDockIcon)
        #expect(s.menuBarLabel == .todaySpend)
        #expect(!s.notifyWaiting)
        #expect(s.longTaskMinutes == 12)
        #expect(s.limitThresholds == [70, 90])
        #expect(s.notifyCLIFailure)
        #expect(!s.quietWhenViewing)
        #expect(s.notificationBannerDismissed)
        #expect(s.currency == .gbp)
        #expect(s.rate(for: .gbp) == 0.79)
        #expect(s.rateAsOf(for: .gbp) == now)
        #expect(s.money == Money(currency: .gbp, rate: 0.79, rateAsOf: now))
        #expect(s.plan == PlanPrice(amount: 180, currency: .gbp))
        #expect(s.cliPathOverride == "/opt/signalbox")
        #expect(s.isMuted("claude-code/a"))
        #expect(s.notificationSettings.limitThresholds == [70, 90])
        #expect(s.notificationSettings.longTaskMinutes == 12)
    }

    @Test func wrongTypesAndBadValuesFallBackToDefaults() {
        let d = TestDefaults()
        d.defaults.set(SettingsStore.schemaVersion, forKey: SettingsStore.Key.schema)
        d.defaults.set("yes", forKey: SettingsStore.Key.showDockIcon)
        d.defaults.set("sideways", forKey: SettingsStore.Key.menuBarLabel)
        d.defaults.set(9999, forKey: SettingsStore.Key.longTaskMinutes)
        d.defaults.set([0, 250, 7], forKey: SettingsStore.Key.limitThresholds)
        d.defaults.set("JPY", forKey: SettingsStore.Key.currency)
        d.defaults.set(["GBP": -1.0, "EUR": 0.92, "USD": 2.0, "XYZ": 1.0], forKey: SettingsStore.Key.rates)
        d.defaults.set(-5.0, forKey: SettingsStore.Key.planPrice)
        d.defaults.set(Data("not json".utf8), forKey: SettingsStore.Key.mutes)
        let s = SettingsStore(defaults: d.defaults)
        #expect(s.showDockIcon)
        #expect(s.menuBarLabel == .fiveHour)
        #expect(s.longTaskMinutes == 120)
        #expect(s.limitThresholds == [1, 100])
        #expect(s.currency == .usd)
        #expect(s.rates == [.eur: 0.92])
        #expect(s.planPrice == nil)
        #expect(s.mutes.isEmpty)
    }

    @Test func aNewerSchemaIsReadAsFarAsKnownAndNeverDowngraded() {
        let d = TestDefaults()
        d.defaults.set(SettingsStore.schemaVersion + 5, forKey: SettingsStore.Key.schema)
        d.defaults.set(false, forKey: SettingsStore.Key.notifyLimits)
        d.defaults.set("some future value", forKey: "notify.somethingNew")
        let s = SettingsStore(defaults: d.defaults)
        #expect(s.loadedSchemaVersion == SettingsStore.schemaVersion + 5)
        #expect(!s.notifyLimits)
        s.notifyLimits = true
        #expect(d.defaults.object(forKey: SettingsStore.Key.schema) as? Int == SettingsStore.schemaVersion + 5)
        #expect(d.defaults.object(forKey: "notify.somethingNew") as? String == "some future value")
    }

    @Test func valuesAreClampedWhenSet() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        s.longTaskMinutes = 0
        #expect(s.longTaskMinutes == 1)
        s.limitThresholds = [150]
        #expect(s.limitThresholds == [100, 95])
        s.limitThresholds[1] = -4
        #expect(s.limitThresholds == [100, 1])
        s.planPrice = .nan
        #expect(s.planPrice == nil)
        s.setRate(0, for: .gbp)
        #expect(s.rate(for: .gbp) == nil)
        s.setRate(1.5, for: .usd)
        #expect(s.rate(for: .usd) == 1)
        #expect(SettingsStore(defaults: d.defaults).longTaskMinutes == 1)
    }

    @Test func aCurrencyWithoutARateStaysInUSD() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        s.currency = .eur
        #expect(s.currencyNeedsRate)
        #expect(s.money == .usd)
        s.setRate(0.92, for: .eur)
        #expect(!s.currencyNeedsRate)
        #expect(s.money.currency == .eur)
        // Each currency keeps its own rate.
        s.setRate(0.79, for: .gbp)
        s.currency = .gbp
        #expect(s.money.rate == 0.79)
        s.currency = .eur
        #expect(s.money.rate == 0.92)
    }

    @Test func inMemorySettingsReadBackLikeUserDefaults() {
        let m = InMemorySettings(["n": 3])
        // Bridged on the way in, as UserDefaults hands values out: an Int reads as a Double too.
        #expect(m.object(forKey: "n") as? Int == 3)
        #expect(m.object(forKey: "n") as? Double == 3)
        m.set([80, 95], forKey: "a")
        #expect((m.object(forKey: "a") as? [Any])?.compactMap { $0 as? Int } == [80, 95])
        m.set(nil, forKey: "n")
        #expect(m.object(forKey: "n") == nil)
        m.set("x", forKey: "s")
        m.removeObject(forKey: "s")
        #expect(m.object(forKey: "s") == nil)
        // A plan price written as a whole number still loads.
        let d = TestDefaults()
        d.defaults.set(200, forKey: SettingsStore.Key.planPrice)
        #expect(SettingsStore(defaults: d.defaults).planPrice == 200)
    }

    @Test func resetAllRemovesEverything() {
        let d = TestDefaults()
        let s = SettingsStore(defaults: d.defaults)
        s.showDockIcon = false
        s.currency = .gbp
        s.setRate(0.8, for: .gbp)
        s.setMuted(true, sessionID: "x/y")
        s.resetAll()
        #expect(s.showDockIcon)
        #expect(s.currency == .usd)
        #expect(s.rates.isEmpty)
        #expect(s.mutes.isEmpty)
        for key in SettingsStore.Key.all {
            #expect(d.defaults.object(forKey: key) == nil, "\(key) survived the reset")
        }
    }

    @Test func mutesPruneAndPersist() {
        let d = TestDefaults()
        let t0 = date("2026-10-09T14:30:00Z")
        let s = SettingsStore(defaults: d.defaults)
        s.setMuted(true, sessionID: "claude-code/a", now: t0)
        s.setMuted(true, sessionID: "claude-code/b", now: t0)
        s.setMuted(true, sessionID: "claude-code/c", now: t0)
        let fleet = FleetSnapshot(generatedAt: t0, sessions: [session("a", .busy), session("b", .ended)])
        s.pruneMutes(fleet: fleet, now: t0.addingTimeInterval(60))
        // b ended; c is gone but within the grace period.
        #expect(s.mutes.ids == ["claude-code/a", "claude-code/c"])
        s.pruneMutes(fleet: fleet, now: t0.addingTimeInterval(11 * 60))
        #expect(s.mutes.ids == ["claude-code/a"])
        #expect(SettingsStore(defaults: d.defaults).mutes.ids == ["claude-code/a"])
        s.unmuteAll()
        #expect(SettingsStore(defaults: d.defaults).mutes.isEmpty)
    }
}
