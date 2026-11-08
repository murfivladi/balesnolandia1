import Foundation
import Combine

/// Терминал ВлодБраузера: сетевые утилиты БалНета с выводом как у настоящих (порт web/src/browser/terminal.jsx).
@MainActor
final class TerminalEngine: ObservableObject {
    struct SSHState: Equatable {
        var session: String?
        var prompt: String = ""
        var user = ""
        var host = ""
        var awaitingPassword: Bool { session == nil }
    }

    struct Editor: Equatable {
        var path: String
        var content: String
        var saved: String
        var dirty: Bool { content != saved }
    }

    @Published var lines: [String] = ["ВлодБраузер — терминал БалНета. Введите help, чтобы увидеть команды.", ""]
    @Published var busy = false
    @Published var history: [String] = []
    @Published var ssh: SSHState?
    @Published var editor: Editor?

    weak var browser: Browser?

    static let help = [
        "Команды:",
        "  ipconfig                   — адрес устройства, шлюз, DNS",
        "  nslookup <имя> [сервер]    — найти адрес",
        "  host <имя>                 — адреса и почтовые серверы имени",
        "  dig [@сервер] <имя> [тип] [+trace] [+short] [+norec] [+dnssec] [+cd]",
        "                             — DNS-запрос; типы: A AAAA CNAME MX TXT NS SOA SRV CAA PTR DS DNSKEY ANY",
        "  dig -x <ip>                — обратный запрос (PTR)",
        "  openssl s_client -connect <хост>[:443]",
        "                             — сертификат сервера и его проверка",
        "  ping [-c N] <хост>         — проверить связь",
        "  traceroute <хост>          — маршрут до хоста",
        "  whois <домен|ip>           — кто владеет доменом или адресом",
        "  curl [-I] [-k] <адрес>     — запрос к сайту (-k — не проверять сертификат)",
        "  ssh u<номер>@<сервер>      — войти на сервер хостинга (пароль задаётся в панели БалХоста)",
        "  open <адрес>               — открыть сайт в новой вкладке",
        "  clear                      — очистить экран",
        "",
        "Подсказка: ↑ и ↓ на панели клавиш — история команд.",
    ]

    var promptLabel: String {
        if let s = ssh { return s.session != nil ? s.prompt : "" }
        return "$"
    }

    var secureInput: Bool { ssh?.awaitingPassword == true }

    private func print(_ ls: [String]) {
        lines.append(contentsOf: ls)
        if lines.count > 2000 { lines.removeFirst(lines.count - 2000) }
    }

    private func print(_ ls: String...) { print(ls) }

    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private func call(_ path: String, _ body: [String: Any]) async throws -> JSON {
        guard let b = browser else { throw Failure(message: "Браузер недоступен") }
        let r = await NetClient.shared.call(path, body, clientId: b.clientId, net: b.profile.net)
        switch r {
        case .ok(let d, _): return d
        case .failed(let code, let message):
            if code == "maintenance" { throw Failure(message: "БалНет на обслуживании: игровое время на паузе") }
            throw Failure(message: message ?? "Нет связи с сервером БалНета")
        }
    }

    private func query(_ server: String?, _ name: String, _ type: String, recurse: Bool = true, dnssec: Bool = false, cd: Bool = false) async throws -> JSON {
        var body: [String: Any] = ["name": name, "type": type, "recurse": recurse, "dnssec": dnssec, "cd": cd]
        if let server { body["server"] = server }
        return try await call("/net/query", body)
    }

    private func usedResolver() async -> String {
        guard let b = browser else { return "" }
        if let r = b.profile.net.resolver { return r }
        return (try? await NetClient.shared.lease(clientId: b.clientId, provider: b.profile.net.provider).resolverIP) ?? ""
    }

    // MARK: Ввод

