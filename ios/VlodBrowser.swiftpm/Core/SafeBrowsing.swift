import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Безопасный просмотр ВлодПоиска (порт shared/balnet-safe.js и web/src/browser/safe.jsx):
/// локальный список 4-байтовых префиксов SHA-256; при совпадении — запрос полных хешей. Сам адрес на сервер не уходит.
enum SafeBrowsing {
    struct Verdict: Equatable {
        let threat: String
        let expr: String
    }

    static let threats: [String: (title: String, text: String)] = [
        "phishing": ("Обманный сайт", "Злоумышленники на этом сайте могут обманом вынудить вас ввести пароль, номер карты или другие личные данные."),
        "malware": ("Сайт содержит вредоносное ПО", "Этот сайт может попытаться установить на устройство опасные программы, которые крадут или удаляют данные."),
        "unwanted": ("Сайт с нежелательным ПО", "Сайт может обманом заставить вас установить программы, которые мешают работе браузера."),
    ]

    /// Канонический вид: хост без точек по краям, путь без «.» и «..», без пустых сегментов (кроме последнего).
    static func canonicalize(_ url: String) -> (host: String, path: String, query: String)? {
        guard let p = Balnet.split(url), p.scheme == "http" || p.scheme == "https" else { return nil }
        var host = p.host
        if let colon = host.lastIndex(of: ":"), host[host.index(after: colon)...].allSatisfy(\.isNumber) { host = String(host[..<colon]) }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !host.isEmpty else { return nil }
        let noHash = p.path.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? p.path
        let qParts = noHash.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let pathname = qParts[0].isEmpty ? "/" : qParts[0]
        let query = qParts.count > 1 ? qParts[1] : ""
        var parts: [String] = []
        for seg in pathname.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init) {
            if seg == "." { continue }
            if seg == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(seg)
        }
        let kept = parts.enumerated().filter { $0.element != "" || $0.offset == parts.count - 1 }.map(\.element)
        var path = "/" + kept.joined(separator: "/")
        while path.contains("//") { path = path.replacingOccurrences(of: "//", with: "/") }
        return (host, path, query)
    }

    /// Выражения для проверки: до 5 хостов × до 6 путей.
    static func expressions(_ url: String) -> [String] {
        guard let c = canonicalize(url) else { return [] }
        var hosts = [c.host]
        if !Balnet.isIP(c.host) {
            let tail = Array(c.host.split(separator: ".").map(String.init).suffix(5))
            var i = 1
            while i < tail.count - 1 && hosts.count < 5 {
                let h = tail[i...].joined(separator: ".")
                if !hosts.contains(h) { hosts.append(h) }
                i += 1
            }
        }
        var paths: [String] = []
        if !c.query.isEmpty { paths.append("\(c.path)?\(c.query)") }
        paths.append(c.path)
        if c.path != "/" { paths.append("/") }
        let segs = c.path.split(separator: "/").map(String.init)
        var i = 1
        while i < segs.count && paths.count < 6 {
            let p = "/" + segs[0..<i].joined(separator: "/") + "/"
            if !paths.contains(p) { paths.append(p) }
            i += 1
        }
        var out: [String] = []
        for h in hosts { for p in paths where !out.contains(h + p) { out.append(h + p) } }
        return out
    }

    static func hashes(_ url: String) -> [(expr: String, hash: String, prefix: String)] {
        expressions(url).map { e in
            let h = SHA256.hash(data: Data(e.utf8)).map { String(format: "%02x", $0) }.joined()
            return (e, h, String(h.prefix(8)))
        }
    }

    // MARK: Список префиксов и проверка

    private static var prefixes: (set: Set<String>, at: Date)?
    private static var full: [String: (at: Date, matches: [JSON])] = [:]
    /// «Всё равно перейти» — до закрытия приложения, как в Chrome.
    static var bypass: Set<String> = []

    /// nil — адрес безопасен (или список недоступен).
    static func check(_ url: String) async -> Verdict? {
        if prefixes == nil || Date().timeIntervalSince(prefixes!.at) > 300 {
            guard let r = try? await API.get("/search/sb/prefixes") else { return nil }
            prefixes = (Set((r["prefixes"]?.array ?? []).compactMap { $0.string }), Date())
        }
        guard let set = prefixes?.set, !set.isEmpty else { return nil }
        let hit = hashes(url).filter { set.contains($0.prefix) }
        if hit.isEmpty { return nil }
        let want = Array(Set(hit.map(\.prefix))).filter { p in !(full[p].map { Date().timeIntervalSince($0.at) < 300 } ?? false) }
        if !want.isEmpty {
            guard let r = try? await API.post("/search/sb/find", ["prefixes": want]) else { return nil }
            let matches = r["matches"]?.array ?? []
            for p in want { full[p] = (Date(), matches.filter { ($0["hash"]?.string ?? "").hasPrefix(p) }) }
        }
        for h in hit {
            if let m = full[h.prefix]?.matches.first(where: { $0["hash"]?.string == h.hash }) {
                return Verdict(threat: m["threat"]?.string ?? "phishing", expr: h.expr)
            }
        }
        return nil
    }

    static func report(_ url: String) async {
        _ = try? await API.post("/search/sb/report", ["url": url, "threat": "phishing", "comment": "ВлодБраузер для iOS"])
    }
}
