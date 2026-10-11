import Foundation

/// Runs the notification policy against what the store receives and hands the results to a notifier.
/// Fleets are evaluated the moment they arrive (no extra tick); the CLI-failure rule is checked on a timer,
/// since a failing CLI sends nothing.
@MainActor
public final class NotificationCoordinator {
    public private(set) var policy = NotificationPolicy()
    private let store: SignalboxStore
    private let settings: SettingsStore
    private let notifier: any Notifier
    private let viewing: @MainActor () -> ViewingState
    private let clock: @Sendable () -> Date
    private var connectionTask: Task<Void, Never>?
    /// Sees every request handed to the notifier (the app's SIGNALBOX_DEBUG log).
    public var onPost: ((NotificationRequest) -> Void)?

    /// How often the CLI-failure rule is re-checked.
    public static let connectionCheckInterval: Duration = .seconds(5)

    public init(store: SignalboxStore, settings: SettingsStore, notifier: any Notifier,
                viewing: @escaping @MainActor () -> ViewingState = { .none },
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.settings = settings
        self.notifier = notifier
        self.viewing = viewing
        self.clock = clock
    }

    /// Starts listening to the store's fleets and checking the connection.
    public func start() {
        store.fleetObserver = { [weak self] previous, current in
            self?.fleetUpdated(previous: previous, current: current)
        }
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.connectionCheckInterval)
                self?.checkConnection()
            }
        }
    }

    public func stop() {
        store.fleetObserver = nil
        connectionTask?.cancel()
        connectionTask = nil
    }

    private func context(now: Date) -> NotificationContext {
        NotificationContext(now: now, settings: settings.notificationSettings, muted: settings.mutes.ids, viewing: viewing())
    }

    public func fleetUpdated(previous: FleetSnapshot?, current: FleetSnapshot) {
        let now = clock()
        // Judge the fleet with the mutes as they were: the fleet that reports a muted session's end must
        // still treat it as muted. Only then drop the mutes that fleet ended.
        let ctx = context(now: now)
        settings.pruneMutes(fleet: current, now: now)
        post(policy.evaluate(previous: previous, current: current, context: ctx))
    }

    public func checkConnection() {
        post(policy.evaluate(connection: CLIHealth(store.connection), context: context(now: clock())))
    }

    /// Settings ▸ Notifications ▸ Send Test Notification. Goes through the same notifier, so dry-run logs it.
    public func sendTest() {
        post([NotificationPolicy.testRequest(now: clock())])
    }

    private func post(_ requests: [NotificationRequest]) {
        for r in requests {
            onPost?(r)
            notifier.post(r)
        }
    }
}
