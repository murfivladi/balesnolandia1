import SwiftUI
import WebKit

/// Инструменты разработчика: Network, Консоль, Элементы, Хранилище.
struct DevToolsView: View {
    @EnvironmentObject private var browser: Browser
    let tab: Tab
    @ObservedObject var runtime: TabRuntime
    @State private var section = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Раздел", selection: $section) {
                    Text("Network").tag(0)
                    Text("Консоль").tag(1)
                    Text("Элементы").tag(2)
                    Text("Хранилище").tag(3)
                }
                .pickerStyle(.segmented)
                .padding(8)
                switch section {
                case 0: NetworkPanel(runtime: runtime)
                case 1: ConsolePanel(runtime: runtime)
                case 2: ElementsPanel(runtime: runtime)
                default: StoragePanel(tab: tab, runtime: runtime)
                }
            }
            .navigationTitle("DevTools · \(Balnet.split(tab.url)?.host ?? "")")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

// MARK: Network

private struct NetworkPanel: View {
    @ObservedObject var runtime: TabRuntime

    var body: some View {
        List {
            if runtime.netLog.isEmpty {
                Text("Переходов пока не было. Откройте сайт — здесь появятся DNS-запросы, TLS и тайминг.").foregroundStyle(.secondary)
            }
            ForEach(runtime.netLog.reversed()) { e in
                NavigationLink {
                    NetDetails(e: e)
                } label: {
                    HStack {
                        Text(status(e)).font(.caption.monospaced().bold()).foregroundStyle(bad(e) ? Theme.danger : Theme.gov).frame(width: 64, alignment: .leading)
                        VStack(alignment: .leading) {
                            Text(Balnet.display(e.url)).font(.caption).lineLimit(1)
                            Text("\(e.data?["ip"]?.string ?? "—") · \(e.total) мс").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func status(_ e: NetEntry) -> String {
        if let f = e.failed { return f == "maintenance" ? "503" : "(failed)" }
        if e.data?["ok"]?.bool == true { return e.note != nil ? "307" : "200" }
        return e.data?["code"]?.string.map { _ in "(failed)" } ?? "(failed)"
    }

    private func bad(_ e: NetEntry) -> Bool { e.failed != nil || e.data?["ok"]?.bool != true }
}

private struct NetDetails: View {
    let e: NetEntry

    var body: some View {
        let d = e.data ?? .null
        let dns = d["dns"] ?? .null
        let t = d["timing"] ?? .null
        List {
            Section("Общее") {
                row("URL", e.url)
                row("Статус", e.failed ?? d["code"]?.string ?? "200 OK")
                if let ip = d["ip"]?.string { row("Удалённый адрес", ip + (d["server"]?.string.map { " (\($0.hasSuffix(".") ? String($0.dropLast()) : $0))" } ?? "")) }
                if let c = d["client_ip"]?.string ?? e.lease?.ip { row("Ваш адрес", c) }
                if let target = d["target"]?.string { row("Сайт на сервере", target + ((d["gov"]?.bool ?? false) ? " — госсайт" : "")) }
                if let m = e.message { row("Ошибка", m) }
                if let n = e.note { row("Примечание", n) }
            }
            if e.url.hasPrefix("https:") && e.failed == nil {
                Section("Безопасность") {
                    if d["tls"] == nil || d["tls"] == .null {
                        Text("На сервере нет HTTPS (сертификат не установлен).")
                    }
                    if let c = e.cert {
                        row("Сертификат", c.ok ? "действителен" : (c.code ?? "ошибка"))
                        row("Кому", c.san.joined(separator: ", "))
                        if let i = c.issuer { row("Издатель", i) }
                        row("Вид", c.policy + (c.org.map { ", \($0)" } ?? ""))
                        if let ct = c.ctIndex { row("CT", "запись № \(ct)") }
                        row("OCSP", c.ocsp ?? "нет ответа")
                        row("Шифрование", "TLS 1.3, ECDHE + ECDSA P-256")
                    }
                }
            }
            if !t.isNull {
                Section("Тайминг (сеть БалНета)") {
                    row("DNS", "\(t["dns"]?.int ?? 0) мс")
                    row("Подключение", "\(t["connect"]?.int ?? 0) мс")
                    row("Сервер игры (реально)", "\(e.total) мс")
                }
            }
            if !dns.isNull {
                Section("DNS: \(dns["qname"]?.string ?? "") \(dns["qtype"]?.string ?? "") → \(dns["rcode"]?.string ?? "")\((dns["cached"]?.bool ?? false) ? " (из кэша)" : "")") {
                    if let ede = dns["ede"]?.string { Text(ede).foregroundStyle(Theme.danger) }
                    row("Резолвер", "\(dns["resolver"]?["name"]?.string ?? "") \(dns["resolver"]?["ip"]?.string ?? ""), \(dns["ms"]?.int ?? 0) мс")
                    if dns["ad"]?.bool ?? false { row("DNSSEC", "подписано (AD)") }
                    ForEach(Array((dns["trace"]?.array ?? []).enumerated()), id: \.offset) { i, s in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(i + 1). \(s["server_name"]?.string ?? "") (\(s["server"]?.string ?? ""))").font(.caption.monospaced().bold())
                            Text("\(s["kind"]?.string ?? "") \(s["zone"]?.string ?? "")").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(Array((dns["answer"]?.array ?? []).enumerated()), id: \.offset) { _, rr in
                        Text(TerminalEngine.formatRR(rr)).font(.caption2.monospaced())
                    }
                }
            }
        }
        .navigationTitle(Balnet.split(e.url)?.host ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ k: String, _ v: String) -> some View {
        LabeledContent(k) { Text(v).font(.caption.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing) }
    }
}

// MARK: Консоль

private struct ConsolePanel: View {
    @ObservedObject var runtime: TabRuntime
    @State private var code = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List {
                    ForEach(runtime.console) { l in
                        Text(l.text)
                            .font(.caption.monospaced())
                            .foregroundStyle(color(l.level))
                            .textSelection(.enabled)
                            .listRowBackground(l.level == "error" ? Theme.danger.opacity(0.08) : (l.level == "warn" ? Theme.gold.opacity(0.1) : Color.clear))
                            .id(l.id)
                    }
                }
                .listStyle(.plain)
                .onChange(of: runtime.console.count) { _ in
                    if let last = runtime.console.last { proxy.scrollTo(last.id) }
                }
            }
            HStack {
                Text("›").font(.body.monospaced()).foregroundStyle(Theme.accent)
                TextField("JavaScript", text: $code)
                    .font(.caption.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(run)
                Button("Очистить") { runtime.console = [] }.font(.caption)
            }
            .padding(8)
            .background(Color(uiColor: .secondarySystemBackground))
        }
    }

    private func color(_ level: String) -> Color {
        switch level {
        case "error": return Theme.danger
        case "warn": return Theme.gold
        case "result": return Theme.accent
        default: return .primary
        }
    }

    private func run() {
        let js = code
        guard !js.isEmpty else { return }
        code = ""
        runtime.addConsole("input", "› " + js)
        guard let wv = runtime.webView else {
            runtime.addConsole("error", "На этой вкладке нет страницы")
            return
        }
        wv.evaluateJavaScript(js, in: nil, in: .page) { result in
            switch result {
            case .success(let v): runtime.addConsole("result", String(describing: v))
            case .failure(let e): runtime.addConsole("error", (e as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? e.localizedDescription)
            }
        }
    }
}

// MARK: Элементы

private struct DomNode: Identifiable {
    let id = UUID()
    let tag: String
    let attrs: [(String, String)]
    let text: String?
    let children: [DomNode]?

    init(_ j: JSON) {
        tag = j["t"]?.string ?? ""
        attrs = (j["a"]?.array ?? []).map { ($0[0]?.string ?? "", $0[1]?.string ?? "") }
        text = j["x"]?.string
        let c = (j["c"]?.array ?? []).map(DomNode.init)
        children = c.isEmpty ? nil : c
    }
}

private struct ElementsPanel: View {
    @ObservedObject var runtime: TabRuntime
    @State private var root: DomNode?
    @State private var error: String?

    var body: some View {
        Group {
            if let root {
                List([root], children: \.children) { n in
                    nodeLabel(n)
                }
                .listStyle(.plain)
            } else if let error {
                Text(error).foregroundStyle(.secondary).padding()
            } else {
                ProgressView().padding()
            }
            Spacer(minLength: 0)
        }
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button { load() } label: { Image(systemName: "arrow.clockwise") } } }
        .onAppear(perform: load)
    }

    @ViewBuilder private func nodeLabel(_ n: DomNode) -> some View {
        if n.tag.hasPrefix("#") {
            Text(n.tag == "#comment" ? "<!-- \(n.text ?? "") -->" : (n.text ?? ""))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(3)
        } else {
            (Text("<\(n.tag)").foregroundColor(Theme.danger)
             + Text(n.attrs.map { " \($0.0)=\"\($0.1)\"" }.joined()).foregroundColor(Theme.gold)
             + Text(">").foregroundColor(Theme.danger))
                .font(.caption.monospaced())
                .lineLimit(3)
                .textSelection(.enabled)
        }
    }

    private func load() {
        guard let wv = runtime.webView else { error = "На этой вкладке нет страницы"; return }
        wv.evaluateJavaScript(Scripts.domTree, in: nil, in: .defaultClient) { result in
            switch result {
            case .success(let v):
                if let s = v as? String, let j = JSON.parse(Data(s.utf8)) { root = DomNode(j); error = nil } else { error = "Пустая страница" }
            case .failure(let e):
                error = e.localizedDescription
            }
        }
    }
}

// MARK: Хранилище

private struct StoragePanel: View {
    @EnvironmentObject private var browser: Browser
    let tab: Tab
    @ObservedObject var runtime: TabRuntime
    @State private var page: JSON?
    @State private var cookies: [HTTPCookie] = []

    var body: some View {
        List {
            if case .site(_, let origin)? = runtime.session {
                let jar = browser.jar(for: origin) ?? .null
                Section("Cookies (\(origin))") {
                    let c = jar["cookies"]?.object ?? [:]
                    if c.isEmpty { Text("нет").foregroundStyle(.secondary) }
                    ForEach(c.keys.sorted(), id: \.self) { k in
                        kv(k, (c[k]?["v"]?.string ?? "") + ((c[k]?["h"]?.bool ?? false) ? "  · HttpOnly" : ""))
                    }
                }
                Section("localStorage") {
                    let l = jar["local"]?.object ?? [:]
                    if l.isEmpty { Text("нет").foregroundStyle(.secondary) }
                    ForEach(l.keys.sorted(), id: \.self) { k in kv(k, l[k]?.compact ?? "") }
                }
                Section {
                    Text("Сайты игроков работают в песочнице шлюза: их cookies и localStorage хранит ВлодБраузер и передаёт серверу сайта при открытии.").font(.footnote).foregroundStyle(.secondary)
                }
            } else if runtime.session != nil {
                Section("Cookies госсайтов") {
                    if cookies.isEmpty { Text("нет").foregroundStyle(.secondary) }
                    ForEach(cookies, id: \.self) { c in
                        kv("\(c.name) · \(c.domain)", c.isHTTPOnly ? "(HttpOnly, значение скрыто)" : c.value)
                    }
                }
                Section("localStorage") {
                    let l = page?["local"]?.object ?? [:]
                    if l.isEmpty { Text("нет").foregroundStyle(.secondary) }
                    ForEach(l.keys.sorted(), id: \.self) { k in kv(k, l[k]?.compact ?? "") }
                }
                Section("sessionStorage") {
                    let l = page?["session"]?.object ?? [:]
                    if l.isEmpty { Text("нет").foregroundStyle(.secondary) }
                    ForEach(l.keys.sorted(), id: \.self) { k in kv(k, l[k]?.compact ?? "") }
                }
            } else {
                Text("На этой вкладке нет сайта.").foregroundStyle(.secondary)
            }
        }
        .onAppear(perform: load)
    }

    private func kv(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption.monospaced().bold())
            Text(v).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(4).textSelection(.enabled)
        }
    }

    private func load() {
        guard case .gov? = runtime.session, let wv = runtime.webView else { return }
        wv.evaluateJavaScript(Scripts.storage, in: nil, in: .defaultClient) { result in
            if case .success(let v) = result, let s = v as? String { page = JSON.parse(Data(s.utf8)) }
        }
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { all in
            cookies = all.filter { $0.domain.contains("vladislavb.qzz.io") }.sorted { $0.name < $1.name }
        }
    }
}
