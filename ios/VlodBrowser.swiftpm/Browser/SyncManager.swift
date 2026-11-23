import Foundation
import Combine
import WebKit

/// Аккаунт ВлодБраузера (на ВлодПочте) и синхронизация: закладки, история, пароли, открытые вкладки, настройки.
/// Протокол тот же, что у веб-версии (Н8.2): данные шифруются на устройстве, сервер хранит только шифротекст.
@MainActor
final class SyncManager: ObservableObject {
    struct Account: Equatable {
        var token: String
        var login: String
        var address: String
        var name: String
    }

    enum Status: Equatable {
        case idle
        case syncing
        case ok(Date)
        case error(String)
    }

    @Published private(set) var account: Account?
    @Published private(set) var hasKey = false
    /// На сервере уже есть кодовая фраза (другое устройство) — её нужно ввести, а не придумать.
    @Published private(set) var phraseExists = false
    @Published private(set) var status: Status = .idle

    weak var browser: Browser?
    private var key: Data?
    private var profileId = ""
    private var timer: Task<Void, Never>?
    private var soon: Task<Void, Never>?

    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: Профиль

    func load(profileId: String) {
        self.profileId = profileId
        timer?.cancel()
        if let j = Keychain.getJSON("acct-\(profileId)"), let token = j["token"]?.string {
            account = Account(token: token, login: j["login"]?.string ?? "", address: j["address"]?.string ?? "", name: j["name"]?.string ?? "")
        } else {
            account = nil
        }
        key = Keychain.get("synckey-\(profileId)")
        hasKey = key != nil
        phraseExists = false
        status = .idle
        if account != nil && key != nil { startTimer() }
    }

    private func startTimer() {
        timer?.cancel()
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sync()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    /// Скоро синхронизировать (после правки закладок или паролей).
    func syncSoon() {
        guard account != nil, key != nil else { return }
        soon?.cancel()
        soon = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { await self?.sync() }
        }
    }

    // MARK: Вход

    /// Войти через ВлодПочту: нужен вход на mail.bln в этом приложении (cookie госсайтов).
    func signIn(deviceName: String, cookies: [HTTPCookie]) async throws {
        let mine = cookies.filter { Config.apiHost.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
        guard !mine.isEmpty else { throw Failure(message: "Сначала войдите во ВлодПочту (mail.bln) в этом браузере") }
        let header = mine.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        let r: JSON
        do {
            r = try await API.post("/mail/sync/devices", ["name": deviceName], headers: ["Cookie": header])
        } catch let e as APIError where e.status == 401 || e.status == 403 {
            throw Failure(message: "Сначала войдите во ВлодПочту (mail.bln) в этом браузере. \(e.message)")
        }
        let acc = Account(token: r["token"]?.string ?? "", login: r["account"]?["login"]?.string ?? "", address: r["account"]?["address"]?.string ?? "", name: r["account"]?["name"]?.string ?? "")
        Keychain.setJSON(.object(["token": .string(acc.token), "login": .string(acc.login), "address": .string(acc.address), "name": .string(acc.name)]), for: "acct-\(profileId)")
        Keychain.delete("synckey-\(profileId)")
        key = nil
        hasKey = false
        phraseExists = !(r["key"]?.isNull ?? true)
        account = acc
    }

    /// Кодовая фраза: задать новую (первое устройство) или ввести существующую.
    func setPhrase(_ phrase: String) async throws {
        guard let acc = account else { return }
        let st = try await API.post("/mail/sync/status", ["token": acc.token])
        let info = st["key"] ?? .null
        let k: Data
        if !info.isNull {
            let made = try await Task.detached { try SyncCrypto.unlock(phrase: phrase, info: info) }.value
            guard let made else { throw Failure(message: "Неверная кодовая фраза") }
            k = made
        } else {
            let made = try await Task.detached { try SyncCrypto.create(phrase: phrase) }.value
            _ = try await API.post("/mail/sync/key", ["token": acc.token, "salt": made.salt, "iterations": SyncCrypto.iterations, "check": made.check])
            k = made.key
        }
        Keychain.set(k, for: "synckey-\(profileId)")
        key = k
        hasKey = true
        startTimer()
    }

    func refreshPhraseState() async {
        guard let acc = account, key == nil else { return }
        if let st = try? await API.post("/mail/sync/status", ["token": acc.token]) { phraseExists = !(st["key"]?.isNull ?? true) }
    }

    func signOut() async {
        if let t = account?.token { _ = try? await API.post("/mail/sync/signout", ["token": t]) }
        clearLocal()
    }

    private func clearLocal() {
        timer?.cancel()
        Keychain.delete("acct-\(profileId)")
        Keychain.delete("synckey-\(profileId)")
        for n in SyncMerge.names { Storage.remove("\(profileId)-syncbase-\(n)") }
        account = nil
        key = nil
        hasKey = false
        status = .idle
        browser?.remoteTabs = []
    }

    // MARK: Синхронизация

    func sync() async {
        guard let acc = account, let key, let browser, status != .syncing else { return }
        status = .syncing
        do {
            var pulled = try await API.post("/mail/sync/pull", ["token": acc.token])["collections"] ?? .null
            for name in SyncMerge.names {
                for attempt in 0..<4 {
                    let remote = pulled[name].flatMap { $0.isNull ? nil : $0 }
                    let doc = try remote.map { try SyncCrypto.decrypt(key: key, $0["blob"]?.string ?? "") }
                    let local = browser.syncRead(name)
                    let base = Storage.load([JSON].self, "\(profileId)-syncbase-\(name)")
                    let m = SyncMerge.merge(name, local: local, base: base, doc: doc)
                    do {
                        if doc == nil || doc != m.doc {
                            _ = try await API.post("/mail/sync/push", ["token": acc.token, "collection": name, "base_rev": remote?["rev"]?.int ?? 0, "blob": try SyncCrypto.encrypt(key: key, m.doc)])
                        }
                        browser.syncWrite(name, m.list)
                        let own = name == "tabs" ? m.list.filter { $0["device"]?.string == browser.profile.clientId } : m.list
                        Storage.save(own, "\(profileId)-syncbase-\(name)")
                        break
                    } catch let e as APIError where e.status == 409 && attempt < 3 {
                        pulled = try await API.post("/mail/sync/pull", ["token": acc.token])["collections"] ?? .null
                    }
                }
            }
            status = .ok(Date())
        } catch let e as APIError where e.status == 401 {
            clearLocal()
            status = .error("Устройство отключено от аккаунта — войдите заново")
        } catch {
            status = .error(error.localizedDescription)
        }
    }
}
