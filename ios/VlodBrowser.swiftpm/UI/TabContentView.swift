import SwiftUI
import WebKit

/// Содержимое вкладки: внутренняя страница, подключение, ошибка или сайт в WebView.
struct TabContentView: View {
    @EnvironmentObject private var browser: Browser
    let tab: Tab
    @ObservedObject var runtime: TabRuntime

    var body: some View {
        switch runtime.phase {
        case .page:
            internalPage
        case .loading:
            VStack(spacing: 12) {
                ProgressView()
                Text("Подключение к \(Balnet.split(tab.url)?.host ?? "")…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let code, let host, let ip, let dns):
            ErrorPageView(code: code, host: host, ip: ip, dns: dns) { browser.reload(tab.id) }
        case .maintenance:
            MaintenanceView { browser.refreshStatus(); browser.reload(tab.id) }
        case .certError(let v):
            CertErrorView(host: Balnet.split(tab.url)?.host ?? "", verdict: v, tls: runtime.conn?.tls,
                          onBack: { browser.navigate(Balnet.newTab, tabId: tab.id) },
                          onProceed: { browser.proceedUnsafe(tab.id, host: Balnet.split(tab.url)?.host ?? "", hash: v.hash) })
        case .unsafe(let v):
            SafeBrowsingView(host: Balnet.split(tab.url)?.host ?? "", url: tab.url, verdict: v,
                             onBack: { browser.navigate(Balnet.newTab, tabId: tab.id) },
                             onProceed: {
                                 SafeBrowsing.bypass.insert(Balnet.split(tab.url)?.host ?? "")
                                 browser.reload(tab.id)
                             })
        case .done:
            WebContainer(runtime: runtime, generation: runtime.webGeneration)
                .ignoresSafeArea(.container, edges: .bottom)
                .overlay {
                    if browser.isBank(tab) && browser.bankLockEnabled && !browser.bankUnlocked && !browser.incognito { BankLockView() }
                }
        }
    }

    @ViewBuilder private var internalPage: some View {
        switch Balnet.resolve(tab.url) {
        case .internal(let page, _):
            switch page {
            case "newtab": NewTabView()
            case "history": HistoryView()
            case "bookmarks": BookmarksView()
            case "settings": SettingsView()
            case "about": AboutView()
            case "terminal": TerminalView(engine: runtime.terminal)
            case "downloads": DownloadsView(downloads: browser.downloads)
            case "passwords": PasswordsView()
            default: ErrorPageView(code: "ERR_INVALID_URL", host: "", ip: nil, dns: nil) {}
            }
        default:
            Color.clear
        }
    }
}

/// WKWebView вкладки внутри SwiftUI. Один и тот же WebView живёт в runtime и переносится между контейнерами.
struct WebContainer: UIViewRepresentable {
    let runtime: TabRuntime
    let generation: Int

    func makeUIView(context: Context) -> ContainerView { ContainerView() }

    func updateUIView(_ view: ContainerView, context: Context) {
        view.show(runtime.webView)
    }
}

final class ContainerView: UIView {
    private weak var current: WKWebView?

    func show(_ wv: WKWebView?) {
        if current === wv && wv?.superview === self { return }
        current?.removeFromSuperview()
        current = wv
        guard let wv else { return }
        wv.frame = bounds
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(wv)
    }
}

// MARK: Страницы ошибок

struct ErrorPageView: View {
    let code: String
    let host: String
    let ip: String?
    let dns: JSON?
    let onReload: () -> Void
    @State private var details = false

    var body: some View {
        let e = NetErrorText.of(code)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: code.hasPrefix("DNS") || code.contains("NAME") ? "questionmark.folder" : "wifi.exclamationmark")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text(e.title).font(.title2.bold())
                Text(e.text(host))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Что можно сделать:").font(.subheadline.bold())
                    ForEach(e.tips, id: \.self) { Text("• \($0)").font(.subheadline) }
                }
                Text(code).font(.caption.monospaced()).foregroundStyle(.secondary)
                if let ip { Text("IP-адрес сервера: \(ip)").font(.caption.monospaced()).foregroundStyle(.secondary) }
                if let dns, !dns.isNull {
                    DisclosureGroup("Ответ DNS", isExpanded: $details) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Резолвер: \(dns["resolver"]?["name"]?.string ?? "") \(dns["resolver"]?["ip"]?.string ?? "")")
                            Text("Код ответа: \(dns["rcode"]?.string ?? "")")
                            if let ede = dns["ede"]?.string { Text(ede).foregroundStyle(Theme.danger) }
                        }
                        .font(.caption.monospaced())
                    }
                }
                Button("Перезагрузить", action: onReload)
                    .buttonStyle(.borderedProminent)
                if code == "ERR_BALNET_UNREACHABLE" || code == "ERR_INTERNET_DISCONNECTED" {
                    Text("Пока ждёте — сыграйте в «Курьера БалНета»").font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
                    CourierGameView()
                }
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }
}

