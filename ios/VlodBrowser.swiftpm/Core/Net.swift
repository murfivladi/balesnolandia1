import Foundation

/// Подключение профиля к БалНету: провайдер и DNS (как DEFAULT_NET в вебе).
struct NetSettings: Codable, Equatable {
    var provider = "baltelecom"
    /// provider — резолвер провайдера, public — ВлодDNS 50.0.0.53, custom — свой.
    var dnsMode = "provider"
    var dns = ""

    var resolver: String? {
        if dnsMode == "public" { return Balnet.publicDNS }
        if dnsMode == "custom" && !dns.isEmpty { return dns }
        return nil
    }
}

/// Аренда IP-адреса у провайдера.
struct Lease: Equatable {
    var ip: String
    var providerCode: String
    var providerName: String
    var resolverIP: String
    var gateway: String?
    var netmask: String?

    init(_ j: JSON) {
        ip = j["ip"]?.string ?? ""
        providerCode = j["provider"]?["code"]?.string ?? ""
        providerName = j["provider"]?["name"]?.string ?? ""
        resolverIP = j["resolver_ip"]?.string ?? ""
        gateway = j["gateway"]?.string
        netmask = j["netmask"]?.string
    }
}

struct Provider: Identifiable, Equatable {
    var id: String { code }
    let code: String
    let name: String
    let resolverIP: String
}

/// Ответ сетевого API или отказ: maintenance, ERR_BALNET_UNREACHABLE, error(+текст).
enum NetResult {
    case ok(JSON, Lease)
    case failed(String, String?)
}

/// Сетевой стек ВлодБраузера: аренда IP, открытие сайтов через DNS, запросы терминала (порт web/src/browser/net.js).
@MainActor
final class NetClient {
    static let shared = NetClient()
    private var leases: [String: Task<Lease, Error>] = [:]
    private var providersTask: Task<[Provider], Error>?

    static func newClientId() -> String {
        "dev-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24)
    }

    func lease(clientId: String, provider: String, fresh: Bool = false) async throws -> Lease {
        let key = "\(clientId)|\(provider)"
        if fresh { leases[key] = nil }
        if leases[key] == nil {
            leases[key] = Task { Lease(try await API.post("/net/lease", ["client_id": clientId, "provider": provider])) }
        }
        do {
            return try await leases[key]!.value
        } catch {
            leases[key] = nil
            throw error
        }
    }

    func providers() async throws -> [Provider] {
        if providersTask == nil {
            providersTask = Task {
                let j = try await API.get("/net/providers")
                return j["providers"]?.array.map { Provider(code: $0["code"]?.string ?? "", name: $0["name"]?.string ?? "", resolverIP: $0["resolver_ip"]?.string ?? "") } ?? []
            }
        }
        do {
            return try await providersTask!.value
        } catch {
            providersTask = nil
            throw error
        }
    }

    /// Запрос от имени устройства. Если сервер забыл аренду (сброс игры) — подключаемся заново.
    func call(_ path: String, _ body: [String: Any], clientId: String, net: NetSettings) async -> NetResult {
        func attempt(_ fresh: Bool) async throws -> NetResult {
            let l = try await lease(clientId: clientId, provider: net.provider, fresh: fresh)
            var b = body
            b["client_id"] = clientId
            if let r = net.resolver { b["resolver"] = r }
            return .ok(try await API.post(path, b), l)
        }
        do {
            do {
                return try await attempt(false)
            } catch let e as APIError where e.code == "no_lease" || e.code == "not_found" {
                return try await attempt(true)
            }
        } catch let e as APIError {
            if e.code == "balnet_maintenance" { return .failed("maintenance", e.message) }
            if e.status == 0 { return .failed("ERR_BALNET_UNREACHABLE", e.message) }
            return .failed("error", e.message)
        } catch {
            return .failed("error", error.localizedDescription)
        }
    }

    /// Открыть адрес. jar — cookies и localStorage сайта игрока из профиля.
    func open(_ url: String, clientId: String, net: NetSettings, jar: JSON?, referrer: String?) async -> NetResult {
        var body: [String: Any] = ["url": url]
        if let jar, !jar.isNull { body["jar"] = jar.any }
        if let referrer { body["referrer"] = referrer }
        return await call("/net/open", body, clientId: clientId, net: net)
    }

    // MARK: Хранилище доверия (корневые УЦ, журналы CT), как в Chrome — обновляется раз в 5 минут

    private var trust: (JSON, Date)?

    func trustStore(refresh: Bool = false) async throws -> JSON {
        if !refresh, let t = trust, Date().timeIntervalSince(t.1) < 300 { return t.0 }
        let j = try await API.get("/net/trust")
        trust = (j, Date())
        return j
    }

    func checkTLS(_ tls: JSON, host: String) async -> CertVerdict {
        do {
            let t = try await trustStore()
            return PKI.verify(tls: tls, host: host, trust: t)
        } catch {
            return CertVerdict(ok: false, code: "ERR_CERT_INVALID", hash: nil, time: tls["time"]?.double ?? 0)
        }
    }
}
