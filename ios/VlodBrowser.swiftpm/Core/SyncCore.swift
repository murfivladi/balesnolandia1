import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if canImport(CommonCrypto)
import CommonCrypto
#endif

/// Шифрование синхронизации — как web/src/browser/sync.js: ключ AES-GCM 256 из кодовой фразы (PBKDF2-SHA256),
/// блоб «base64(iv).base64(шифротекст+тег)». Сервер видит только шифротекст.
enum SyncCrypto {
    static let iterations = 210_000
    static let check = "ВлодБраузер: кодовая фраза верна"

    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// PBKDF2-HMAC-SHA256 → 32 байта ключа. Фраза нормализуется в NFC, как normalize('NFC') в браузере.
    static func deriveKey(phrase: String, salt: String, iterations: Int = iterations) throws -> Data {
        guard let saltData = Data(base64Encoded: salt) else { throw Failure(message: "Неверная соль") }
        let password = Data(phrase.precomposedStringWithCanonicalMapping.utf8)
        #if canImport(CommonCrypto)
        var out = Data(count: 32)
        let status = out.withUnsafeMutableBytes { outPtr in
            saltData.withUnsafeBytes { saltPtr in
                password.withUnsafeBytes { pwPtr in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         pwPtr.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                                         saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), saltData.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                         outPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), 32)
                }
            }
        }
        guard status == kCCSuccess else { throw Failure(message: "PBKDF2: ошибка \(status)") }
        return out
        #else
        let key = SymmetricKey(data: password)
        var u = Data(HMAC<SHA256>.authenticationCode(for: saltData + Data([0, 0, 0, 1]), using: key))
        var t = u
        for _ in 1..<iterations {
            u = Data(HMAC<SHA256>.authenticationCode(for: u, using: key))
            for i in 0..<t.count { t[i] ^= u[i] }
        }
        return t
        #endif
    }

    static func encrypt(key: Data, _ value: JSON) throws -> String {
        let plain = Data(value.jsonText.utf8)
        let sealed = try AES.GCM.seal(plain, using: SymmetricKey(data: key))
        return Data(sealed.nonce).base64EncodedString() + "." + (sealed.ciphertext + sealed.tag).base64EncodedString()
    }

    static func decrypt(key: Data, _ blob: String) throws -> JSON {
        let parts = blob.split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2, let iv = Data(base64Encoded: parts[0]), let all = Data(base64Encoded: parts[1]), all.count >= 16 else {
            throw Failure(message: "Повреждённые данные синхронизации")
        }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: all.dropLast(16), tag: all.suffix(16))
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
        guard let j = JSON.parse(plain) else { throw Failure(message: "Повреждённые данные синхронизации") }
        return j
    }

    /// Новая кодовая фраза: соль и проверочный блок уходят на сервер.
    static func create(phrase: String) throws -> (key: Data, salt: String, check: String) {
        var salt = Data(count: 16)
        for i in 0..<16 { salt[i] = UInt8.random(in: 0...255) }
        let s = salt.base64EncodedString()
        let key = try deriveKey(phrase: phrase, salt: s)
        return (key, s, try encrypt(key: key, .string(check)))
    }

    /// Проверить фразу по блоку с сервера. nil — фраза неверна.
    static func unlock(phrase: String, info: JSON) throws -> Data? {
        let key = try deriveKey(phrase: phrase, salt: info["salt"]?.string ?? "", iterations: info["iterations"]?.int ?? iterations)
        guard let c = info["check"]?.string, let v = try? decrypt(key: key, c) else { return nil }
        return v.string == check ? key : nil
    }
}

/// Слияние коллекции с серверным документом — порт merge() из web/src/browser/sync.js.
/// doc = { items: { id: { v, mt, pos } }, tomb: { id: mt } }, base — снимок прошлой синхронизации.
enum SyncMerge {
    static let tombDays: Double = 60
    static let names = ["bookmarks", "history", "passwords", "tabs", "settings"]