struct MaintenanceView: View {
    let onReload: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "pause.circle").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("БалНет на обслуживании").font(.title2.bold())
            Text("Игровое время на паузе — сайты временно не открываются. Загляните чуть позже.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Проверить снова", action: onReload).buttonStyle(.borderedProminent)
            CourierGameView().padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// «Ваше подключение не защищено».
struct CertErrorView: View {
    let host: String
    let verdict: CertVerdict
    let tls: JSON?
    let onBack: () -> Void
    let onProceed: () -> Void
    @State private var advanced = false
    @State private var showCert = false

    private var explain: String {
        switch verdict.code ?? "" {
        case "ERR_CERT_AUTHORITY_INVALID": return "Сервер не смог доказать, что это \(host): его сертификат выдан центром, которому ВлодБраузер не доверяет. Это бывает при самоподписанном сертификате или если кто-то перехватывает соединение."
        case "ERR_CERT_COMMON_NAME_INVALID": return "Сервер не смог доказать, что это \(host): сертификат выдан для \(verdict.san.isEmpty ? "другого имени" : verdict.san.joined(separator: ", "))."
        case "ERR_CERT_DATE_INVALID": return "Сервер не смог доказать, что это \(host): срок сертификата истёк или ещё не начался."
        case "ERR_CERT_REVOKED": return "Сертификат сайта \(host) отозван выпустившим его центром — скорее всего, его ключ украден."
        case "ERR_CERT_INVALID": return "Сертификат сайта \(host) повреждён или подделан: подпись центра сертификации не сходится."
        case "ERR_CERTIFICATE_TRANSPARENCY_REQUIRED": return "Сертификат сайта \(host) не записан в журнал прозрачности. ВлодБраузер принимает только публично записанные сертификаты."
        default: return "\(PKI.errors[verdict.code ?? ""] ?? "Ошибка сертификата") (\(host))."
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 44)).foregroundStyle(Theme.danger)
                Text("Ваше подключение не защищено").font(.title2.bold())
                Text("Злоумышленники могут пытаться похитить ваши данные с сайта **\(host)** (например, пароли, сообщения или номера карт).")
                Button(verdict.code ?? "ERR_CERT_INVALID") { showCert = true }
                    .font(.caption.monospaced())
                HStack {
                    Button(advanced ? "Скрыть подробности" : "Дополнительные") { advanced.toggle() }
                        .buttonStyle(.bordered)
                    Button("Вернуться к безопасной странице", action: onBack)
                        .buttonStyle(.borderedProminent)
                }
                if advanced {
                    Text(explain)
                    if Balnet.hstsPreload.contains(host) {
                        Text("Сейчас вы не можете перейти на сайт \(host): он использует HSTS (строгую защиту соединения). Ошибки сети и атаки обычно временные — попробуйте позже.")
                    } else {
                        Button("Перейти на сайт \(host) (небезопасно)", role: .destructive, action: onProceed)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .sheet(isPresented: $showCert) {
            CertViewer(tls: tls, verdict: verdict, host: host)
        }
    }
}

/// Просмотр сертификата и цепочки.
struct CertViewer: View {
    let tls: JSON?
    let verdict: CertVerdict?
    let host: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let v = verdict {
                    Section("Проверка") {
                        LabeledContent("Итог", value: v.ok ? "действителен" : (v.code ?? "ошибка"))
                        if let i = v.issuer { LabeledContent("Издатель", value: i) }
                        LabeledContent("Вид", value: v.policy + (v.org.map { ", \($0)" } ?? ""))
                        if let ct = v.ctIndex { LabeledContent("CT", value: "запись № \(ct)") }
                        LabeledContent("OCSP", value: v.ocsp ?? "нет ответа")
                    }
                }
                ForEach(Array((tls?["chain"]?.array ?? []).enumerated()), id: \.offset) { n, c in
                    let t = c["tbs"] ?? .null
                    Section(n == 0 ? "Сертификат сайта" : "Издатель \(n)") {
                        LabeledContent("Кому", value: t["subject"]?["cn"]?.string ?? "")
                        if let o = t["subject"]?["o"]?.string { LabeledContent("Организация", value: o) }
                        LabeledContent("Кем выдан", value: t["issuer"]?["cn"]?.string ?? "")
                        LabeledContent("Имена", value: (t["san"]?.array ?? []).compactMap { $0.string }.joined(separator: ", "))
                        LabeledContent("Действует", value: "\(GameTime.certDate(t["nb"]?.double ?? 0)) — \(GameTime.certDate(t["na"]?.double ?? 0))")
                        LabeledContent("Серийный номер", value: t["serial"]?.string ?? "")
                        LabeledContent("Политика", value: t["policy"]?.string ?? "")
                        LabeledContent("Ключ", value: "ECDSA P-256")
                    }
                }
            }
            .navigationTitle(host)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
    }
}

