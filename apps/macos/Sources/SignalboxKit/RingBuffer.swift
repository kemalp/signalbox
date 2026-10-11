/// A fixed-capacity FIFO that drops the oldest element when full.
public struct RingBuffer<Element>: Sequence {
    public let capacity: Int
    private var storage: [Element] = []
    private var head = 0
    /// Elements dropped because the buffer was full.
    public private(set) var droppedCount = 0

    public init(capacity: Int) {
        precondition(capacity > 0, "RingBuffer capacity must be positive")
        self.capacity = capacity
        storage.reserveCapacity(capacity)
    }

    public var count: Int { storage.count }
    public var isEmpty: Bool { storage.isEmpty }

    public mutating func append(_ element: Element) {
        if storage.count < capacity {
            storage.append(element)
        } else {
            storage[head] = element
            head = (head + 1) % capacity
            droppedCount += 1
        }
    }

    public mutating func removeAll() {
        storage.removeAll(keepingCapacity: true)
        head = 0
    }

    /// Oldest first.
    public var elements: [Element] {
        Array(storage[head...] + storage[..<head])
    }

    public var last: Element? {
        guard !storage.isEmpty else { return nil }
        return storage[(head + storage.count - 1) % storage.count]
    }

    public func makeIterator() -> IndexingIterator<[Element]> {
        elements.makeIterator()
    }
}

extension RingBuffer: Sendable where Element: Sendable {}
extension RingBuffer: Equatable where Element: Equatable {
    public static func == (a: RingBuffer, b: RingBuffer) -> Bool { a.elements == b.elements && a.capacity == b.capacity }
}
