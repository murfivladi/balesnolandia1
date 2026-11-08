import Foundation

/// Госсайт: приложение проекта, открытое под доменом БалНета (как GOV_SITES в shared/balnet-url.js).
struct GovSite {
    let app: String
    let title: String
    let owner: String
}

/// Куда ведёт адрес (resolveTarget).
enum Target: Equatable {
    case `internal`(page: String, path: String)
    case web(scheme: String, host: String, path: String)
    case upgrade(url: String)
    case error(code: String)
}

/// Адреса БалНета: разбор адресной строки, госсайты, коды ошибок. Порт shared/balnet-url.js.
enum Balnet {
    static let searchHost = "poisk.bln"
    static let newTab = "balnet://newtab/"
    static let publicDNS = "50.0.0.53"

    static let internalPages: [String: String] = [
        "newtab": "Новая вкладка",
        "history": "История",
        "bookmarks": "Закладки",
        "settings": "Настройки",
        "about": "О ВлодБраузере",
        "terminal": "Терминал",
    ]

    static let govSites: [String: GovSite] = [
        "bank.bln": GovSite(app: "bank", title: "ВлодБанк", owner: "ВлодБанк (госбанк БФ)"),
        "gosuslugi.gov.bln": GovSite(app: "services", title: "ВлодУслуги", owner: "Правительство БФ"),
        "kassa.bln": GovSite(app: "pos", title: "Касса", owner: "Министерство торговли БФ"),
        "reg.bln": GovSite(app: "reg", title: "БалРег", owner: "Координационный центр БалНета"),
        "hosting.bln": GovSite(app: "hosting", title: "БалХост", owner: "Координационный центр БалНета"),
        "nalog.gov.bln": GovSite(app: "nalog", title: "Налоговая служба БФ", owner: "Правительство БФ"),
        "ca.gov.bln": GovSite(app: "ca", title: "БалСерт", owner: "Координационный центр БалНета"),
        "poisk.bln": GovSite(app: "poisk", title: "ВлодПоиск", owner: "Правительство БФ"),
        "vlodhub.bln": GovSite(app: "hub", title: "ВлодХаб", owner: "Координационный центр БалНета"),
        "mail.bln": GovSite(app: "mail", title: "ВлодПочта", owner: "Координационный центр БалНета"),
        "pay.bank.bln": GovSite(app: "pay", title: "ВлодБанк Оплата", owner: "ВлодБанк (госбанк БФ)"),
        "push.bln": GovSite(app: "push", title: "БалПуш", owner: "Координационный центр БалНета"),
        "novosti.bln": GovSite(app: "news", title: "БалНовости", owner: "Правительство БФ"),
    ]

    /// Порядок плиток на новой вкладке.
    static let govOrder = ["bank.bln", "gosuslugi.gov.bln", "kassa.bln", "poisk.bln", "novosti.bln", "mail.bln", "reg.bln", "hosting.bln", "vlodhub.bln", "nalog.gov.bln", "ca.gov.bln"]

    /// Хосты из списка HSTS preload: только https.
    static var hstsPreload: Set<String> { Set(govSites.keys).union([searchHost]) }

    private static let schemeRe = try! NSRegularExpression(pattern: "^([a-z][a-z0-9+.-]*)://", options: [.caseInsensitive])
    private static let hostRe = try! NSRegularExpression(pattern: "^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,62}$", options: [.caseInsensitive])
    private static let ipv4Re = try! NSRegularExpression(pattern: "^(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}$")
    private static let portRe = try! NSRegularExpression(pattern: ":\\d+$")

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// Схема адреса в нижнем регистре и длина префикса «схема://».
    private static func scheme(of s: String) -> (String, Int)? {
        guard let m = schemeRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let r = Range(m.range(at: 1), in: s), let all = Range(m.range, in: s) else { return nil }
        return (String(s[r]).lowercased(), s.distance(from: s.startIndex, to: all.upperBound))
    }

    static func searchURL(_ query: String) -> String {
        "https://\(searchHost)/?q=\(encodeComponent(query))"
    }