    static func id(_ name: String, _ x: JSON) -> String {
        switch name {
        case "bookmarks": return x["url"]?.string ?? ""
        case "history": return "\(x["ts"]?.string ?? "")|\(x["url"]?.string ?? "")"
        case "passwords": return "\(x["origin"]?.string ?? "")|\(x["username"]?.string ?? "")"
        case "tabs": return "\(x["device"]?.string ?? "")|\(x["url"]?.string ?? "")"
        default: return x["k"]?.string ?? ""
        }
    }

    static func limit(_ name: String) -> Int {
        switch name {
        case "bookmarks": return 2000
        case "history", "passwords": return 1000
        case "tabs": return 500
        default: return 50
        }
    }

    static func merge(_ name: String, local: [JSON], base: [JSON]?, doc: JSON?, now: Double = (Date().timeIntervalSince1970 * 1000).rounded()) -> (doc: JSON, list: [JSON]) {
        var items = doc?["items"]?.object ?? [:]
        var tomb = doc?["tomb"]?.object ?? [:]
        var baseMap: [String: JSON] = [:]
        for x in base ?? [] { baseMap[id(name, x)] = x }
        var localIds = Set<String>()
        for (i, x) in local.enumerated() {
            let k = id(name, x)
            if localIds.contains(k) { continue }
            localIds.insert(k)
            if baseMap[k] == nil || baseMap[k] != x {
                items[k] = .object(["v": x, "mt": .number(now), "pos": .number(Double(i))])
                tomb[k] = nil
            }
        }
        for k in baseMap.keys where !localIds.contains(k) {
            items[k] = nil
            tomb[k] = .number(now)
        }
        for (k, t) in tomb where now - (t.double ?? 0) > tombDays * 86_400_000 { tomb[k] = nil }
        var list = Array(items.values)
        switch name {
        case "bookmarks": list.sort { ($0["pos"]?.double ?? 0) < ($1["pos"]?.double ?? 0) }
        case "history": list.sort { ($0["v"]?["ts"]?.double ?? 0) > ($1["v"]?["ts"]?.double ?? 0) }
        case "tabs": list.sort { ($0["v"]?["ts"]?.double ?? 0) > ($1["v"]?["ts"]?.double ?? 0) }
        default: break
        }
        list = Array(list.prefix(limit(name)))
        let kept = Set(list.map { id(name, $0["v"] ?? .null) })
        for k in Array(items.keys) where !kept.contains(k) { items[k] = nil }
        return (.object(["items": .object(items), "tomb": .object(tomb)]), list.map { $0["v"] ?? .null })
    }
}

/// Перенос из веб-ВлодБраузера: файл JSON или QR «VBX1:» (порт shared/browser-export.js).
enum BrowserImport {
    struct Result {
        var bookmarks: [(url: String, title: String)] = []
        var history: [(url: String, title: String, ts: Double)] = []
        var home: String?
        var neverSave: [String] = []
    }

    static func parse(_ text: String) -> Result? {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let web = { (u: String) in u.hasPrefix("http://") || u.hasPrefix("https://") }
        if s.hasPrefix("VBX1:") {
            guard let j = JSON.parse(Data(s.dropFirst(5).utf8)) else { return nil }
            var r = Result()
            for x in j["b"]?.array ?? [] {
                if let u = x[0]?.string, web(u) { r.bookmarks.append((u, x[1]?.string ?? "")) }
            }
            return r
        }
        guard let j = JSON.parse(Data(s.utf8)), j["format"]?.string == "vlodbrowser-export" else { return nil }
        let ok = { (u: String) in web(u) || u.hasPrefix("balnet://") }
        var r = Result()
        for b in j["bookmarks"]?.array ?? [] { if let u = b["url"]?.string, ok(u) { r.bookmarks.append((u, b["title"]?.string ?? "")) } }
        for h in j["history"]?.array ?? [] { if let u = h["url"]?.string, ok(u) { r.history.append((u, h["title"]?.string ?? "", h["ts"]?.double ?? 0)) } }
        r.home = j["settings"]?["home"]?.string
        r.neverSave = (j["settings"]?["neverSave"]?.array ?? []).compactMap { $0.string }
        return r
    }
}

extension JSON {
    /// JSON-текст (как JSON.stringify): для шифрования и запросов.
    var jsonText: String { canonical }
}
