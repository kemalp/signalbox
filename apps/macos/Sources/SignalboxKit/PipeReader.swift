import Foundation
import os

/// Reads a pipe's output as an `AsyncStream` of chunks via `readabilityHandler`.
/// `stop()` ends the stream early: a grandchild that inherited the pipe can keep it open after
/// the child exits, and we don't want to wait on it forever.
final class PipeReader: Sendable {
    let chunks: AsyncStream<Data>
    private let handle: FileHandle
    private let continuation: AsyncStream<Data>.Continuation
    private let stopped = OSAllocatedUnfairLock(initialState: false)

    init(_ handle: FileHandle) {
        self.handle = handle
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        chunks = stream
        self.continuation = continuation
        handle.readabilityHandler = { [continuation, stopped] h in
            let data = h.availableData
            if data.isEmpty {
                h.readabilityHandler = nil
                stopped.withLock { $0 = true }
                continuation.finish()
            } else {
                continuation.yield(data)
            }
        }
    }

    func stop() {
        let wasStopped = stopped.withLock { s in
            defer { s = true }
            return s
        }
        guard !wasStopped else { return }
        handle.readabilityHandler = nil
        continuation.finish()
    }

    deinit {
        handle.readabilityHandler = nil
        continuation.finish()
    }
}
