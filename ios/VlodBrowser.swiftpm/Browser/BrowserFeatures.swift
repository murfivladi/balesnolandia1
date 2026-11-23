import Foundation
import SwiftUI
import WebKit

/// Сохранённый пароль сайта (как в веб-ВлодБраузере: { origin, username, password, updated }).
struct SavedPassword: Identifiable, Equatable {
    var id: String { "\(origin)|\(username)" }
    var origin: String
    var username: String
    var password: String
    var updated: Double

    var json: JSON {
        .object(["origin": .string(origin), "username": .string(username), "password": .string(password), "updated": .number(updated)])
    }

    init(origin: String, username: String, password: String, updated: Double) {
        self.origin = origin
        self.username = username
        self.password = password
        self.updated = updated
    }

    init?(_ j: JSON) {
        guard let o = j["origin"]?.string, let p = j["password"]?.string else { return nil }
        origin = o
        username = j["username"]?.string ?? ""
        password = p
        updated = j["updated"]?.double ?? 0
    }
}

/// Предложение браузера поверх страницы.
enum BrowserPrompt: Identifiable, Equatable {
    case savePassword(SavedPassword)
    case fillPassword(tabId: String, ticket: String, password: SavedPassword)
    case savePin(number: String, pin: String)

    var id: String {
        switch self {
        case .savePassword(let p): return "save|\(p.id)"
        case .fillPassword(let t, _, let p): return "fill|\(t)|\(p.id)"
        case .savePin(let n, _): return "pin|\(n)"
        }
    }
}

extension Browser {
    static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    // MARK: Пароли (Keychain)

    static func loadPasswords(_ pid: String) -> [SavedPassword] {
        (Keychain.getJSON("pw-\(pid)")?.array ?? []).compactMap(SavedPassword.init)
    }

    func savePasswords() {
        Keychain.setJSON(.array(passwords.map { $0.json }), for: "pw-\(profile.id)")
        sync.syncSoon()
    }

    func storePassword(_ p: SavedPassword) {
        passwords.removeAll { $0.origin == p.origin && $0.username == p.username }
        passwords.insert(p, at: 0)
        savePasswords()
    }

    func deletePassword(_ p: SavedPassword) {
        passwords.removeAll { $0.id == p.id }
        savePasswords()
    }

    /// Сайт прислал введённые логин и пароль — предложить сохранить (как в Chrome).
    func offerPassword(origin: String, username: String, password: String) {
        guard !incognito, !(profile.neverSave ?? []).contains(origin) else { return }
        if passwords.contains(where: { $0.origin == origin && $0.username == username && $0.password == password }) { return }
        prompt = .savePassword(SavedPassword(origin: origin, username: username, password: password, updated: Browser.now()))
    }

    func neverSave(_ origin: String) {
        guard let i = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        var list = profiles[i].neverSave ?? []
        if !list.contains(origin) { list.append(origin) }
        profiles[i].neverSave = list
        saveSettings()
        sync.syncSoon()
    }

    /// На странице форма входа — предложить подставить сохранённый пароль.
    func offerFill(tabId: String, origin: String, ticket: String) {
        guard tabId == activeId, let p = passwords.first(where: { $0.origin == origin }) else { return }
        prompt = .fillPassword(tabId: tabId, ticket: ticket, password: p)
    }

    /// После Face ID — передать логин и пароль shim сайта.
    func fill(tabId: String, ticket: String, _ p: SavedPassword) async {
        guard await OwnerAuth.confirm("Подставить пароль для \(Balnet.display(p.origin))"), let wv = runtimes[tabId]?.webView else { return }
        let msg: JSON = .object(["__balnet": .number(1), "ticket": .string(ticket), "type": .string("fill"), "username": .string(p.username), "password": .string(p.password)])
        wv.evaluateJavaScript("window.postMessage(\(msg.jsonText), '*'); true", in: nil, in: .defaultClient) { _ in }
    }

    // MARK: Синхронизация: данные профиля ↔ коллекции

    func syncRead(_ name: String) -> [JSON] {
        switch name {
        case "bookmarks":
            return bookmarks.map { .object(["url": .string($0.url), "title": .string($0.title)]) }
        case "history":
            return history.prefix(1000).map { .object(["url": .string($0.url), "title": .string($0.title), "ts": .number(($0.ts.timeIntervalSince1970 * 1000).rounded())]) }
        case "passwords":
            return passwords.map { $0.json }
        case "tabs":
            // Метка времени до часа: вкладки не перезаписываются на сервере каждую минуту.
            let ts = (Browser.now() / 3_600_000).rounded(.down) * 3_600_000
            let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
            return normal.tabs.filter { $0.url.hasPrefix("http") }.map {
                .object(["device": .string(profile.clientId), "deviceName": .string("ВлодБраузер · \(device)"), "url": .string($0.url), "title": .string($0.title), "ts": .number(ts)])
            }
        case "settings":
            return [
                .object(["k": .string("neverSave"), "v": .array((profile.neverSave ?? []).map { .string($0) })]),
                .object(["k": .string("home"), "v": .string(profile.home ?? Balnet.newTab)]),
            ]
        default:
            return []
        }
    }

