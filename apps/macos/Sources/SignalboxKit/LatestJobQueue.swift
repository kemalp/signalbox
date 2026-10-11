import Foundation

/// Runs async jobs one at a time, in the order they were asked for. A job still waiting when a newer one arrives is
/// skipped, since the newer one reads the latest settings anyway. For restarting the CLI: two restarts that overlap
/// would each start a child, and the one the app loses track of would keep running (and keep its old flags).
@MainActor
public final class LatestJobQueue {
    private var tail: Task<Void, Never>?
    private var requested = 0

    public init() {}

    /// Runs `job` after every earlier one has finished, unless a newer job is asked for first. Returns once `job`
    /// ran, or once it was skipped.
    public func run(_ job: @escaping @MainActor @Sendable () async -> Void) async {
        requested += 1
        let ticket = requested
        let previous = tail
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, ticket == self.requested else { return }
            await job()
        }
        tail = task
        await task.value
    }
}
