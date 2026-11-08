import Foundation
import Observation
import UIKit
import WebKit

/// Что показывает вкладка сейчас.
enum Phase: Equatable {
    /// Внутренняя страница balnet://…
    case page
    case loading
    case failed(code: String, host: String, ip: String?, dns: JSON?)
    case maintenance
    case certError(CertVerdict)
    case done
}

/// Подключение к сайту: по нему ставится значок у адреса.
struct Conn: Equatable {
    var ok: Bool
    var gov: Bool
    var ip: String?
    var host: String
    var cert: CertVerdict?
    var tls: JSON?
}

/// Что загружено в WebView вкладки.
enum SiteSession: Equatable {
    case gov(app: String)
    case site(ticket: String, origin: String)
}

enum WebKind: Equatable {
    case gov
    case site
}

/// Запись DevTools → Network.
struct NetEntry: Identifiable {
    let id = UUID()
    let date = Date()
    var url: String
    var host: String
    var failed: String?
    var message: String?
    var total: Int
    var data: JSON?
    var cert: CertVerdict?
    var lease: Lease?
    var note: String?
}

struct ConsoleLine: Identifiable {
    let id = UUID()
    let date = Date()
    var level: String
    var text: String
}

/// Состояние вкладки, которое не сохраняется: WebView, подключение, журналы DevTools.
@Observable
@MainActor
final class TabRuntime {
    let id: String
    var phase: Phase = .page
    var conn: Conn?
    var session: SiteSession?
    /// scheme|host|номер перезагрузки — новый запрос в сеть только при смене хоста или перезагрузке.
    var key: String?
    var reloadCount = 0
    var loadToken = UUID()
    var progress: Double = 0
    var isLoading = false
    var netLog: [NetEntry] = []
    var console: [ConsoleLine] = []
    var snapshot: UIImage?
    /// Приложение госсайта, которое сейчас открыто в WebView (папка: bank, services…).
    var govApp: String?

    /// Терминал вкладки balnet://terminal — живёт, пока открыта вкладка.
    @ObservationIgnored private var terminalEngine: TerminalEngine?
    var terminal: TerminalEngine {
        if let t = terminalEngine { return t }
        let t = TerminalEngine()
        terminalEngine = t
        return t
    }

    @ObservationIgnored var webView: WKWebView?
    @ObservationIgnored var webKind: WebKind?
    @ObservationIgnored var coordinator: WebCoordinator?
    /// Меняется, когда WebView вкладки заменён — SwiftUI перерисовывает контейнер.
    var webGeneration = 0

    init(id: String) {
        self.id = id
    }

    func log(_ e: NetEntry) {
        netLog.append(e)
        if netLog.count > 200 { netLog.removeFirst(netLog.count - 200) }
    }

    func addConsole(_ level: String, _ text: String) {
        console.append(ConsoleLine(level: level, text: text))
        if console.count > 500 { console.removeFirst(console.count - 500) }
    }

    func dropWebView() {
        webView?.stopLoading()
        if let wv = webView {
            for name in ["balnetConsole", "balnetGov"] { wv.configuration.userContentController.removeScriptMessageHandler(forName: name) }
            wv.configuration.userContentController.removeScriptMessageHandler(forName: "balnet", contentWorld: .defaultClient)
        }
        coordinator?.observations.removeAll()
        webView = nil
        webKind = nil
        coordinator = nil
        govApp = nil
        webGeneration += 1
    }
}
