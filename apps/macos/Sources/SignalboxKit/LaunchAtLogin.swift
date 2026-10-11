import Foundation
import Observation

/// Mirrors `SMAppService.Status`. The app maps the real status into this; tests use a fake service.
public enum LoginItemStatus: Equatable, Sendable {
    case notRegistered
    case enabled
    /// Registered, but the user has to allow it in System Settings ▸ General ▸ Login Items.
    case requiresApproval
    case notFound
}

/// Launch at login, behind a protocol so tests never register anything for real.
@MainActor
public protocol LoginItemService: AnyObject {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
    /// Opens System Settings ▸ General ▸ Login Items.
    func openSystemSettings()
}

/// Where the running app lives, which decides how well launch at login will work.
public enum AppLocation: Equatable, Sendable {
    /// /Applications or ~/Applications (or a folder inside them).
    case applications
    /// A build output folder (apps/macos/build, .build, DerivedData): rebuilt and replaced often.
    case buildFolder(String)
    /// Somewhere else, e.g. the Desktop or a temporary folder.
    case other(String)
    /// Not an .app bundle at all (`swift run`).
    case notBundled

    public static func classify(bundlePath: String, home: String = NSHomeDirectory()) -> AppLocation {
        var path = bundlePath
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        guard path.hasSuffix(".app") else { return .notBundled }
        let h = home.hasSuffix("/") ? String(home.dropLast()) : home
        for root in ["/Applications/", "\(h)/Applications/"] where path.hasPrefix(root) {
            return .applications
        }
        for marker in ["/build/", "/.build/", "/DerivedData/"] where path.contains(marker) {
            return .buildFolder(path)
        }
        return .other(path)
    }
}

/// What the Settings ▸ General launch-at-login row shows and does.
@MainActor
@Observable
public final class LaunchAtLoginModel {
    public private(set) var status: LoginItemStatus
    /// The last register/unregister error, in words.
    public private(set) var lastError: String?
    public let location: AppLocation
    @ObservationIgnored private let service: any LoginItemService

    public init(service: any LoginItemService, location: AppLocation) {
        self.service = service
        self.location = location
        status = service.status
    }

    /// Registered, whether or not macOS has let it run yet.
    public var isOn: Bool { status == .enabled || status == .requiresApproval }
    public var needsApproval: Bool { status == .requiresApproval }
    public var canToggle: Bool { location != .notBundled }

    public func refresh() {
        status = service.status
    }

    public func setEnabled(_ on: Bool) {
        guard canToggle, on != isOn else { return }
        do {
            if on { try service.register() } else { try service.unregister() }
            lastError = nil
        } catch {
            lastError = "Couldn't turn launch at login \(on ? "on" : "off"): \(error.localizedDescription)"
        }
        status = service.status
    }

    public func openSystemSettings() {
        service.openSystemSettings()
    }

    public var statusText: String {
        if location == .notBundled { return "Launch at login needs the Signalbox app bundle (build it with apps/macos/scripts/build-app.sh)." }
        switch status {
        case .enabled: return "Signalbox opens when you log in."
        case .requiresApproval: return "Requires approval in System Settings ▸ General ▸ Login Items."
        case .notRegistered: return "Off."
        case .notFound: return "Off. macOS has no login item for this copy of Signalbox yet."
        }
    }

    /// The folder holding the app, with the home folder as "~".
    static func folder(of appPath: String) -> String {
        ((appPath as NSString).deletingLastPathComponent as NSString).abbreviatingWithTildeInPath
    }

    /// Advice when the app isn't somewhere stable, or nil.
    public var locationWarning: String? {
        switch location {
        case .applications, .notBundled:
            return nil
        case let .buildFolder(path):
            return "Signalbox is running from a build folder (\(Self.folder(of: path))). Launch at login works best from a stable location: run apps/macos/scripts/build-app.sh --install to copy it to ~/Applications, then open that copy."
        case let .other(path):
            return "Signalbox is running from \(Self.folder(of: path)). Launch at login works best from a stable location such as ~/Applications."
        }
    }
}