    func submit(_ line: String) async {
        busy = true
        defer { busy = false }
        do {
            if let s = ssh, s.awaitingPassword {
                try await sshLogin(line)
            } else {
                if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    history.append(line)
                    if history.count > 100 { history.removeFirst() }
                }
                print("\(promptLabel) \(line)")
                try await run(line)
            }
        } catch {
            print("Ошибка: \(error.localizedDescription)")
        }
    }

    private func run(_ line: String) async throws {
        if ssh?.session != nil { return try await sshExec(line) }
        var args = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard !args.isEmpty else { return }
        let cmd = args.removeFirst().lowercased()
        switch cmd {
        case "help": print(Self.help)
        case "clear", "cls": lines = []
        case "ipconfig", "ifconfig", "ip": try await ipconfig()
        case "dig": try await dig(args)
        case "nslookup": try await nslookup(args)
        case "host": try await host(args)
        case "ping": try await ping(args)
        case "traceroute", "tracert": try await traceroute(args)
        case "whois": try await whois(args)
        case "curl": try await curl(args)
        case "openssl": try await openssl(args)
        case "ssh": sshStart(args)
        case "open":
            if let a = args.first, let u = Balnet.parseInput(a) { browser?.navigate(u, newTab: true) } else { print("Использование: open <адрес>") }
        default: print("\(cmd): команда не найдена. Введите help.")
        }
    }

    // MARK: DNS

    private static func strip(_ s: String?) -> String {
        guard var s else { return "" }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }

    private static func pad(_ s: String, _ n: Int) -> String {
        s.count >= n ? s : s + String(repeating: " ", count: n - s.count)
    }

    static func formatRR(_ rr: JSON) -> String {
        let name = pad(rr["name"]?.string ?? "", 24)
        let ttl = rr["ttl"]?.string ?? ""
        let ttlPad = String(repeating: " ", count: max(0, 6 - ttl.count)) + ttl
        return "\(name) \(ttlPad)\tIN\t\(pad(rr["type"]?.string ?? "", 5))\t\(rr["data"]?.string ?? "")"
    }

    private func header(_ r: JSON, _ flags: String) -> [String] {
        [
            ";; ->>HEADER<<- opcode: QUERY, status: \(r["rcode"]?.string ?? "")",
            ";; flags: \(flags); QUERY: 1, ANSWER: \(r["answer"]?.array.count ?? 0), AUTHORITY: \(r["authority"]?.array.count ?? 0), ADDITIONAL: \(r["additional"]?.array.count ?? 0)",
        ]
    }

    private func sections(_ r: JSON) -> [String] {
        var out = ["", ";; QUESTION SECTION:", ";\(Self.pad(r["qname"]?.string ?? "", 23))\tIN\t\(r["qtype"]?.string ?? "")"]
        let ans = r["answer"]?.array ?? []
        let auth = r["authority"]?.array ?? []
        let add = r["additional"]?.array ?? []
        if !ans.isEmpty { out += ["", ";; ANSWER SECTION:"] + ans.map(Self.formatRR) }
        if !auth.isEmpty { out += ["", ";; AUTHORITY SECTION:"] + auth.map(Self.formatRR) }
        if !add.isEmpty { out += ["", ";; ADDITIONAL SECTION:"] + add.map(Self.formatRR) }
        return out
    }

    private func addressOf(_ host: String) async throws -> String? {
        let r = try await call("/net/resolve", ["name": host, "type": "A"])
        return r["answer"]?.array.first { $0["type"]?.string == "A" }?["data"]?.string
    }

    private func dig(_ args: [String]) async throws {
        var server: String?
        var name: String?
        var type = "A"
        var flags: [String] = []
        var i = 0
        while i < args.count {
            let a = args[i]
            if a.hasPrefix("@") { server = String(a.dropFirst()) }
            else if a.hasPrefix("+") { flags.append(String(a.dropFirst()).lowercased()) }
            else if a == "-x" { i += 1; name = Balnet.reverseName(i < args.count ? args[i] : ""); type = "PTR" }
            else if name == nil { name = a }
            else { type = a.uppercased() }
            i += 1
        }
        guard let name else { return print("Использование: dig [@сервер] <имя> [тип] [+trace] [+short] [+norec]") }
        if let s = server, !Balnet.isIP(s) {
            guard let ip = try await addressOf(s) else { return print("dig: не удалось найти адрес сервера \(s)") }
            server = ip
        }
        if flags.contains("trace") { return try await digTrace(name, type) }
        let dnssec = flags.contains("dnssec") || flags.contains("do")
        let cd = flags.contains("cd")
        let norec = flags.contains("norec")
        let r = try await query(server, name, type, recurse: !norec, dnssec: dnssec, cd: cd)
        if flags.contains("short") { return print((r["answer"]?.array ?? []).map { $0["data"]?.string ?? "" }) }
        var used = server ?? ""
        if used.isEmpty { used = await usedResolver() }
        if r["rcode"]?.string == "TIMEOUT" { return print(";; connection timed out; no servers could be reached (\(used))") }
        let aa = r["aa"]?.bool ?? false
        let ra = r["ra"].map { $0 != .bool(false) } ?? true
        var fl = ["qr"]
        if aa { fl.append("aa") }
        if !norec { fl.append("rd") }
        if ra && !aa { fl.append("ra") }
        if r["ad"]?.bool ?? false { fl.append("ad") }
        if cd { fl.append("cd") }
        let shownFlags = flags.filter { $0 != "short" }.map { " +\($0)" }.joined()
        var out = ["; <<>> DiG (ВлодБраузер) <<>> \(server.map { "@\($0) " } ?? "")\(name) \(type)\(shownFlags)"]
        out += header(r, fl.joined(separator: " "))
        if dnssec { out += ["", ";; OPT PSEUDOSECTION:", "; EDNS: version: 0, flags: do; udp: 1232"] }
        if let ede = r["ede"]?.string { out.append("; EDE: 6 (DNSSEC Bogus): (\(ede.replacingOccurrences(of: "DNSSEC Bogus: ", with: "")))") }
        out += sections(r)
        out += ["", ";; Query time: \(Int(r["ms"]?.double ?? 0)) msec", ";; SERVER: \(used)#53(\(Self.strip(r["server"]?["name"]?.string).isEmpty ? used : Self.strip(r["server"]?["name"]?.string)))", ""]
        print(out)
    }

    /// dig +trace: обход от корня, каждым запросом без рекурсии.
    private func digTrace(_ name: String, _ type: String) async throws {
        let roots = try await query(nil, ".", "NS")
        let rootNS = roots["answer"]?.array ?? []
        print(["; <<>> DiG (ВлодБраузер) <<>> \(name) \(type) +trace"] + rootNS.map(Self.formatRR) + [";; Received from \(browser?.profile.net.resolver ?? "DNS провайдера")", ""])
        var servers: [(name: String, ip: String)] = []
        for ns in rootNS {
            let n = ns["data"]?.string ?? ""
            if let ip = try await addressOf(n) { servers.append((n, ip)) }
        }
        var step = 0
        while step < 12, let s = servers.first {
            step += 1
            let r = try await query(s.ip, name, type, recurse: false, dnssec: true)
            let ans = r["answer"]?.array ?? []
            let auth = r["authority"]?.array ?? []
            print((ans.isEmpty ? auth : ans).map(Self.formatRR) + [";; Received from \(Self.strip(s.name)) (\(s.ip)) in \(Int(r["ms"]?.double ?? 0)) ms", ""])
            if r["rcode"]?.string != "NOERROR" || !ans.isEmpty || (r["aa"]?.bool ?? false) { return }
            var next: [(name: String, ip: String)] = []
            let add = r["additional"]?.array ?? []
            for ns in auth where ns["type"]?.string == "NS" {
                let n = ns["data"]?.string ?? ""
                let glue = add.first { $0["name"]?.string == n && $0["type"]?.string == "A" }?["data"]?.string
                var ip = glue
                if ip == nil { ip = try await addressOf(n) }
                if let ip { next.append((n, ip)) }
            }
            servers = next
        }
    }

    private func nslookup(_ args: [String]) async throws {
        guard let name = args.first else { return print("Использование: nslookup <имя> [сервер]") }
        let server = args.count > 1 ? args[1] : nil
        let rev = Balnet.isIP(name)
        let r = try await query(server, rev ? Balnet.reverseName(name) : name, rev ? "PTR" : "A")
        var used = server ?? ""
        if used.isEmpty { used = await usedResolver() }
        if r["rcode"]?.string == "TIMEOUT" { return print(";; connection timed out; no servers could be reached", "") }
        print("Server:\t\t\(used)", "Address:\t\(used)#53", "")
        if r["rcode"]?.string != "NOERROR" { return print("** server can't find \(name): \(r["rcode"]?.string ?? "")", "") }
        let ans = r["answer"]?.array ?? []
        if ans.isEmpty { return print("*** Can't find \(name): No answer", "") }
        if !(r["aa"]?.bool ?? false) { print("Non-authoritative answer:") }
        for a in ans {
            let t = a["type"]?.string
            if t == "CNAME" { print("\(Self.strip(a["name"]?.string))\tcanonical name = \(Self.strip(a["data"]?.string)).") }
            else if t == "PTR" { print("\(Self.strip(a["name"]?.string))\tname = \(a["data"]?.string ?? "")") }
            else { print("Name:\t\(Self.strip(a["name"]?.string))", "Address: \(a["data"]?.string ?? "")") }
        }
        print("")
    }

    private func host(_ args: [String]) async throws {
        guard let name = args.first else { return print("Использование: host <имя>") }
        if Balnet.isIP(name) {
            let r = try await call("/net/resolve", ["name": Balnet.reverseName(name), "type": "PTR"])
            let ans = r["answer"]?.array ?? []
            return print(ans.isEmpty ? ["Host \(Balnet.reverseName(name)) not found: 3(NXDOMAIN)"] : ans.map { "\(Self.strip($0["name"]?.string)) domain name pointer \($0["data"]?.string ?? "")" })
        }
        var out: [String] = []
        for type in ["A", "AAAA", "MX"] {
            let r = try await call("/net/resolve", ["name": name, "type": type])
            let rc = r["rcode"]?.string ?? ""
            if rc == "NXDOMAIN" { return print("Host \(name) not found: 3(NXDOMAIN)") }
            if rc != "NOERROR" { return print(";; \(rc)") }
            for a in r["answer"]?.array ?? [] {
                let n = Self.strip(a["name"]?.string)
                let d = a["data"]?.string ?? ""
                switch a["type"]?.string ?? "" {
                case "CNAME" where type == "A": out.append("\(n) is an alias for \(d)")
                case "A": out.append("\(n) has address \(d)")
                case "AAAA": out.append("\(n) has IPv6 address \(d)")
                case "MX": out.append("\(n) mail is handled by \(d)")
                default: break
                }
            }
        }
        print(out.isEmpty ? ["\(name) has no address records"] : out)
    }

    // MARK: Связь

    private func ping(_ input: [String]) async throws {
        var args = input
        var count = 4
        if let i = args.firstIndex(of: "-c") {
            count = min(10, max(1, Int(i + 1 < args.count ? args[i + 1] : "") ?? 4))
            args.removeSubrange(i..<min(i + 2, args.count))
        }
        guard let target = args.first else { return print("Использование: ping [-c N] <хост>") }
        let r = try await call("/net/ping", ["host": target, "count": count])
        if let e = r["error"]?.string {
            return print("ping: \(target): \(e == "DNS_PROBE_FINISHED_NXDOMAIN" ? "Name or service not known" : "Temporary failure in name resolution")")
        }
        let ip = r["ip"]?.string ?? ""
        print("PING \(target) (\(ip)) 56(84) bytes of data.")
        let replies = r["replies"]?.array ?? []
        let who = r["name"]?.string.map { "\(Self.strip($0)) (\(ip))" } ?? ip
        for x in replies {
            let seq = x["seq"]?.string ?? ""
            if x["lost"]?.bool ?? false { print("Request timeout for icmp_seq \(seq)") }
            else { print("64 bytes from \(who): icmp_seq=\(seq) ttl=\(x["ttl"]?.string ?? "") time=\(x["ms"]?.string ?? "") ms") }
        }
        let ok = replies.filter { !($0["lost"]?.bool ?? false) }
        let loss = replies.isEmpty ? 100 : Int((100 - Double(ok.count) / Double(replies.count) * 100).rounded())
        print("", "--- \(target) ping statistics ---", "\(replies.count) packets transmitted, \(ok.count) received, \(loss)% packet loss")
        if !(r["reachable"]?.bool ?? false) { print("Сеть назначения недоступна (Destination Net Unreachable)") }
        if !ok.isEmpty {
            let ms = ok.map { $0["ms"]?.double ?? 0 }
            let avg = ms.reduce(0, +) / Double(ms.count)
            print("rtt min/avg/max = \(JSON.formatNumber(ms.min() ?? 0))/\(String(format: "%.1f", avg))/\(JSON.formatNumber(ms.max() ?? 0)) ms")
        }
        print("")
    }

    private func traceroute(_ args: [String]) async throws {
        guard let target = args.first else { return print("Использование: traceroute <хост>") }
        let r = try await call("/net/traceroute", ["host": target])
        if r["error"] != nil && r["error"] != .null { return print("traceroute: \(target): Name or service not known") }
        print("traceroute to \(target) (\(r["ip"]?.string ?? "")), 30 hops max, 60 byte packets")
        for h in r["hops"]?.array ?? [] {
            let n = h["n"]?.string ?? ""
            let num = String(repeating: " ", count: max(0, 2 - n.count)) + n
            let ms = h["ms"]?.array ?? []
            if h["unreachable"]?.bool ?? false { print("\(num)  * * *   (нет маршрута — !N)") }
            else if ms.isEmpty { print("\(num)  * * *") }
            else {
                let ip = h["ip"]?.string ?? ""
                let nm = h["name"]?.string.map { Self.strip($0) } ?? ip
                print("\(num)  \(nm) (\(ip))  \(ms.map { "\($0.string ?? "") ms" }.joined(separator: "  "))")
            }
        }
        print("")
    }

    private func whois(_ args: [String]) async throws {
        guard let q = args.first else { return print("Использование: whois <домен|ip>") }
        let r: JSON
        do {
            r = try await API.get("/net/whois?q=\(Balnet.encodeComponent(q))")
        } catch let e as APIError {
            throw Failure(message: e.code == "balnet_maintenance" ? "БалНет на обслуживании" : e.message)
        }
        switch r["kind"]?.string ?? "" {
        case "ip":
            var out = ["inetnum:   \(r["cidr"]?.string ?? "")", "netname:   \(r["holder"]?.string ?? "")", "purpose:   \(r["purpose"]?.string ?? "")"]
            if let p = r["provider"]?.string { out.append("provider:  \(p)") }
            print(out + ["source:    BALNET", ""])
        case "domain":
            var out = ["domain:    \((r["name"]?.string ?? "").uppercased())"]
            if let s = r["status"]?.string { out.append("status:    \(s)") }
            if let o = r["owner"]?.string { out.append("registrant: \(o)") }
            out += (r["ns"]?.array ?? []).map { "nserver:   \(Self.strip($0.string))" }
            out.append("registrar: \(r["registrar"]?.string ?? "")")
            if let c = r["created_month"]?.int {
                out.append("created:   \(GameTime.label(c))")
                if let e = r["expires_month"]?.int { out.append("paid-till: \(GameTime.label(e))") }
            } else if let c = r["created_at"]?.string {
                out.append("created:   \(c.prefix(10))")
            }
            print(out + ["source:    BALNET", ""])
        default:
            print("No match for \"\(q)\".", "")
        }
    }

    private func curl(_ args: [String]) async throws {
        let head = args.contains("-I") || args.contains("--head")
        let insecure = args.contains("-k") || args.contains("--insecure")
        guard let raw = args.first(where: { !$0.hasPrefix("-") }) else { return print("Использование: curl [-I] [-k] <адрес>") }
        let url = raw.contains("://") ? raw : "https://\(raw)"
        let host = Balnet.split(url)?.host ?? raw
        let r = try await call("/net/open", ["url": url])
        if r["ip"]?.string == nil { return print("curl: (6) Could not resolve host: \(host)") }
        let code = r["code"]?.string ?? ""
        if code == "ERR_CONNECTION_TIMED_OUT" { return print("curl: (28) Failed to connect to \(host) port 443 after 10000 ms: Timeout was reached") }
        if code == "ERR_CONNECTION_REFUSED" { return print("curl: (7) Failed to connect to \(host) port 443: Connection refused") }
        if code == "ERR_ADDRESS_UNREACHABLE" { return print("curl: (7) Failed to connect to \(host) port 443: No route to host") }
        let ok = r["ok"]?.bool ?? false
        if ok && url.hasPrefix("https:") {
            guard let tls = r["tls"], !tls.isNull else { return print("curl: (7) Failed to connect to \(host) port 443: Connection refused") }
            let v = await NetClient.shared.checkTLS(tls, host: host)
            if !v.ok && !insecure {
                return print("curl: (60) SSL certificate problem: \(v.code ?? "")", "More details here: https://ca.gov.bln/", "", "curl failed to verify the legitimacy of the server. Use -k to skip (небезопасно).")
            }
        }
        var headers = ["HTTP/1.1 \(ok ? "200 OK" : "404 Not Found")", "server: \(Self.strip(r["server"]?.string))", "content-type: text/html; charset=utf-8"]
        if r["gov"]?.bool ?? false { headers += ["strict-transport-security: max-age=31536000; preload", "x-balnet-site: gov"] }
        print(headers + [""])
        if !head { print(ok ? "<!-- \(host): содержимое сайта — откройте адрес во вкладке браузера (open \(host)) -->" : "<h1>404 Not Found</h1>", "") }
    }

    private func openssl(_ args: [String]) async throws {
        guard args.first == "s_client", let i = args.firstIndex(of: "-connect"), i + 1 < args.count else {
            return print("Использование: openssl s_client -connect <хост>[:443]")
        }
        let parts = args[i + 1].split(separator: ":").map(String.init)
        let host = parts.first ?? ""
        let port = parts.count > 1 ? parts[1] : "443"
        if port != "443" { return print("connect: \(host):\(port): Connection refused", "connect:errno=111") }
        let d = try await call("/net/open", ["url": "https://\(host)/"])
        let ip = d["ip"]?.string ?? ""
        if !(d["ok"]?.bool ?? false) { return print("\(d["code"]?.string ?? ""): не удалось подключиться к \(host):443") }
        guard let tls = d["tls"], !tls.isNull else { return print("connect: \(host):443: Connection refused (на сервере \(ip) нет HTTPS)", "connect:errno=111") }
        let v = await NetClient.shared.checkTLS(tls, host: host)
        var out = ["CONNECTED(\(ip):443)", "---", "Certificate chain"]
        for (n, c) in (tls["chain"]?.array ?? []).enumerated() {
            let t = c["tbs"] ?? .null
            let so = t["subject"]?["o"]?.string.map { ", O = \($0)" } ?? ""
            let io = t["issuer"]?["o"]?.string.map { ", O = \($0)" } ?? ""
            out.append(" \(n) s:CN = \(t["subject"]?["cn"]?.string ?? "")\(so)")
            out.append("   i:CN = \(t["issuer"]?["cn"]?.string ?? "")\(io)")
            out.append("   a:ECDSA P-256, sigalg: ecdsa-with-SHA256")
            out.append("   v:NotBefore: \(GameTime.certDate(t["nb"]?.double ?? 0)); NotAfter: \(GameTime.certDate(t["na"]?.double ?? 0))")
        }
        let leaf = tls["chain"]?[0]?["tbs"] ?? .null
        out += ["---", "Server certificate", "subject=CN = \(leaf["subject"]?["cn"]?.string ?? "")", "issuer=CN = \(leaf["issuer"]?["cn"]?.string ?? "")",
                "X509v3 Subject Alternative Name: \((leaf["san"]?.array ?? []).map { "DNS:\($0.string ?? "")" }.joined(separator: ", "))"]
        out += ["Serial: \(leaf["serial"]?.string ?? "")", "Policy: \(leaf["policy"]?.string ?? "")"]
        if let sct = tls["sct"], !sct.isNull { out.append("SCT: log \(sct["log_id"]?.string ?? ""), index \(sct["index"]?.string ?? "")") }
        if let o = tls["ocsp"], !o.isNull {
            out.append("OCSP response: \(o["status"]?.string ?? "")\(o["reason"]?.string.map { " (\($0))" } ?? "")")
        } else {
            out.append("OCSP response: no response sent")
        }
        out += ["---", "New, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256", "Verify return code: \(v.ok ? "0 (ok)" : (v.code ?? ""))", "---", ""]
        print(out)
    }

    private func ipconfig() async throws {
        guard let b = browser else { return }
        let l = try await NetClient.shared.lease(clientId: b.clientId, provider: b.profile.net.provider)
        let custom = b.profile.net.resolver
        print(
            "Провайдер:        \(l.providerName)",
            "IPv4-адрес:       \(l.ip)",
            "Сеть:             \(l.netmask ?? "")",
            "Основной шлюз:    \(l.gateway ?? "")",
            "DNS-сервер:       \(custom ?? l.resolverIP)\(custom != nil ? " (свой)" : " (провайдера)")",
            ""
        )
    }

    // MARK: SSH и nano

    private func sshStart(_ args: [String]) {
        var target: String?
        var login: String?
        var i = 0
        while i < args.count {
            if args[i] == "-l", i + 1 < args.count { login = args[i + 1]; i += 2; continue }
            if args[i] == "-p" { i += 2; continue }
            if !args[i].hasPrefix("-") && target == nil { target = args[i] }
            i += 1
        }
        guard let target else { return print("usage: ssh u<номер>@<сервер>") }
        var user = login ?? ""
        var host = target
        if let at = target.firstIndex(of: "@") {
            user = String(target[..<at])
            host = String(target[target.index(after: at)...])
        }
        ssh = SSHState(session: nil, user: user, host: host)
        print("\(user)@\(host)'s password:")
    }

    private func sshLogin(_ password: String) async throws {
        guard let s = ssh else { return }
        let r = try await call("/net/ssh/login", ["host": s.host, "user": s.user, "password": password])
        if let e = r["error"]?.string {
            ssh = nil
            return print(e)
        }
        ssh = SSHState(session: r["session"]?.string, prompt: r["prompt"]?.string ?? "$", user: s.user, host: s.host)
        print((r["motd"]?.array ?? []).compactMap { $0.string } + [""])
    }

    private func sshExec(_ line: String) async throws {
        guard let s = ssh, let session = s.session else { return }
        let r = try await API.post("/net/ssh/exec", ["session": session, "line": line])
        if let e = r["error"]?.string {
            ssh = nil
            return print(e)
        }
        if let out = r["out"] {
            switch out {
            case .array(let a): print(a.compactMap { $0.string })
            case .string(let t): print(t.components(separatedBy: "\n"))
            default: break
            }
        }
        if r["exit"]?.bool ?? false {
            let host = s.prompt.split(separator: "@").dropFirst().first?.split(separator: ":").first.map(String.init) ?? s.host
            ssh = nil
            return print("Connection to \(host) closed.")
        }
        if let ed = r["edit"], let path = ed["path"]?.string {
            let content = ed["content"]?.string ?? ""
            editor = Editor(path: path, content: content, saved: content)
        }
        ssh?.prompt = r["prompt"]?.string ?? s.prompt
    }

    func saveEditor() async {
        guard let e = editor, let session = ssh?.session else { return }
        do {
            let r = try await API.post("/net/ssh/save", ["session": session, "path": e.path, "content": e.content])
            if let err = r["error"]?.string { throw Failure(message: err) }
            editor?.saved = e.content
            print("[ Записано \(r["bytes"]?.string ?? "") байт в \(e.path) ]")
        } catch {
            print("Ошибка: \(error.localizedDescription)")
        }
    }

    func historyItem(_ pos: Int) -> String? {
        pos >= 0 && pos < history.count ? history[pos] : nil
    }
}
