import AppKit
import ServiceManagement
import SignalboxKit
import UserNotifications

// The app's bridges to macOS services: notifications and launch at login. Each sits behind a SignalboxKit
// protocol, so tests and the snapshot renderer use fakes and never touch the real thing.

// MARK: - Notifications

/// Posts through UNUserNotificationCenter. Only created when running from an app bundle and not in dry-run
/// mode; permission is asked for only when the user clicks "Turn On" (Sessions banner or Settings).
@MainActor
@Observable
final class UserNotificationsNotifier: NSObject, Notifier, UNUserNotificationCenterDelegate {
    private(set) var authorization: NotificationAuthorization = .notDetermined
    /// A click on a notification (or one of its buttons).
    @ObservationIgnored var onRoute: ((NotificationRoute) -> Void)?

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    /// Must run before the app finishes launching, so a click that launched the app is delivered.
    func activate() {
        center.delegate = self
        let open = UNNotificationAction(identifier: NotificationRouting.openAction, title: "Open", options: [.foreground])
        let mute = UNNotificationAction(identifier: NotificationRouting.muteAction, title: "Mute this session", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationRouting.sessionCategory, actions: [open, mute], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: NotificationRouting.generalCategory, actions: [open], intentIdentifiers: [], options: []),
        ])
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        let status = await center.notificationSettings().authorizationStatus
        let mapped = Self.map(status)
        if mapped != authorization { authorization = mapped }
    }

    func requestAuthorization() async {
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            FileHandle.standardError.write(Data("signalbox-app: notification permission request failed: \(error.localizedDescription)\n".utf8))
        }
        await refreshAuthorization()
    }

    func post(_ request: NotificationRequest) {
        if authorization.canPost {
            add(request)
        } else {
            // The permission may have been granted in System Settings since we last looked. Never asks.
            Task {
                await refreshAuthorization()
                if authorization.canPost { add(request) }
            }
        }
    }

    private func add(_ r: NotificationRequest) {
        let content = UNMutableNotificationContent()
        content.title = r.title
        content.body = r.body
        content.sound = .default
        content.categoryIdentifier = NotificationRouting.category(for: r)
        content.threadIdentifier = r.target.encoded
        content.userInfo = NotificationRouting.userInfo(for: r)
        center.add(UNNotificationRequest(identifier: r.id, content: content, trigger: nil)) { error in
            if let error {
                FileHandle.standardError.write(Data("signalbox-app: could not post a notification: \(error.localizedDescription)\n".utf8))
            }
        }
    }

    static func map(_ status: UNAuthorizationStatus) -> NotificationAuthorization {
        switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .ephemeral: .authorized
        case .provisional: .provisional
        @unknown default: .denied
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        var info: [String: String] = [:]
        for (k, v) in response.notification.request.content.userInfo {
            if let k = k as? String, let v = v as? String { info[k] = v }
        }
        let route = NotificationRouting.route(actionIdentifier: action, userInfo: info)
        await MainActor.run { self.onRoute?(route) }
    }
}

/// Used when the notification center can't be (outside an app bundle UNUserNotificationCenter crashes).
@MainActor
@Observable
final class UnavailableNotifier: Notifier {
    let authorization: NotificationAuthorization

    init(reason: String) {
        authorization = .unavailable(reason)
    }

    func refreshAuthorization() async {}
    func requestAuthorization() async {}
    func post(_ request: NotificationRequest) {}
}

/// A notifier with a fixed permission that shows nothing: the snapshot renderer's.
@MainActor
@Observable
final class StaticNotifier: Notifier {
    var authorization: NotificationAuthorization

    init(_ authorization: NotificationAuthorization) {
        self.authorization = authorization
    }

    func refreshAuthorization() async {}
    func requestAuthorization() async {}
    func post(_ request: NotificationRequest) {}
}

enum SystemSettingsLinks {
    static func openNotifications() {
        let id = Bundle.main.bundleIdentifier.map { "?id=\($0)" } ?? ""
        open("x-apple.systempreferences:com.apple.Notifications-Settings.extension\(id)")
    }

    static func openLoginItems() {
        open("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
    }

    private static func open(_ s: String) {
        if let url = URL(string: s) { NSWorkspace.shared.open(url) }
    }
}

// MARK: - Launch at login

/// SMAppService.mainApp. Only ever registered or unregistered from the Settings toggle.
@MainActor
final class MainAppLoginItem: LoginItemService {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .notRegistered: .notRegistered
        case .enabled: .enabled
        case .requiresApproval: .requiresApproval
        case .notFound: .notFound
        @unknown default: .notFound
        }
    }

    func register() throws { try SMAppService.mainApp.register() }
    func unregister() throws { try SMAppService.mainApp.unregister() }
    func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Outside an app bundle (and in the snapshot renderer): a fixed status; nothing is ever registered.
@MainActor
final class StaticLoginItem: LoginItemService {
    struct NotAvailable: LocalizedError {
        var errorDescription: String? { "launch at login needs the Signalbox app bundle" }
    }

    let status: LoginItemStatus

    init(_ status: LoginItemStatus = .notRegistered) {
        self.status = status
    }

    func register() throws { throw NotAvailable() }
    func unregister() throws { throw NotAvailable() }
    func openSystemSettings() { SystemSettingsLinks.openLoginItems() }
}