    /// Как encodeURIComponent.
    static func encodeComponent(_ s: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    static func isHostLike(_ host: String) -> Bool {
        let h = portRe.stringByReplacingMatches(in: host, range: NSRange(host.startIndex..., in: host), withTemplate: "")
        return matches(hostRe, h) || matches(ipv4Re, h)
    }

    static func isIP(_ s: String) -> Bool { matches(ipv4Re, s) || (s.contains(":") && s.allSatisfy { $0.isHexDigit || $0 == ":" }) }

    /// Разбор текста из адресной строки, как в Chrome.
    static func parseInput(_ text: String) -> String? {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if scheme(of: s) != nil { return normalize(s) ?? searchURL(s) }
        if s.contains(where: { $0.isWhitespace }) { return searchURL(s) }
        let host = s.split(whereSeparator: { "/?#".contains($0) }).first.map(String.init) ?? s
        if isHostLike(host) { return normalize("https://" + s) ?? searchURL(s) }
        return searchURL(s)
    }

    /// Процентное кодирование не-ASCII и пробелов в пути (как делает new URL()).
    private static func encodePath(_ s: String) -> String {
        var out = ""
        for u in s.unicodeScalars {
            if u.isASCII && u.value > 0x20 && u != "\"" && u != "<" && u != ">" && u != "`" {
                out.unicodeScalars.append(u)
            } else {
                for b in String(u).utf8 { out += String(format: "%%%02X", b) }
            }
        }
        return out
    }

    /// Нормализация: схема и хост в нижнем регистре, пустой путь → «/». nil — адрес не разбирается.
    static func normalize(_ url: String) -> String? {
        guard let sc = scheme(of: url) else { return nil }
        let sch = sc.0
        let rest = String(url.dropFirst(sc.1))
        if sch == "balnet" {
            let parts = rest.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
            let page = (parts.first.map(String.init) ?? "").lowercased()
            if page.isEmpty { return nil }
            return "balnet://\(page)/\(parts.count > 1 ? String(parts[1]) : "")"
        }
        guard sch == "http" || sch == "https" else { return nil }
        let cut = rest.firstIndex(where: { "/?#".contains($0) }) ?? rest.endIndex
        var host = String(rest[..<cut])
        if let at = host.lastIndex(of: "@") { host = String(host[host.index(after: at)...]) }
        host = host.lowercased()
        if host.hasSuffix(":443") && sch == "https" { host = String(host.dropLast(4)) }
        if host.hasSuffix(":80") && sch == "http" { host = String(host.dropLast(3)) }
        guard !host.isEmpty, isHostLike(host) else { return nil }
        var tail = String(rest[cut...])
        if !tail.hasPrefix("/") { tail = "/" + tail }
        return "\(sch)://\(host)\(encodePath(tail))"
    }

    struct Parts { let scheme: String; let host: String; let path: String }

    static func split(_ url: String) -> Parts? {
        guard let sc = scheme(of: url) else { return nil }
        let sch = sc.0
        let rest = String(url.dropFirst(sc.1))
        let cut = rest.firstIndex(where: { "/?#".contains($0) }) ?? rest.endIndex
        let host = String(rest[..<cut]).lowercased()
        var path = cut == rest.endIndex ? "/" : String(rest[cut...])
        if !path.hasPrefix("/") { path = "/" + path }
        return Parts(scheme: sch, host: host, path: path)
    }

    static func resolve(_ url: String) -> Target {
        guard let p = split(url) else { return .error(code: "ERR_INVALID_URL") }
        if p.scheme == "balnet" {
            guard internalPages[p.host] != nil else { return .error(code: "ERR_INVALID_URL") }
            return .internal(page: p.host, path: p.path)
        }
        guard p.scheme == "https" || p.scheme == "http" else { return .error(code: "ERR_INVALID_URL") }
        if p.scheme == "http" && hstsPreload.contains(p.host) { return .upgrade(url: "https://\(p.host)\(p.path)") }
        return .web(scheme: p.scheme, host: p.host, path: p.path)
    }

    /// «bank», «/cards?x=1» → https://bln.vladislavb.qzz.io/bank/#/cards?x=1
    static func govAppURL(app: String, path: String) -> URL? {
        var route = path.components(separatedBy: "#").first ?? "/"
        if route.isEmpty { route = "/" }
        if !route.hasPrefix("/") { route = "/" + route }
        return URL(string: "\(Config.site)/\(app)/#\(encodePath(route))")
    }

    /// Обратно: приложение и его hash → адрес БалНета.
    static func govURL(app: String, hash: String) -> String? {
        guard let host = govSites.first(where: { $0.value.app == app })?.key else { return nil }
        var route = hash.hasPrefix("#") ? String(hash.dropFirst()) : hash
        if route.isEmpty { route = "/" }
        if !route.hasPrefix("/") { route = "/" + route }
        return "https://\(host)\(route)"
    }

    /// Адрес госсайта в WebView → адрес БалНета (как frameUrl во ВлодБраузере).
    static func balnetURL(fromGov url: URL, app: String, host: String) -> String? {
        guard url.host == Config.siteHost else { return nil }
        let rel = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let frameApp = rel.split(separator: "/").first.map(String.init) ?? ""
        let hash = url.fragment ?? ""
        if frameApp == app {
            var route = hash.isEmpty ? "/" : hash
            if !route.hasPrefix("/") { route = "/" + route }
            return "https://\(host)\(route)"
        }
        return govURL(app: frameApp, hash: hash)
    }

    /// Как Chrome показывает адрес без фокуса: без https:// и «/» в конце пустого пути.
    static func display(_ url: String) -> String {
        if url.isEmpty || url == newTab { return "" }
        guard let p = split(url) else { return url }
        if p.scheme == "balnet" { return url.hasSuffix("/") ? String(url.dropLast()) : url }
        let path = decodeURI(p.path)
        let shown = path == "/" ? p.host : p.host + path
        return p.scheme == "https" ? shown : "http://" + shown
    }

    /// Как decodeURI: %XX раскодируются, кроме зарезервированных символов (;/?:@&=+$,#).
    static func decodeURI(_ s: String) -> String {
        let reserved = Set("%3B%2F%3F%3A%40%26%3D%2B%24%2C%23".lowercased().components(separatedBy: "%").filter { !$0.isEmpty })
        var bytes: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == "%", let j = s.index(i, offsetBy: 3, limitedBy: s.endIndex), let b = UInt8(s[s.index(after: i)..<j], radix: 16),
               !reserved.contains(String(s[s.index(after: i)..<j]).lowercased()) {
                bytes.append(b)
                i = j
            } else {
                bytes.append(contentsOf: Array(String(s[i]).utf8))
                i = s.index(after: i)
            }
        }
        return String(bytes: bytes, encoding: .utf8) ?? s
    }

