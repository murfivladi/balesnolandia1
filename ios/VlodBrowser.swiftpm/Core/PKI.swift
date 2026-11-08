import Foundation
import CryptoKit

/// Итог проверки сертификата (как verifyTls + checkTls во ВлодБраузере).
struct CertVerdict: Equatable {
    var ok: Bool
    var code: String?
    var leaf: JSON?
    var issuer: String?
    var ev = false
    var org: String?
    var ctIndex: Int?
    var ocsp: String?
    var hash: String?
    var time: Double = 0

    var san: [String] { leaf?["san"]?.array.compactMap { $0.string } ?? [] }
    var policy: String { leaf?["policy"]?.string ?? "" }
}

/// PKI БалНета на настоящей криптографии: ECDSA P-256 + SHA-256, подпись r||s канонического JSON.
/// Порт verifyTls из shared/balnet-pki.js.
enum PKI {
    static let errors: [String: String] = [
        "ERR_CERT_COMMON_NAME_INVALID": "Сертификат выдан для другого сайта",
        "ERR_CERT_DATE_INVALID": "Срок действия сертификата истёк или ещё не начался",
        "ERR_CERT_AUTHORITY_INVALID": "Сертификат выдан не доверенным центром сертификации",
        "ERR_CERT_REVOKED": "Сертификат отозван",
        "ERR_CERT_INVALID": "Подпись сертификата неверна",
        "ERR_CERTIFICATE_TRANSPARENCY_REQUIRED": "Сертификат не записан в журнал прозрачности",
    ]

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func keyId(_ spki: String) -> String {
        guard let d = Data(base64Encoded: spki) else { return "" }
        return String(sha256Hex(d).prefix(16))
    }

    static func certHash(_ cert: JSON) -> String {
        sha256Hex(Data((cert["tbs"] ?? .null).canonical.utf8))
    }

    static func verifySig(spki: String?, data: JSON, sig: String?) -> Bool {
        guard let spki, let sig,
              let der = Data(base64Encoded: spki), let raw = Data(base64Encoded: sig),
              let key = try? P256.Signing.PublicKey(derRepresentation: der),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(signature, for: Data(data.canonical.utf8))
    }

    /// Имя сайта подходит под имя из сертификата (точно или «*.» на один уровень).
    static func nameMatches(_ pattern: String, _ host: String) -> Bool {
        let p = pattern.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if p == h { return true }
        if p.hasPrefix("*.") {
            let rest = String(p.dropFirst(2))
            guard let dot = h.firstIndex(of: "."), dot > h.startIndex else { return false }
            return String(h[h.index(after: dot)...]) == rest
        }
        return false
    }