    func syncWrite(_ name: String, _ list: [JSON]) {
        switch name {
        case "bookmarks":
            let old = Dictionary(bookmarks.map { ($0.url, $0.id) }, uniquingKeysWith: { a, _ in a })
            let next = list.compactMap { j -> Bookmark? in
                guard let u = j["url"]?.string else { return nil }
                var b = Bookmark(url: u, title: j["title"]?.string ?? Balnet.display(u))
                if let id = old[u] { b.id = id }
                return b
            }
            if next != bookmarks { bookmarks = next }
        case "history":
            let next = list.compactMap { j -> HistoryItem? in
                guard let u = j["url"]?.string else { return nil }
                return HistoryItem(url: u, title: j["title"]?.string ?? "", ts: Date(timeIntervalSince1970: (j["ts"]?.double ?? 0) / 1000))
            }
            if next.map(\.url) != history.prefix(1000).map(\.url) || next.map(\.ts) != history.prefix(1000).map(\.ts) {
                history = next + history.dropFirst(1000)
            }
        case "passwords":
            let next = list.compactMap(SavedPassword.init)
            if next != passwords {
                passwords = next
                Keychain.setJSON(.array(passwords.map { $0.json }), for: "pw-\(profile.id)")
            }
        case "tabs":
            remoteTabs = list
        case "settings":
            guard let i = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
            for x in list {
                if x["k"]?.string == "neverSave" { profiles[i].neverSave = (x["v"]?.array ?? []).compactMap { $0.string } }
                if x["k"]?.string == "home", let h = x["v"]?.string { profiles[i].home = h }
            }
            saveSettings()
        default:
            break
        }
        Storage.save(history, "\(profile.id)-history")
        Storage.save(bookmarks, "\(profile.id)-bookmarks")
    }

    /// Вкладки других устройств по устройствам (свежие, не старше 30 дней).
    var remoteTabsByDevice: [(name: String, ts: Double, tabs: [JSON])] {
        var map: [String: (name: String, ts: Double, tabs: [JSON])] = [:]
        let now = Browser.now()
        for t in remoteTabs {
            let dev = t["device"]?.string ?? ""
            let ts = t["ts"]?.double ?? 0
            if dev == profile.clientId || now - ts > 30 * 86_400_000 { continue }
            var e = map[dev] ?? (t["deviceName"]?.string ?? "Устройство", 0, [])
            e.tabs.append(t)
            e.ts = max(e.ts, ts)
            map[dev] = e
        }
        return map.values.sorted { $0.ts > $1.ts }
    }

    // MARK: Импорт из веб-ВлодБраузера

    /// Добавить закладки (без повторов), историю и настройки. Возвращает число новых закладок.
    @discardableResult
    func importData(_ r: BrowserImport.Result) -> Int {
        var added = 0
        for b in r.bookmarks where !bookmarks.contains(where: { $0.url == b.url }) {
            bookmarks.append(Bookmark(url: b.url, title: b.title.isEmpty ? Balnet.display(b.url) : b.title))
            added += 1
        }
        let known = Set(history.map { "\($0.url)|\(Int($0.ts.timeIntervalSince1970))" })
        for h in r.history where !known.contains("\(h.url)|\(Int(h.ts / 1000))") {
            history.append(HistoryItem(url: h.url, title: h.title, ts: Date(timeIntervalSince1970: h.ts / 1000)))
        }
        history.sort { $0.ts > $1.ts }
        if let i = profiles.firstIndex(where: { $0.id == profile.id }) {
            if let home = r.home { profiles[i].home = home }
            profiles[i].neverSave = Array(Set((profiles[i].neverSave ?? []) + r.neverSave))
            saveSettings()
        }
        scheduleSave()
        return added
    }

    // MARK: ВлодБанк и Face ID

    /// Вкладка показывает ВлодБанк (bank.bln или pay.bank.bln).
    func isBank(_ t: Tab?) -> Bool {
        guard let t, let host = Balnet.split(t.url)?.host else { return false }
        return host == "bank.bln" || host == "pay.bank.bln"
    }

    var bankLockEnabled: Bool { profile.bankLock ?? true }

    func setBankLock(_ on: Bool) {
        guard let i = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        profiles[i].bankLock = on
        saveSettings()
    }

    func unlockBank() async {
        if await OwnerAuth.confirm("Вход во ВлодБанк") { bankUnlocked = true }
    }

    /// Запрос госсайта через window.__balnetNative (Face ID, PIN карты). Отвечает только ВлодБанку.
    func nativeRequest(tabId: String, _ body: JSON) async -> JSON {
        guard let rt = runtimes[tabId], ["bank", "pay"].contains(rt.govApp ?? "") else { return .null }
        let number = (body["number"]?.string ?? "").filter(\.isNumber)
        switch body["op"]?.string ?? "" {
        case "confirm":
            return .bool(await OwnerAuth.confirm(String((body["reason"]?.string ?? "Подтвердите операцию").prefix(120))))
        case "hasPin":
            return .bool(!number.isEmpty && savedPins.contains(number))
        case "pin":
            guard savedPins.contains(number), let d = await Keychain.getProtected("pin-\(number)", reason: "PIN карты •••• \(number.suffix(4))") else { return .null }
            return .string(String(decoding: d, as: UTF8.self))
        case "offerPin":
            let pin = (body["pin"]?.string ?? "").filter(\.isNumber)
            if !incognito, number.count >= 12, pin.count == 3, !savedPins.contains(number) { prompt = .savePin(number: number, pin: pin) }
            return .null
        default:
            return .null
        }
    }

    var savedPins: [String] { UserDefaults.standard.stringArray(forKey: "savedPins") ?? [] }

    func savePin(number: String, pin: String) {
        guard Keychain.setProtected(Data(pin.utf8), for: "pin-\(number)") else { return }
        UserDefaults.standard.set(Array(Set(savedPins + [number])), forKey: "savedPins")
    }

    func forgetPins() {
        for n in savedPins { Keychain.delete("pin-\(n)") }
        UserDefaults.standard.removeObject(forKey: "savedPins")
    }
}