    static func searchQuery(_ path: String) -> String {
        guard let q = path.split(separator: "?", maxSplits: 1).dropFirst().first else { return "" }
        let query = q.split(separator: "#").first.map(String.init) ?? ""
        var c = URLComponents()
        c.percentEncodedQuery = query.replacingOccurrences(of: "+", with: "%20")
        return c.queryItems?.first(where: { $0.name == "q" })?.value ?? ""
    }

    /// Заголовок вкладки до загрузки страницы.
    static func title(for url: String) -> String {
        switch resolve(url) {
        case .internal(let page, _): return internalPages[page] ?? page
        case .web(_, let host, let path):
            if host == searchHost {
                let q = searchQuery(path)
                return q.isEmpty ? "ВлодПоиск" : "\(q) — ВлодПоиск"
            }
            if let g = govSites[host] { return g.title }
            return display(url)
        default: return display(url)
        }
    }

    /// Обратный адрес для PTR: 1.2.3.4 → 4.3.2.1.in-addr.arpa
    static func reverseName(_ ip: String) -> String {
        ip.split(separator: ".").reversed().joined(separator: ".") + ".in-addr.arpa"
    }
}

/// Тексты страниц ошибок (NET_ERRORS).
struct NetErrorText {
    let title: String
    let text: (String) -> String
    let tips: [String]

