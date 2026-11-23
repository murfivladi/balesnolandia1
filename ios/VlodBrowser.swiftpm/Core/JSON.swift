import Foundation

/// JSON произвольной формы: ответы API, сертификаты, хранилища сайтов.
enum JSON: Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSON].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSON].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Неизвестное значение JSON")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    static func parse(_ data: Data) -> JSON? {
        try? JSONDecoder().decode(JSON.self, from: data)
    }

    /// Из объекта JSONSerialization / сообщения WebKit (NSNumber, NSString, NSArray, NSDictionary).
    static func from(any v: Any?) -> JSON {
        guard let v else { return .null }
        if v is NSNull { return .null }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            return .number(n.doubleValue)
        }
        if let s = v as? String { return .string(s) }
        if let a = v as? [Any] { return .array(a.map { JSON.from(any: $0) }) }
        if let o = v as? [String: Any] {
            var out: [String: JSON] = [:]
            for (k, x) in o { out[k] = JSON.from(any: x) }
            return .object(out)
        }
        return .string(String(describing: v))
    }

    /// Для JSONSerialization (тело запроса).
    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map { $0.any }
        case .object(let o): return o.mapValues { $0.any }
        }
    }

    // MARK: Доступ

    subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    subscript(index: Int) -> JSON? {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return nil
    }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return JSON.formatNumber(n)
        default: return nil
        }
    }

    var double: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }

    var int: Int? { double.map { Int($0) } }

    var bool: Bool {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return !s.isEmpty
        case .null: return false
        case .array, .object: return true
        }
    }

    var array: [JSON] {
        if case .array(let a) = self { return a }
        return []
    }

    var object: [String: JSON] {
        if case .object(let o) = self { return o }
        return [:]
    }

    var isNull: Bool { self == .null }

    // MARK: Канонический JSON — как canonical() в shared/balnet-pki.js

    /// Ключи по алфавиту (в кодовых единицах UTF-16, как Array.sort в JS), без пробелов, строки — как JSON.stringify.
    var canonical: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return JSON.formatNumber(n)
        case .string(let s): return JSON.quote(s)
        case .array(let a): return "[" + a.map { $0.canonical }.joined(separator: ",") + "]"
        case .object(let o):
            let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + keys.map { JSON.quote($0) + ":" + (o[$0] ?? .null).canonical }.joined(separator: ",") + "}"
        }
    }

    /// Компактная запись для показа (DevTools, хранилище).
    var compact: String {
        switch self {
        case .string(let s): return s
        default: return canonical
        }
    }

    /// Число как в JavaScript: целые — без дробной части.
    static func formatNumber(_ n: Double) -> String {
        if !n.isFinite { return "null" }
        if n == n.rounded(), abs(n) < 1e21 {
            if abs(n) < 9e15 { return String(Int64(n)) }
            return String(format: "%.0f", n)
        }
        var s = "\(n)"
        if s.contains("e") {
            // Swift: 1e-07 → JS: 1e-7
            s = s.replacingOccurrences(of: "e-0", with: "e-").replacingOccurrences(of: "e+0", with: "e+")
            if !s.contains("e-") && !s.contains("e+") { s = s.replacingOccurrences(of: "e", with: "e+") }
        }
        return s
    }

    /// Строка как JSON.stringify.
    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }
}
