import Foundation
import Combine
import SwiftUI
import WebKit

/// ВлодБраузер: профили, вкладки, переходы и сеть БалНета. Логика — как в web/src/browser/App.jsx.
@MainActor
final class Browser: ObservableObject {
    static let historyLimit = 2000
    static let maxBack = 50

    @Published var settings: AppSettings
    @Published var profiles: [Profile]
    @Published var incognito = false
    @Published private(set) var normal: Session
    @Published private(set) var incognitoSession: Session
    @Published var history: [HistoryItem]
    @Published var bookmarks: [Bookmark]
    /// cookies и localStorage сайтов игроков по origin: { cookies, local }.
    private var jars: [String: JSON]
    private var incognitoJars: [String: JSON] = [:]
    /// У инкогнито — своё временное устройство и IP.
    private var incognitoClientId = NetClient.newClientId()
    @Published var runtimes: [String: TabRuntime] = [:]
    let dialogs = Dialogs()

    // И2: аккаунт и синхронизация, пароли, загрузки, Face ID
    let sync = SyncManager()
    let downloads = Downloads()
    /// Пароли сайтов профиля (Keychain). Показ и подстановка — после Face ID.
    @Published var passwords: [SavedPassword] = []
    /// Открытые вкладки других устройств (из синхронизации).
    @Published var remoteTabs: [JSON] = []
    /// Предложения браузера поверх страницы: сохранить пароль, подставить пароль, сохранить PIN карты.
    @Published var prompt: BrowserPrompt?
    /// ВлодБанк разблокирован Face ID до ухода приложения в фон.
    @Published var bankUnlocked = false

    // Строка состояния
    @Published var lease: Lease?
    @Published var clockMonth: Int?
    @Published var paused = false
    @Published var latency: Int?
    @Published var online = true
    @Published var update: (version: String, url: String)?

    /// Исключения «Перейти на сайт (небезопасно)» — до закрытия приложения, как в Chrome.
    private var certBypass: Set<String> = []
    private lazy var siteStore = WKWebsiteDataStore.nonPersistent()
    private var saveTask: Task<Void, Never>?

    init() {
        var s = Storage.load(AppSettings.self, "settings") ?? AppSettings()
        var list = Storage.load([Profile].self, "profiles") ?? []
        if list.isEmpty {
            list = [Profile(id: "p1", name: "Профиль 1", color: Storage.profileColors[0], clientId: NetClient.newClientId())]
            Storage.save(list, "profiles")
        }
        if !list.contains(where: { $0.id == s.activeProfile }) { s.activeProfile = list[0].id }
        let pid = s.activeProfile
        var sess = (s.restoreSession ? Storage.load(Session.self, "\(pid)-session") : nil) ?? Session()
        if sess.tabs.isEmpty { sess = Session() }
        if sess.activeId == nil || !sess.tabs.contains(where: { $0.id == sess.activeId }) { sess.activeId = sess.tabs.last?.id }
        var rts: [String: TabRuntime] = [:]
        for t in sess.tabs { rts[t.id] = TabRuntime(id: t.id) }
        let incog = Session()
        for t in incog.tabs { rts[t.id] = TabRuntime(id: t.id) }
        settings = s
        profiles = list
        normal = sess
        incognitoSession = incog
        history = Storage.load([HistoryItem].self, "\(pid)-history") ?? []
        bookmarks = Storage.load([Bookmark].self, "\(pid)-bookmarks") ?? []
        jars = Storage.load([String: JSON].self, "\(pid)-jars") ?? [:]
        runtimes = rts
        passwords = Browser.loadPasswords(pid)
        sync.browser = self
        sync.load(profileId: pid)
        downloads.load()
    }

    // MARK: Профиль и сессия

    var profile: Profile { profiles.first { $0.id == settings.activeProfile } ?? profiles[0] }

    var clientId: String { incognito ? incognitoClientId : profile.clientId }

    var session: Session {
        get { incognito ? incognitoSession : normal }
        set {
            if incognito { incognitoSession = newValue } else { normal = newValue; scheduleSave() }
        }
    }

    var tabs: [Tab] { session.tabs }
    var activeId: String? { session.activeId }
    var activeTab: Tab? { tabs.first { $0.id == activeId } ?? tabs.last }
    func tab(_ id: String) -> Tab? { tabs.first { $0.id == id } ?? (incognito ? normal : incognitoSession).tabs.first { $0.id == id } }

