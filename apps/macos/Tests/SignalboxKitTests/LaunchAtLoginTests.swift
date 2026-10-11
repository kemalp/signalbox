import Foundation
import Testing
@testable import SignalboxKit

/// Stands in for SMAppService.mainApp: tests never register a login item for real.
@MainActor
final class FakeLoginItemService: LoginItemService {
    struct Failure: LocalizedError {
        var errorDescription: String? { "Operation not permitted" }
    }

    var status: LoginItemStatus
    /// What `register()` leaves behind (macOS may want approval first).
    var statusAfterRegister: LoginItemStatus = .enabled
    var failNext = false
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0
    private(set) var openedSettings = 0

    init(_ status: LoginItemStatus = .notRegistered) {
        self.status = status
    }

    func register() throws {
        registerCalls += 1
        if failNext { failNext = false; throw Failure() }
        status = statusAfterRegister
    }

    func unregister() throws {
        unregisterCalls += 1
        if failNext { failNext = false; throw Failure() }
        status = .notRegistered
    }

    func openSystemSettings() { openedSettings += 1 }
}

@MainActor
@Suite("Launch at login")
struct LaunchAtLoginTests {
    @Test func turningOnAndOff() {
        let fake = FakeLoginItemService()
        let m = LaunchAtLoginModel(service: fake, location: .applications)
        #expect(!m.isOn)
        #expect(m.statusText == "Off.")
        m.setEnabled(true)
        #expect(fake.registerCalls == 1)
        #expect(m.status == .enabled)
        #expect(m.isOn)
        #expect(m.statusText == "Signalbox opens when you log in.")
        // Asking for the state it's already in does nothing.
        m.setEnabled(true)
        #expect(fake.registerCalls == 1)
        m.setEnabled(false)
        #expect(fake.unregisterCalls == 1)
        #expect(!m.isOn)
    }

    @Test func requiresApprovalCountsAsOnAndSaysWhere() {
        let fake = FakeLoginItemService()
        fake.statusAfterRegister = .requiresApproval
        let m = LaunchAtLoginModel(service: fake, location: .applications)
        m.setEnabled(true)
        #expect(m.isOn)
        #expect(m.needsApproval)
        #expect(m.statusText == "Requires approval in System Settings ▸ General ▸ Login Items.")
        m.openSystemSettings()
        #expect(fake.openedSettings == 1)
        // The user approves in System Settings; the app re-reads the status when it becomes active.
        fake.status = .enabled
        m.refresh()
        #expect(!m.needsApproval)
        #expect(m.status == .enabled)
    }

    @Test func statusMapping() {
        let cases: [(LoginItemStatus, Bool, String)] = [
            (.notRegistered, false, "Off."),
            (.enabled, true, "Signalbox opens when you log in."),
            (.requiresApproval, true, "Requires approval in System Settings ▸ General ▸ Login Items."),
            (.notFound, false, "Off. macOS has no login item for this copy of Signalbox yet."),
        ]
        for (status, on, text) in cases {
            let m = LaunchAtLoginModel(service: FakeLoginItemService(status), location: .applications)
            #expect(m.isOn == on)
            #expect(m.statusText == text)
        }
    }

    @Test func errorsAreShownAndTheStatusStaysTrue() {
        let fake = FakeLoginItemService()
        fake.failNext = true
        let m = LaunchAtLoginModel(service: fake, location: .applications)
        m.setEnabled(true)
        #expect(!m.isOn)
        #expect(m.lastError == "Couldn't turn launch at login on: Operation not permitted")
        m.setEnabled(true)
        #expect(m.isOn)
        #expect(m.lastError == nil)
    }

    @Test func outsideABundleNothingIsRegistered() {
        let fake = FakeLoginItemService()
        let m = LaunchAtLoginModel(service: fake, location: .notBundled)
        #expect(!m.canToggle)
        m.setEnabled(true)
        #expect(fake.registerCalls == 0)
        #expect(m.statusText.contains("needs the Signalbox app bundle"))
        #expect(m.locationWarning == nil)
    }

    @Test func locationClassification() {
        let home = "/Users/you"
        #expect(AppLocation.classify(bundlePath: "/Applications/Signalbox.app", home: home) == .applications)
        #expect(AppLocation.classify(bundlePath: "/Applications/Utilities/Signalbox.app/", home: home) == .applications)
        #expect(AppLocation.classify(bundlePath: "/Users/you/Applications/Signalbox.app", home: home) == .applications)
        let build = "/Users/you/code/signalbox/apps/macos/build/Signalbox.app"
        #expect(AppLocation.classify(bundlePath: build, home: home) == .buildFolder(build))
        #expect(AppLocation.classify(bundlePath: "/Users/you/Library/Developer/Xcode/DerivedData/x/Build/Products/Debug/Signalbox.app", home: home)
            == .buildFolder("/Users/you/Library/Developer/Xcode/DerivedData/x/Build/Products/Debug/Signalbox.app"))
        #expect(AppLocation.classify(bundlePath: "/private/tmp/copy/Signalbox.app", home: home) == .other("/private/tmp/copy/Signalbox.app"))
        #expect(AppLocation.classify(bundlePath: "/Users/you/code/signalbox/apps/macos/.build/debug", home: home) == .notBundled)
        // "Applications" must be the folder, not a prefix of another name.
        #expect(AppLocation.classify(bundlePath: "/ApplicationsOld/Signalbox.app", home: home) == .other("/ApplicationsOld/Signalbox.app"))
    }

    @Test func aBuildFolderGetsTheStableLocationAdvice() {
        let m = LaunchAtLoginModel(service: FakeLoginItemService(), location: .buildFolder("/Users/you/code/signalbox/apps/macos/build/Signalbox.app"))
        #expect(m.canToggle)
        #expect(m.locationWarning?.contains("build-app.sh --install") == true)
        #expect(m.locationWarning?.contains("stable location") == true)
        let other = LaunchAtLoginModel(service: FakeLoginItemService(), location: .other("/private/tmp/Signalbox.app"))
        #expect(other.locationWarning?.contains("~/Applications") == true)
        #expect(LaunchAtLoginModel(service: FakeLoginItemService(), location: .applications).locationWarning == nil)
    }
}