    /// Проверка соединения как в Chrome. tls = { chain, sct?, ocsp?, time }, trust = { roots, ct_logs, revoked_cas }.
    static func verify(tls: JSON, host: String, trust: JSON) -> CertVerdict {
        let now = tls["time"]?.double ?? 0
        let chain = tls["chain"]?.array ?? []
        guard let leaf = chain.first, let t = leaf["tbs"], !t.isNull else {
            return CertVerdict(ok: false, code: "ERR_CERT_INVALID", time: now)
        }
        let policy = t["policy"]?.string ?? ""
        var info = CertVerdict(ok: false, leaf: t, ev: policy == "EV", org: (policy == "OV" || policy == "EV") ? t["subject"]?["o"]?.string : nil, time: now)
        info.hash = certHash(leaf)
        func fail(_ code: String) -> CertVerdict { var v = info; v.ok = false; v.code = code; return v }

        let san = t["san"]?.array.compactMap { $0.string } ?? []
        if !san.contains(where: { nameMatches($0, host) }) { return fail("ERR_CERT_COMMON_NAME_INVALID") }
        if policy == "self" || t["aki"]?.string == t["ski"]?.string {
            let selfOk = verifySig(spki: t["spki"]?.string, data: t, sig: leaf["sig"]?.string)
            return fail(selfOk ? "ERR_CERT_AUTHORITY_INVALID" : "ERR_CERT_INVALID")
        }

        // Цепочка: каждый подписан следующим; последний — корнем из хранилища доверия.
        var roots: [String: JSON] = [:]
        for r in trust["roots"]?.array ?? [] {
            if let spki = r["spki"]?.string { roots[keyId(spki)] = r }
        }
        let revoked = Set((trust["revoked_cas"]?.array ?? []).compactMap { $0.string })
        var curIndex = 0
        for i in 0..<6 {
            let cur = chain[curIndex]
            guard let c = cur["tbs"] else { return fail("ERR_CERT_INVALID") }
            if i > 0, let ski = c["ski"]?.string, revoked.contains(ski) { return fail("ERR_CERT_REVOKED") }
            let nb = c["nb"]?.double ?? 0
            let na = c["na"]?.double ?? 0
            if now < nb || now > na { return fail("ERR_CERT_DATE_INVALID") }
            let aki = c["aki"]?.string
            if let nextIndex = chain.indices.first(where: { $0 != curIndex && chain[$0]["tbs"]?["ski"]?.string == aki && aki != nil }) {
                let next = chain[nextIndex]
                guard let nt = next["tbs"] else { return fail("ERR_CERT_INVALID") }
                if !(nt["ca"]?.bool ?? false) { return fail("ERR_CERT_INVALID") }
                if !verifySig(spki: nt["spki"]?.string, data: c, sig: cur["sig"]?.string) { return fail("ERR_CERT_INVALID") }
                if let nski = nt["ski"]?.string, let root = roots[nski] {
                    if root["spki"]?.string != nt["spki"]?.string { return fail("ERR_CERT_AUTHORITY_INVALID") }
                    let rnb = nt["nb"]?.double ?? 0
                    let rna = nt["na"]?.double ?? 0
                    if now < rnb || now > rna { return fail("ERR_CERT_DATE_INVALID") }
                    info.issuer = chain[safe: 1]?["tbs"]?["subject"]?["cn"]?.string ?? nt["subject"]?["cn"]?.string
                    break
                }
                curIndex = nextIndex
                continue
            }
            // Издатель — корень, которого нет в присланной цепочке, но он есть в хранилище.
            guard let aki, let root = roots[aki] else { return fail("ERR_CERT_AUTHORITY_INVALID") }
            if !verifySig(spki: root["spki"]?.string, data: c, sig: cur["sig"]?.string) { return fail("ERR_CERT_INVALID") }
            info.issuer = chain[safe: 1]?["tbs"]?["subject"]?["cn"]?.string ?? root["name"]?.string
            break
        }
        if info.issuer == nil { return fail("ERR_CERT_AUTHORITY_INVALID") }

        // Журнал прозрачности: подписанная отметка (SCT) от известного журнала.
        let sct = tls["sct"] ?? .null
        let logId = sct["log_id"]?.string
        let log = (trust["ct_logs"]?.array ?? []).first { $0["log_id"]?.string == logId && logId != nil }
        let sctData: JSON = .object([
            "log_id": sct["log_id"] ?? .null,
            "index": sct["index"] ?? .null,
            "ts": sct["ts"] ?? .null,
            "cert_hash": sct["cert_hash"] ?? .null,
        ])
        if log == nil || sct["cert_hash"]?.string != info.hash || !verifySig(spki: log?["spki"]?.string, data: sctData, sig: sct["sig"]?.string) {
            return fail("ERR_CERTIFICATE_TRANSPARENCY_REQUIRED")
        }
        info.ctIndex = sct["index"]?.int

        // Статус отзыва, «скреплённый» сервером и подписанный издателем. Нет ответа — мягкий отказ, как в Chrome.
        let o = tls["ocsp"] ?? .null
        let aki = t["aki"]?.string
        let issuerSpki = chain.first(where: { $0["tbs"]?["ski"]?.string == aki && aki != nil })?["tbs"]?["spki"]?.string
            ?? aki.flatMap { roots[$0]?["spki"]?.string }
        if !o.isNull, let issuerSpki, o["serial"] == t["serial"] {
            let reason: JSON = {
                if let r = o["reason"], !r.isNull, r.bool { return r }
                return .null
            }()
            let ocspData: JSON = .object([
                "serial": o["serial"] ?? .null,
                "status": o["status"] ?? .null,
                "reason": reason,
                "this_update": o["this_update"] ?? .null,
            ])
            if verifySig(spki: issuerSpki, data: ocspData, sig: o["sig"]?.string) {
                info.ocsp = o["status"]?.string
                if info.ocsp == "revoked" { return fail("ERR_CERT_REVOKED") }
            }
        }
        info.ok = true
        info.code = nil
        return info
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { i >= 0 && i < count ? self[i] : nil }
}