    func runtime(_ id: String) -> TabRuntime {
        if let rt = runtimes[id] { return rt }
        let rt = TabRuntime(id: id)
        runtimes[id] = rt
        return rt
    }

    var themeName: String {
        switch settings.theme {
        case .light: return "light"
        case .dark: return "dark"
        case .system: return UITraitCollection.current.userInterfaceStyle == .dark ? "dark" : "light"
        }
    }

    private func mutateTab(_ id: String, _ f: (inout Tab) -> Void) {
        var s = session
        guard let i = s.tabs.firstIndex(where: { $0.id == id }) else { return }
        f(&s.tabs[i])
        session = s
    }

    func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard let self, !Task.isCancelled else { return }
            self.saveNow()
            self.sync.syncSoon()
        }
    }

    func saveNow() {
        let pid = profile.id
        Storage.save(settings, "settings")
        Storage.save(profiles, "profiles")
        Storage.save(normal, "\(pid)-session")
        Storage.save(history, "\(pid)-history")
        Storage.save(bookmarks, "\(pid)-bookmarks")
        Storage.save(jars, "\(pid)-jars")
    }

    func saveSettings() {
        Storage.save(settings, "settings")
        Storage.save(profiles, "profiles")
    }

    func switchProfile(_ id: String) {
        guard id != profile.id || incognito else { return }
        saveNow()
        for rt in runtimes.values { rt.dropWebView() }
        runtimes = [:]
        incognito = false
        incognitoSession = Session()
        incognitoJars = [:]
        settings.activeProfile = id
        normal = Storage.load(Session.self, "\(id)-session") ?? Session()
        if normal.tabs.isEmpty { normal = Session() }
        if normal.activeId == nil { normal.activeId = normal.tabs.last?.id }
        history = Storage.load([HistoryItem].self, "\(id)-history") ?? []
        bookmarks = Storage.load([Bookmark].self, "\(id)-bookmarks") ?? []
        jars = Storage.load([String: JSON].self, "\(id)-jars") ?? [:]
        passwords = Browser.loadPasswords(id)
        remoteTabs = []
        bankUnlocked = false
        sync.load(profileId: id)
        for t in normal.tabs { runtimes[t.id] = TabRuntime(id: t.id) }
        lease = nil
        saveSettings()
        activateCurrent()
        refreshStatus()
    }

    func addProfile(name: String) {
        let n = profiles.count
        let p = Profile(id: "p\(Int(Date().timeIntervalSince1970))", name: name.isEmpty ? "Профиль \(n + 1)" : name, color: Storage.profileColors[n % Storage.profileColors.count], clientId: NetClient.newClientId())
        profiles.append(p)
        saveSettings()
        switchProfile(p.id)
    }

    func deleteProfile(_ id: String) {
        guard profiles.count > 1 else { return }
        let removed = profiles.first { $0.id == id }
        profiles.removeAll { $0.id == id }
        for k in ["session", "history", "bookmarks", "jars"] { Storage.remove("\(id)-\(k)") }
        if let store = removed?.dataStoreId {
            if #available(iOS 17.0, *) { WKWebsiteDataStore.remove(forIdentifier: store) { _ in } }
        }
        if settings.activeProfile == id { switchProfile(profiles[0].id) } else { saveSettings() }
    }

    func updateNet(_ net: NetSettings) {
        guard let i = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        profiles[i].net = net
        saveSettings()
        lease = nil
        refreshStatus()
    }

    func setIncognito(_ on: Bool) {
        guard on != incognito else { return }
        if !on {
            for t in incognitoSession.tabs { runtimes[t.id]?.dropWebView(); runtimes[t.id] = nil }
            incognitoSession = Session()
            incognitoJars = [:]
            incognitoClientId = NetClient.newClientId()
        }
        incognito = on
        if on && incognitoSession.activeId == nil { incognitoSession.activeId = incognitoSession.tabs.last?.id }
        for t in session.tabs where runtimes[t.id] == nil { runtimes[t.id] = TabRuntime(id: t.id) }
        activateCurrent()
    }

    // MARK: Вкладки

    func select(_ id: String) {
        var s = session
        s.activeId = id
        session = s
        activateCurrent()
    }

    func newTab(_ url: String = Balnet.newTab) {
        navigate(url, newTab: true)
    }

    func close(_ id: String) {
        runtimes[id]?.dropWebView()
        runtimes[id] = nil
        var s = session
        guard let i = s.tabs.firstIndex(where: { $0.id == id }) else { return }
        s.tabs.remove(at: i)
        if s.tabs.isEmpty {
            let t = Tab()
            s.tabs = [t]
            runtimes[t.id] = TabRuntime(id: t.id)
        }
        if s.activeId == id { s.activeId = s.tabs[min(i, s.tabs.count - 1)].id }
        session = s
        activateCurrent()
    }

    func closeAll() {
        for t in tabs { runtimes[t.id]?.dropWebView(); runtimes[t.id] = nil }
        session = Session()
        session.activeId = session.tabs.first?.id
        for t in session.tabs { runtimes[t.id] = TabRuntime(id: t.id) }
        activateCurrent()
    }

    /// Активная вкладка ещё не загружена (после запуска или смены профиля) — загрузить.
    func activateCurrent() {
        guard let t = activeTab else { return }
        let rt = runtime(t.id)
        if rt.key == nil && rt.phase == .page {
            load(t.id)
        }
    }

    // MARK: Переходы

    /// Открыть адрес. typed — набран вручную (без Referer); fromPage — переход сообщила сама страница (не перезагружать WebView).
    func navigate(_ input: String, tabId: String? = nil, newTab: Bool = false, typed: Bool = false, referrer: String? = nil, fromPage: Bool = false) {
        var url = input
        if url.isEmpty { return }
        if case .upgrade(let u) = Balnet.resolve(url) { url = u }
        let title = Balnet.title(for: url)
        var s = session
        let id: String
        if newTab {
            var t = Tab(url: url, ref: (referrer ?? "").hasPrefix("http") ? referrer : nil)
            t.title = title
            s.tabs.append(t)
            s.activeId = t.id
            id = t.id
            runtimes[t.id] = TabRuntime(id: t.id)
        } else {
            guard let tid = tabId ?? s.activeId, let i = s.tabs.firstIndex(where: { $0.id == tid }) else { return }
            if s.tabs[i].url == url { return }
            let cur = s.tabs[i]
            let ref: String? = typed ? nil : (referrer ?? (cur.url.hasPrefix("http") ? cur.url : nil))
            s.tabs[i].back = Array((cur.back + [cur.url]).suffix(Self.maxBack))
            s.tabs[i].fwd = []
            s.tabs[i].url = url
            s.tabs[i].title = title
            s.tabs[i].ref = ref
            id = tid
        }
        session = s
        addHistory(url, title)
        load(id, fromPage: fromPage)
    }

    private func addHistory(_ url: String, _ title: String) {
        guard !incognito, url != Balnet.newTab else { return }
        history.insert(HistoryItem(url: url, title: title, ts: Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded() / 1000)), at: 0)
        if history.count > Self.historyLimit { history.removeLast(history.count - Self.historyLimit) }
        scheduleSave()
    }

    func goBack(_ id: String? = nil) {
        guard let tid = id ?? activeId, let t = tab(tid), let prev = t.back.last else { return }
        mutateTab(tid) { tab in
            tab.fwd = [tab.url] + tab.fwd
            tab.back.removeLast()
            tab.url = prev
            tab.title = Balnet.title(for: prev)
        }
        load(tid)
    }

    func goForward(_ id: String? = nil) {
        guard let tid = id ?? activeId, let t = tab(tid), let next = t.fwd.first else { return }
        mutateTab(tid) { tab in
            tab.back = Array((tab.back + [tab.url]).suffix(Self.maxBack))
            tab.fwd.removeFirst()
            tab.url = next
            tab.title = Balnet.title(for: next)
        }
        load(tid)
    }

    func reload(_ id: String? = nil) {
        guard let tid = id ?? activeId else { return }
        let rt = runtime(tid)
        rt.reloadCount += 1
        load(tid)
    }

    /// Заменить адрес без записи в историю «назад» (откат https → http).
    func replaceUrl(_ id: String, _ url: String) {
        mutateTab(id) { $0.url = url; $0.title = Balnet.title(for: url) }
        load(id)
    }

    func setTitle(tabId: String, title: String) {
        guard let t = tab(tabId), t.title != title else { return }
        mutateTab(tabId) { $0.title = title }
        if let first = history.first, first.url == t.url, first.title != title {
            history[0].title = title
            scheduleSave()
        }
    }

    // MARK: Загрузка вкладки: DNS → подключение → TLS → что показать

    func load(_ id: String, fromPage: Bool = false) {
        guard let t = tab(id) else { return }
        let rt = runtime(id)
        switch Balnet.resolve(t.url) {
        case .internal:
            rt.loadToken = UUID()
            rt.phase = .page
            rt.conn = nil
            rt.session = nil
            rt.key = nil
            rt.dropWebView()
        case .error(let code):
            rt.loadToken = UUID()
            rt.phase = .failed(code: code, host: "", ip: nil, dns: nil)
            rt.conn = nil
            rt.key = nil
        case .upgrade(let u):
            replaceUrl(id, u)
        case .web(let scheme, let host, let path):
            let key = "\(scheme)|\(host)|\(rt.reloadCount)"
            if rt.key == key, rt.phase == .done, let s = rt.session {
                // Переход внутри того же сайта: DNS и подключение не повторяем.
                if !fromPage { show(rt, s, path: path) }
                return
            }
            rt.key = key
            open(rt, url: t.url, scheme: scheme, host: host, path: path, fromPage: fromPage, ref: t.ref)
        }
    }

    private func open(_ rt: TabRuntime, url: String, scheme: String, host: String, path: String, fromPage: Bool, ref: String?) {
        let token = UUID()
        rt.loadToken = token
        rt.phase = .loading
        let origin = "\(scheme)://\(host)"
        let jar = incognito ? incognitoJars[origin] : jars[origin]
        let net = profile.net
        let cid = clientId
        let started = Date()
        Task { [weak self] in
            let r = await NetClient.shared.open(url, clientId: cid, net: net, jar: jar, referrer: ref)
            guard let self, rt.loadToken == token else { return }
            let total = Int(Date().timeIntervalSince(started) * 1000)
            switch r {
            case .failed(let code, let message):
                let c = code == "error" ? "ERR_BALNET_UNREACHABLE" : code
                rt.phase = code == "maintenance" ? .maintenance : .failed(code: c, host: host, ip: nil, dns: nil)
                rt.conn = nil
                rt.log(NetEntry(url: url, host: host, failed: c, message: message, total: total))
                if code == "ERR_BALNET_UNREACHABLE" { self.online = false }
                if code == "maintenance" { self.paused = true }
            case .ok(let d, let lease):
                self.online = true
                if !self.incognito { self.lease = lease }
                await self.finishOpen(rt, d: d, lease: lease, url: url, scheme: scheme, host: host, path: path, origin: origin, fromPage: fromPage, total: total, token: token)
            }
        }
    }

    private func finishOpen(_ rt: TabRuntime, d: JSON, lease: Lease, url: String, scheme: String, host: String, path: String, origin: String, fromPage: Bool, total: Int, token: UUID) async {
        let ok = d["ok"]?.bool ?? false
        let tls = d["tls"].flatMap { $0.isNull ? nil : $0 }
        if ok && scheme == "https" && tls == nil {
            // На сервере нет сертификата. Как Chrome с автопереходом на HTTPS: откат на http — кроме сайтов из HSTS.
            if Balnet.hstsPreload.contains(host) {
                rt.phase = .failed(code: "ERR_CONNECTION_REFUSED", host: host, ip: d["ip"]?.string, dns: nil)
                rt.log(NetEntry(url: url, host: host, total: total, data: d, lease: lease))
                return
            }
            rt.log(NetEntry(url: url, host: host, total: total, data: d, lease: lease, note: "https на сервере нет — переход на http"))
            if let id = runtimes.first(where: { $0.value === rt })?.key { replaceUrl(id, "http" + url.dropFirst(5)) }
            return
        }
        var cert: CertVerdict?
        if ok, let tls {
            cert = await NetClient.shared.checkTLS(tls, host: host)
            guard rt.loadToken == token else { return }
        }
        rt.conn = Conn(ok: ok, gov: d["gov"]?.bool ?? false, ip: d["ip"]?.string, host: host, cert: cert, tls: tls)
        rt.log(NetEntry(url: url, host: host, total: total, data: d, cert: cert, lease: lease))
        if let cert, !cert.ok, !certBypass.contains("\(host)|\(cert.hash ?? "")") {
            rt.phase = .certError(cert)
            return
        }
        if !ok {
            rt.phase = .failed(code: d["code"]?.string ?? "ERR_CONNECTION_REFUSED", host: host, ip: d["ip"]?.string, dns: d["dns"])
            return
        }
        let target = d["target"]?.string ?? ""
        if target.hasPrefix("site:"), let ticket = d["ticket"]?.string {
            let s = SiteSession.site(ticket: ticket, origin: origin)
            rt.session = s
            rt.phase = .done
            show(rt, s, path: path)
        } else if target.hasPrefix("app:") {
            let app = String(target.dropFirst(4))
            let s = SiteSession.gov(app: app)
            let sameApp = fromPage && rt.webKind == .gov && rt.govApp == app && rt.webView != nil
            rt.session = s
            rt.phase = .done
            if !sameApp { show(rt, s, path: path) }
        } else {
            rt.phase = .failed(code: "HTTP_404_NO_VHOST", host: host, ip: d["ip"]?.string, dns: nil)
        }
    }

    /// Показать путь сайта в WebView вкладки (создаёт WebView нужного вида).
    private func show(_ rt: TabRuntime, _ s: SiteSession, path: String) {
        switch s {
        case .gov(let app):
            ensureWebView(rt, kind: .gov)
            guard let url = Balnet.govAppURL(app: app, path: path) else { return }
            rt.govApp = app
            if rt.webView?.url != url { rt.webView?.load(URLRequest(url: url)) }
        case .site(let ticket, _):
            ensureWebView(rt, kind: .site)
            guard let url = URL(string: "\(Config.api)/api/net/web/\(ticket)\(path)") else { return }
            rt.webView?.load(URLRequest(url: url))
        }
    }

    private func ensureWebView(_ rt: TabRuntime, kind: WebKind) {
        if rt.webView != nil && rt.webKind == kind { return }
        rt.dropWebView()
        let store: WKWebsiteDataStore = kind == .gov ? govStore() : siteStore
        let (wv, co) = WebCoordinator.makeWebView(kind: kind, browser: self, tabId: rt.id, dataStore: store, theme: themeName)
        wv.overrideUserInterfaceStyle = settings.theme == .system ? .unspecified : (settings.theme == .dark ? .dark : .light)
        rt.webView = wv
        rt.webKind = kind
        rt.coordinator = co
        rt.webGeneration += 1
    }

    /// Хранилище госсайтов профиля. Отдельное хранилище на профиль есть с iOS 17;
    /// на iOS 16 у всех профилей общий вход на госсайты (как у инкогнито).
    private func govStore() -> WKWebsiteDataStore {
        if #available(iOS 17.0, *) { return WKWebsiteDataStore(forIdentifier: profile.dataStoreId) }
        return .default()
    }

    /// Тема поменялась — передать госсайтам.
    func applyTheme() {
        let t = themeName
        for rt in runtimes.values {
            guard let wv = rt.webView else { continue }
            wv.overrideUserInterfaceStyle = settings.theme == .system ? .unspecified : (settings.theme == .dark ? .dark : .light)
            if rt.webKind == .gov { wv.evaluateJavaScript(Scripts.theme(t)) }
        }
    }

    // MARK: Сообщения страниц

    /// Адрес WebView изменился: госсайт перешёл по своему маршруту или в другое приложение.
    func webURLChanged(tabId: String, kind: WebKind, url: URL) {
        guard kind == .gov, let rt = runtimes[tabId], let t = tab(tabId), let p = Balnet.split(t.url), case .gov(let app)? = rt.session else { return }
        let rel = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let frameApp = rel.split(separator: "/").first.map(String.init) ?? ""
        guard url.host == Config.siteHost, !frameApp.isEmpty else { return }
        rt.govApp = frameApp
        guard let balnet = Balnet.balnetURL(fromGov: url, app: app, host: p.host), balnet != t.url else { return }
        navigate(balnet, tabId: tabId, fromPage: true)
    }

    /// window.__balnetOpen госсайта и «open» shim: ссылка на другой адрес БалНета.
    func openFromPage(tabId: String, raw: String, newTab: Bool) {
        guard let url = Balnet.parseInput(raw), !url.hasPrefix("balnet://") else { return }
        if newTab { navigate(url, newTab: true, referrer: tab(tabId)?.url) } else { navigate(url, tabId: tabId) }
    }

    /// Сообщение shim сайта игрока. Принимается только от текущего билета вкладки; nav — только на адрес этого же сайта.
    func siteMessage(tabId: String, _ m: JSON) {
        guard let rt = runtimes[tabId], case .site(let ticket, let origin)? = rt.session, m["ticket"]?.string == ticket else { return }
        switch m["type"]?.string ?? "" {
        case "nav":
            guard let url = m["url"]?.string, let p = Balnet.split(url), "\(p.scheme)://\(p.host)" == origin else { return }
            navigate(url, tabId: tabId, fromPage: true)
            if let title = m["title"]?.string, !title.isEmpty { setTitle(tabId: tabId, title: String(title.prefix(200))) }
        case "open":
            if let url = m["url"]?.string { openFromPage(tabId: tabId, raw: url, newTab: m["newTab"]?.bool ?? false) }
        case "jar":
            let jar: JSON = .object(["cookies": m["cookies"] ?? .object([:]), "local": m["local"] ?? .object([:])])
            if incognito { incognitoJars[origin] = jar } else { jars[origin] = jar; scheduleSave() }
            Task { _ = try? await API.post("/net/jar", ["ticket": ticket, "cookies": (m["cookies"] ?? .object([:])).any, "local": (m["local"] ?? .object([:])).any]) }
        case "credential":
            if let p = m["password"]?.string, !p.isEmpty { offerPassword(origin: origin, username: m["username"]?.string ?? "", password: p) }
        case "login-form":
            offerFill(tabId: tabId, origin: origin, ticket: ticket)
        case "notify":
            rt.addConsole("info", "Уведомление сайта: \(m["title"]?.string ?? "") — уведомления появятся в следующей версии")
        default:
            break
        }
    }

    func jar(for origin: String) -> JSON? { incognito ? incognitoJars[origin] : jars[origin] }

    /// WebView не смог загрузить страницу с сервера игры.
    func webLoadFailed(tabId: String, message: String) {
        guard let rt = runtimes[tabId], let t = tab(tabId), let p = Balnet.split(t.url) else { return }
        rt.phase = .failed(code: "ERR_BALNET_UNREACHABLE", host: p.host, ip: nil, dns: nil)
        rt.log(NetEntry(url: t.url, host: p.host, failed: "ERR_BALNET_UNREACHABLE", message: message, total: 0))
    }

    func proceedUnsafe(_ id: String, host: String, hash: String?) {
        certBypass.insert("\(host)|\(hash ?? "")")
        reload(id)
    }

    // MARK: Закладки и история

    func isBookmarked(_ url: String) -> Bool { bookmarks.contains { $0.url == url } }

    func toggleBookmark(_ t: Tab) {
        if isBookmarked(t.url) { bookmarks.removeAll { $0.url == t.url } } else { bookmarks.insert(Bookmark(url: t.url, title: t.title), at: 0) }
        scheduleSave()
    }

    func clearHistory() {
        history = []
        scheduleSave()
    }

    // MARK: Строка состояния: провайдер, сигнал, игровое время, обновления

    func refreshStatus() {
        let cid = profile.clientId
        let net = profile.net
        Task { [weak self] in
            let t0 = Date()
            do {
                let c = try await API.get("/clock")
                guard let self else { return }
                self.latency = Int(Date().timeIntervalSince(t0) * 1000)
                self.clockMonth = c["month"]?.int
                self.paused = c["paused"]?.bool ?? false
                self.online = true
            } catch {
                self?.latency = nil
                self?.online = false
            }
            if let self, self.lease == nil, let l = try? await NetClient.shared.lease(clientId: cid, provider: net.provider) {
                self.lease = l
            }
        }
    }

    func checkUpdate() {
        Task { [weak self] in
            guard let j = try? await API.get("/app/ios"), let v = j["version"]?.string else { return }
            if Browser.isNewer(v, than: Config.version) {
                self?.update = (v, j["url"]?.string ?? "\(Config.site)/ios/")
            }
        }
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0
            let q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    // MARK: Значок у адреса (securityOf)

    enum Security: Equatable {
        case `internal`
        case gov(owner: String)
        case secure
        case insecure
        case danger(String)
        case none
    }

    func security(_ t: Tab) -> Security {
        switch Balnet.resolve(t.url) {
        case .internal: return .internal
        case .web(let scheme, let host, _):
            let c = runtimes[t.id]?.conn
            let mine = c?.host == host
            if mine, scheme == "https", let cert = c?.cert, !cert.ok { return .danger("Не защищено") }
            if mine, c?.gov == true, c?.cert?.ok == true { return .gov(owner: Balnet.govSites[host]?.owner ?? "Правительство БФ") }
            if mine, scheme == "https", c?.cert?.ok == true { return .secure }
            if scheme == "http" { return .insecure }
            return .none
        default: return .none
        }
    }
}
