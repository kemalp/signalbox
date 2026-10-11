import Foundation

/// ISO-8601 parsing that accepts what JavaScript's `toISOString()` writes (fractional seconds, `Z`),
/// plain second precision, explicit offsets, and bare `YYYY-MM-DD` dates (local midnight is not
/// implied; those parse as UTC midnight and are only used for display).
public enum ISODate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()
    private static let dayOnly = Date.ISO8601FormatStyle().year().month().day()

    public static func parse(_ string: String) -> Date? {
        let s = string.trimmingCharacters(in: .whitespaces)
        if let d = try? fractional.parse(s) { return d }
        if let d = try? whole.parse(s) { return d }
        if s.count == 10, let d = try? dayOnly.parse(s) { return d }
        return nil
    }

    public static func format(_ date: Date) -> String {
        fractional.format(date)
    }
}

public enum SignalboxJSON {
    /// A decoder for everything the CLI prints.
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = ISODate.parse(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not an ISO-8601 timestamp: \(s.prefix(40))")
            }
            return date
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(ISODate.format(date))
        }
        return e
    }
}
