import Foundation

/// A string enum that decodes values it doesn't know as `fallback` instead of failing,
/// so a new status or stability added by a newer CLI never breaks decoding.
public protocol LenientStringEnum: RawRepresentable, Codable, Sendable, Hashable, CaseIterable where RawValue == String {
    static var fallback: Self { get }
}

extension LenientStringEnum {
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// Decodes an array element by element and drops elements that fail, so one malformed
/// session or limit row doesn't take the whole snapshot down with it.
struct LossyArray<Element: Decodable>: Decodable {
    var elements: [Element]

    /// Decodes any JSON value without looking at it; used to step over a malformed element.
    private struct Skip: Decodable {
        init(from decoder: any Decoder) throws {}
    }

    init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        if let n = c.count { out.reserveCapacity(n) }
        while !c.isAtEnd {
            if let e = try? c.decode(Element.self) {
                out.append(e)
            } else if (try? c.decode(Skip.self)) == nil {
                break
            }
        }
        elements = out
    }
}

extension KeyedDecodingContainer {
    /// A missing or null array is empty; malformed elements are dropped.
    func lossyArray<T: Decodable>(_: T.Type, forKey key: Key) -> [T] {
        guard (try? decodeNil(forKey: key)) == false else { return [] }
        return (try? decode(LossyArray<T>.self, forKey: key).elements) ?? []
    }

    /// Like `lossyArray`, but keeps "absent" distinct from "empty".
    func lossyArrayIfPresent<T: Decodable>(_: T.Type, forKey key: Key) -> [T]? {
        guard contains(key), (try? decodeNil(forKey: key)) == false else { return nil }
        return try? decode(LossyArray<T>.self, forKey: key).elements
    }
}
