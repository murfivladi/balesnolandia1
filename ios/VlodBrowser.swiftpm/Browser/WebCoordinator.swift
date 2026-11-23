import Foundation
import WebKit

/// Слабая ссылка на получателя сообщений: WKUserContentController держит обработчики сильно.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebCoordinator?
    init(_ target: WebCoordinator) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let name = message.name
        let body = JSON.from(any: message.body)
        Task { @MainActor [weak target] in target?.received(name: name, body: body) }
    }
}

/// Ответы госсайту на window.__balnetNative (Face ID, PIN карты) — с обещанием в JS.
final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WebCoordinator?
    init(_ target: WebCoordinator) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let body = JSON.from(any: message.body)
        Task { @MainActor [weak target] in
            guard let co = target, let browser = co.browser else { replyHandler(nil, nil); return }
            let r = await browser.nativeRequest(tabId: co.tabId, body)
            replyHandler(r.isNull ? nil : r.any, nil)
        }
    }
}

/// Делегат WebView одной вкладки: какие переходы разрешены, адрес и заголовок, сообщения страниц.
@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var browser: Browser?
    let tabId: String
    let kind: WebKind
    var observations: [NSKeyValueObservation] = []

    init(browser: Browser, tabId: String, kind: WebKind) {
        self.browser = browser
        self.tabId = tabId
        self.kind = kind
    }

    // MARK: Создание WebView

    static func makeWebView(kind: WebKind, browser: Browser, tabId: String, dataStore: WKWebsiteDataStore, theme: String) -> (WKWebView, WebCoordinator) {
        let co = WebCoordinator(browser: browser, tabId: tabId, kind: kind)
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = dataStore
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.preferredContentMode = .mobile
        let ucc = cfg.userContentController
        let handler = WeakHandler(co)
        ucc.add(handler, name: "balnetConsole")
        ucc.addUserScript(WKUserScript(source: Scripts.console, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        switch kind {
        case .gov:
            ucc.add(handler, name: "balnetGov")
            ucc.addScriptMessageHandler(WeakReplyHandler(co), contentWorld: .page, name: "balnetNative")
            ucc.addUserScript(WKUserScript(source: Scripts.native, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            ucc.addUserScript(WKUserScript(source: Scripts.theme(theme), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            ucc.addUserScript(WKUserScript(source: Scripts.govOpen, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        case .site:
            ucc.add(handler, contentWorld: .defaultClient, name: "balnet")
            ucc.addUserScript(WKUserScript(source: Scripts.siteBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        }
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = true
        wv.navigationDelegate = co
        wv.uiDelegate = co
        wv.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) VlodBrowser/\(Config.version) Mobile/15E148"
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        co.observations = [
            wv.observe(\.url, options: [.new]) { [weak co] w, _ in
                let u = w.url
                Task { @MainActor in co?.urlChanged(u) }
            },
            wv.observe(\.title, options: [.new]) { [weak co] w, _ in
                let t = w.title
                Task { @MainActor in co?.titleChanged(t) }
            },
            wv.observe(\.estimatedProgress, options: [.new]) { [weak co] w, _ in
                let p = w.estimatedProgress
                let l = w.isLoading
                Task { @MainActor in co?.progressChanged(p, loading: l) }
            },
        ]
        return (wv, co)
    }

    // MARK: Наблюдение

    func urlChanged(_ url: URL?) {
        guard let url, let browser else { return }
        browser.webURLChanged(tabId: tabId, kind: kind, url: url)
    }

    func titleChanged(_ title: String?) {
        guard let title, !title.isEmpty else { return }
        browser?.setTitle(tabId: tabId, title: String(title.prefix(200)))
    }

    func progressChanged(_ p: Double, loading: Bool) {
        guard let rt = browser?.runtimes[tabId] else { return }
        rt.progress = p
        rt.isLoading = loading
    }

    func received(name: String, body: JSON) {
        guard let browser else { return }
        switch name {
        case "balnetConsole":
            browser.runtimes[tabId]?.addConsole(body["level"]?.string ?? "log", body["text"]?.string ?? "")
        case "balnetGov":
            if body["type"]?.string == "open", let url = body["url"]?.string {
                browser.openFromPage(tabId: tabId, raw: url, newTab: body["newTab"]?.bool ?? false)
            }
        case "balnet":
            browser.siteMessage(tabId: tabId, body)
        default:
            break
        }
    }

    // MARK: Политика переходов: только госсайты и шлюз БалНета

    private func allowed(_ url: URL, mainFrame: Bool) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "data", "blob"].contains(scheme) { return true }
        guard scheme == "https", let host = url.host?.lowercased() else { return false }
        switch kind {
        case .gov:
            return host == Config.siteHost || (!mainFrame && host == Config.apiHost)
        case .site:
            return host == Config.apiHost && url.path.hasPrefix("/api/net/")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        let main = action.targetFrame?.isMainFrame ?? true
        // <a download>, blob: и data: — загрузка файла (чек, выписка), а не переход.
        if action.shouldPerformDownload { return .download }
        // Госсайт открыл файл с API игры (картинка чека, PDF) — тоже загрузка.
        if main, kind == .gov, url.host?.lowercased() == Config.apiHost { return .allow }
        if allowed(url, mainFrame: main) { return .allow }
        if main {
            browser?.runtimes[tabId]?.addConsole("warn", "Переход заблокирован (только БалНет): \(url.absoluteString)")
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        guard response.isForMainFrame else { return .allow }
        let host = response.response.url?.host?.lowercased()
        if kind == .gov && host == Config.apiHost { return .download }
        let http = response.response as? HTTPURLResponse
        let disposition = (http?.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased()
        if !response.canShowMIMEType || disposition.hasPrefix("attachment") { return .download }
        return .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        browser?.downloads.start(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        browser?.downloads.start(download)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        browser?.runtimes[tabId]?.addConsole("error", "Не удалось загрузить страницу: \(error.localizedDescription)")
        if ns.domain == NSURLErrorDomain {
            browser?.webLoadFailed(tabId: tabId, message: error.localizedDescription)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        browser?.runtimes[tabId]?.addConsole("error", error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        browser?.runtimes[tabId]?.addConsole("error", "Процесс страницы завершился — перезагрузка")
        webView.reload()
    }

    /// target=_blank и window.open: новая вкладка браузера, а не новое окно WebKit.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, let browser else { return nil }
        if kind == .gov, url.host?.lowercased() == Config.siteHost {
            let path = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            let app = path.split(separator: "/").first.map(String.init) ?? ""
            if let balnet = Balnet.govURL(app: app, hash: url.fragment ?? "") {
                browser.navigate(balnet, newTab: true, referrer: browser.tab(tabId)?.url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        await browser?.dialogs.alert(host: hostLabel, message: message)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await browser?.dialogs.confirm(host: hostLabel, message: message) ?? false
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await browser?.dialogs.prompt(host: hostLabel, message: prompt, defaultText: defaultText ?? "")
    }

    private var hostLabel: String {
        guard let url = browser?.tab(tabId)?.url, let p = Balnet.split(url) else { return "Страница" }
        return p.host
    }
}