    static func of(_ code: String) -> NetErrorText {
        all[code] ?? NetErrorText(title: "Не удалось открыть страницу", text: { _ in "Ошибка \(code)." }, tips: ["Попробуйте позже."])
    }

    static let all: [String: NetErrorText] = [
        "DNS_PROBE_FINISHED_NXDOMAIN": NetErrorText(
            title: "Не удаётся найти сайт",
            text: { "Не удалось найти IP-адрес сервера \($0). Такого домена нет в БалНете, или его срок регистрации истёк." },
            tips: ["Проверьте, нет ли опечатки в адресе.", "Поищите сайт во ВлодПоиске.", "Проверьте настройки DNS у провайдера."]),
        "ERR_INTERNET_DISCONNECTED": NetErrorText(
            title: "Нет подключения к интернету",
            text: { _ in "Устройство не подключено к сети, поэтому БалНет недоступен." },
            tips: ["Проверьте Wi-Fi или мобильную сеть."]),
        "ERR_INVALID_URL": NetErrorText(
            title: "Неверный адрес", text: { _ in "Этот адрес нельзя открыть." }, tips: ["Проверьте адрес."]),
        "ERR_CONNECTION_REFUSED": NetErrorText(
            title: "Сайт не позволяет установить соединение",
            text: { "Сервер \($0) отклонил подключение: по этому адресу работает не веб-сервер." },
            tips: ["Проверьте A-запись домена.", "Попробуйте позже."]),
        "ERR_NAME_NOT_RESOLVED": NetErrorText(
            title: "Не удаётся найти сайт",
            text: { "Домен \($0) существует, но у него нет IP-адреса (записей A и AAAA)." },
            tips: ["Владельцу сайта: добавьте A-запись."]),
        "DNS_PROBE_FINISHED_BAD_CONFIG": NetErrorText(
            title: "DNS-сервер не отвечает",
            text: { _ in "DNS-сервер, указанный в настройках, не ответил. Возможно, по этому адресу нет резолвера." },
            tips: ["Проверьте DNS-сервер в настройках ВлодБраузера.", "Выберите «DNS провайдера» или ВлодDNS 50.0.0.53."]),
        "ERR_NAME_RESOLUTION_FAILED": NetErrorText(
            title: "Ошибка DNS",
            text: { "DNS-сервер не смог найти адрес \($0): он отказал в запросе или серверы домена не отвечают." },
            tips: ["Резолвер провайдера обслуживает только своих абонентов — проверьте настройки DNS.", "Посмотрите путь запроса в DevTools → Network."]),
        "ERR_CONNECTION_TIMED_OUT": NetErrorText(
            title: "Превышено время ожидания",
            text: { "Сервер \($0) слишком долго не отвечает: по этому IP-адресу никого нет или сервер выключен." },
            tips: ["Попробуйте позже.", "Проверьте связь командой ping в терминале."]),
        "ERR_ADDRESS_UNREACHABLE": NetErrorText(
            title: "Сайт недоступен",
            text: { "До адреса сервера \($0) нет маршрута: такой сети в БалНете нет." },
            tips: ["Проверьте A-запись домена.", "Посмотрите маршрут командой traceroute."]),
        "HTTP_404_NO_VHOST": NetErrorText(
            title: "404 — сайт не найден на сервере",
            text: { "Сервер ответил, но сайта \($0) на нём нет: хостинг не настроен для этого имени." },
            tips: ["Владельцу сайта: проверьте настройки хостинга."]),
        "ERR_BALNET_UNREACHABLE": NetErrorText(
            title: "Нет связи с БалНетом",
            text: { _ in "Сервер БалНета не отвечает. Возможно, он перезапускается." },
            tips: ["Проверьте подключение к интернету.", "Попробуйте через минуту."]),
    ]
}