/// Код страницы (view-source).
struct SourceView: View {
    let text: String
    let url: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("view-source:\(Balnet.display(url))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { ShareLink(item: text) }
                ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } }
            }
        }
    }
}

/// Красная страница Безопасного просмотра.
struct SafeBrowsingView: View {
    let host: String
    let url: String
    let verdict: SafeBrowsing.Verdict
    let onBack: () -> Void
    let onProceed: () -> Void
    @State private var advanced = false

    var body: some View {
        let t = SafeBrowsing.threats[verdict.threat] ?? SafeBrowsing.threats["phishing"]!
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "xmark.octagon.fill").font(.system(size: 48)).foregroundStyle(.white)
                Text(t.title).font(.title.bold())
                Text(t.text)
                Text("Сайт **\(host)** в списке Безопасного просмотра ВлодПоиска.")
                HStack {
                    Button(advanced ? "Скрыть подробности" : "Подробнее") { advanced.toggle() }
                        .buttonStyle(.bordered)
                        .tint(.white)
                    Button("Вернуться к безопасной странице", action: onBack)
                        .buttonStyle(.borderedProminent)
                        .tint(.white)
                        .foregroundStyle(Theme.danger)
                }
                if advanced {
                    Text("ВлодПоиск недавно обнаружил \(verdict.threat == "phishing" ? "фишинг" : "опасное содержимое") на этом сайте (запись «\(verdict.expr)»). Такие сайты выдают себя за другие — например, за ВлодБанк, — чтобы украсть пароли и данные карт.")
                    Text("Владелец сайта может исправить проблему и запросить проверку в кабинете вебмастера ВлодПоиска.")
                    Button("Перейти на этот небезопасный сайт", action: onProceed).underline()
                    Text("Адрес: \(url)").font(.caption).opacity(0.8)
                }
            }
            .foregroundStyle(.white)
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.danger.ignoresSafeArea())
    }
}
