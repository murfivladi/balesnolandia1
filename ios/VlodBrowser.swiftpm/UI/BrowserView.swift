import SwiftUI

/// Оболочка браузера в стиле Chrome для iOS: на iPhone — адрес сверху или снизу и панель кнопок, на iPad — полоса вкладок.
struct BrowserView: View {
    @EnvironmentObject private var browser: Browser
    @Environment(\.horizontalSizeClass) private var hSize
    @State private var showGrid = false
    @State private var showDevTools = false
    @State private var sourceText: String?
    @State private var showProfiles = false
    @State private var screenshotWarning = false
    @Environment(\.scenePhase) private var scenePhase

    private var wide: Bool { hSize == .regular }

    var body: some View {
        VStack(spacing: 0) {
            StatusStrip()
            if wide {
                TabStrip(showGrid: $showGrid)
                toolbarRow
                Divider()
            } else if !browser.settings.addressBarBottom {
                toolbarRow
                Divider()
            }
            if let u = browser.update {
                UpdateBanner(version: u.version, url: u.url)
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottom) { PromptBar(downloads: browser.downloads) }
            if !wide {
                Divider()
                if browser.settings.addressBarBottom { toolbarRow }
                bottomBar
            }
        }
        .background(Color(uiColor: .systemBackground))
        .fullScreenCover(isPresented: $showGrid) {
            TabGridView(isPresented: $showGrid)
                .environmentObject(browser)
        }
        .sheet(isPresented: $showDevTools) {
            if let t = browser.activeTab {
                DevToolsView(tab: t, runtime: browser.runtime(t.id))
                    .environmentObject(browser)
                    .presentationDetents([.medium, .large])
                    .interactiveSheetBackground()
            }
        }
        .sheet(item: Binding(get: { sourceText.map { SourceText(text: $0) } }, set: { sourceText = $0?.text })) { s in
            SourceView(text: s.text, url: browser.activeTab?.url ?? "")
        }
        .sheet(isPresented: $showProfiles) {
            ProfilesView().environmentObject(browser)
        }
        .modifier(DialogHost(dialogs: browser.dialogs))
        .onAppear {
            browser.activateCurrent()
            browser.refreshStatus()
            browser.checkUpdate()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                browser.refreshStatus()
            }
        }
        .onChange(of: browser.settings.theme) { _ in browser.applyTheme() }
        // Приватность банка: в переключателе приложений — размытие, после возврата — снова Face ID.
        .overlay {
            if scenePhase != .active && browser.isBank(browser.activeTab) { PrivacyCover() }
        }
        .onChange(of: scenePhase) { p in
            if p == .background { browser.bankUnlocked = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            if browser.isBank(browser.activeTab) { screenshotWarning = true }
        }
        .alert("Снимок экрана с банком", isPresented: $screenshotWarning) {
            Button("Понятно", role: .cancel) {}
        } message: {
            Text("На снимке могут быть номер карты и баланс. Не пересылайте его и удалите из «Фото», если он не нужен.")
        }
    }

    // MARK: Содержимое активной вкладки

    @ViewBuilder private var content: some View {
        if let t = browser.activeTab {
            TabContentView(tab: t, runtime: browser.runtime(t.id))
                .id(t.id)
        }
    }

    // MARK: Строка адреса с кнопками

    private var toolbarRow: some View {
        HStack(spacing: 6) {
            if wide {
                navButton("chevron.left", enabled: !(browser.activeTab?.back.isEmpty ?? true)) { browser.goBack() }
                navButton("chevron.right", enabled: !(browser.activeTab?.fwd.isEmpty ?? true)) { browser.goForward() }
                navButton("arrow.clockwise", enabled: true) { browser.reload() }
            }
            if let t = browser.activeTab {
                AddressBar(tab: t, runtime: browser.runtime(t.id))
            }
            if wide {
                if let t = browser.activeTab, t.url.hasPrefix("http") {
                    navButton(browser.isBookmarked(t.url) ? "star.fill" : "star", enabled: true) { browser.toggleBookmark(t) }
                }
                navButton("plus", enabled: true) { browser.newTab() }
                tabsButton
                menu
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(browser.incognito ? Theme.incognito : Color(uiColor: .secondarySystemBackground))
        .environment(\.colorScheme, browser.incognito ? .dark : (browser.settings.theme == .system ? colorScheme : (browser.settings.theme == .dark ? .dark : .light)))
    }

    @Environment(\.colorScheme) private var colorScheme

    private var bottomBar: some View {
        HStack {
            navButton("chevron.left", enabled: !(browser.activeTab?.back.isEmpty ?? true)) { browser.goBack() }
            Spacer()
            navButton("chevron.right", enabled: !(browser.activeTab?.fwd.isEmpty ?? true)) { browser.goForward() }
            Spacer()
            navButton("plus.circle", enabled: true) { browser.newTab() }
            Spacer()
            tabsButton
            Spacer()
            menu
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 6)
        .background(browser.incognito ? Theme.incognito : Color(uiColor: .secondarySystemBackground))
    }

    private func navButton(_ icon: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 36, height: 36)
        }
        .disabled(!enabled)
        .foregroundStyle(browser.incognito ? Color.white : Color.primary)
    }

    private var tabsButton: some View {
        Button {
            if let t = browser.activeTab { snapshot(t.id) }
            showGrid = true
        } label: {
            Text(browser.tabs.count > 99 ? ":D" : "\(browser.tabs.count)")
                .font(.system(size: 13, weight: .bold))
                .frame(width: 22, height: 22)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(lineWidth: 2))
                .frame(width: 36, height: 36)
        }
        .foregroundStyle(browser.incognito ? Color.white : Color.primary)
        .accessibilityLabel("Вкладки: \(browser.tabs.count)")
    }

    private func snapshot(_ id: String) {
        let rt = browser.runtime(id)
        guard let wv = rt.webView, wv.window != nil else { return }
        wv.takeSnapshot(with: nil) { image, _ in
            Task { @MainActor in rt.snapshot = image }
        }
    }

    private var menu: some View {
        Menu {
            Button { browser.newTab() } label: { Label("Новая вкладка", systemImage: "plus.square.on.square") }
            Button { browser.setIncognito(true); browser.newTab() } label: { Label("Новая вкладка инкогнито", systemImage: "eyeglasses") }
            if browser.incognito {
                Button { browser.setIncognito(false) } label: { Label("Выйти из инкогнито", systemImage: "xmark.circle") }
            }
            Divider()
            if let t = browser.activeTab, t.url.hasPrefix("http") {
                Button { browser.toggleBookmark(t) } label: {
                    Label(browser.isBookmarked(t.url) ? "Удалить закладку" : "Добавить в закладки", systemImage: browser.isBookmarked(t.url) ? "star.slash" : "star")
                }
                ShareLink(item: t.url) { Label("Поделиться адресом", systemImage: "square.and.arrow.up") }
                Button { browser.reload() } label: { Label("Обновить", systemImage: "arrow.clockwise") }
            }
            Divider()
            Button { browser.navigate("balnet://history/", newTab: false) } label: { Label("История", systemImage: "clock") }
            Button { browser.navigate("balnet://bookmarks/") } label: { Label("Закладки", systemImage: "book") }
            Button { browser.navigate("balnet://downloads/") } label: { Label("Скачанные файлы", systemImage: "arrow.down.circle") }
            Button { browser.navigate("balnet://passwords/") } label: { Label("Пароли", systemImage: "key") }
            Button { browser.navigate("balnet://terminal/") } label: { Label("Терминал", systemImage: "terminal") }
            Menu {
                Button { showDevTools = true } label: { Label("Инструменты разработчика", systemImage: "hammer") }
                Button { viewSource() } label: { Label("Код страницы", systemImage: "chevron.left.forwardslash.chevron.right") }
                    .disabled(browser.activeTab.map { browser.runtime($0.id).webView == nil } ?? true)
            } label: { Label("Для разработчиков", systemImage: "wrench.and.screwdriver") }
            Divider()
            Button { showProfiles = true } label: { Label("Профиль: \(browser.profile.name)", systemImage: "person.crop.circle") }
            Button { browser.navigate("balnet://settings/") } label: { Label("Настройки", systemImage: "gearshape") }
            Button { browser.navigate("balnet://about/") } label: { Label("О ВлодБраузере", systemImage: "info.circle") }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 18, weight: .medium))
                .frame(width: 36, height: 36)
        }
        .foregroundStyle(browser.incognito ? Color.white : Color.primary)
    }

    private func viewSource() {
        guard let t = browser.activeTab, let wv = browser.runtime(t.id).webView else { return }
        wv.evaluateJavaScript(Scripts.source, in: nil, in: .defaultClient) { result in
            if case .success(let v) = result { sourceText = (v as? String) ?? "" }
        }
    }
}

private struct SourceText: Identifiable {
    var id: String { String(text.hashValue) }
    let text: String
}

/// alert / confirm / prompt страниц. Отдельный модификатор следит за Dialogs.
private struct DialogHost: ViewModifier {
    @ObservedObject var dialogs: Dialogs
    @State private var promptText = ""

    func body(content: Content) -> some View {
        content
            .alert(dialogs.current.map { "Сайт \($0.host) сообщает" } ?? "", isPresented: Binding(get: { dialogs.current != nil }, set: { if !$0 { dialogs.finish(false, nil) } })) {
                if let d = dialogs.current {
                    switch d.kind {
                    case .alert:
                        Button("OK") { dialogs.finish(true, nil) }
                    case .confirm:
                        Button("Отмена", role: .cancel) { dialogs.finish(false, nil) }
                        Button("OK") { dialogs.finish(true, nil) }
                    case .prompt:
                        TextField("", text: $promptText)
                        Button("Отмена", role: .cancel) { dialogs.finish(false, nil) }
                        Button("OK") { dialogs.finish(true, promptText) }
                    }
                }
            } message: {
                Text(dialogs.current?.message ?? "")
            }
            .onChange(of: dialogs.current?.id) { _ in promptText = dialogs.current?.text ?? "" }
    }
}

/// Новая версия приложения на сайте игры.
struct UpdateBanner: View {
    let version: String
    let url: String
    @Environment(\.openURL) private var openURL
    @State private var hidden = false

    var body: some View {
        if !hidden {
            HStack {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.accent)
                Text("Доступна новая версия ВлодБраузера \(version)").font(.footnote)
                Spacer()
                Button("Скачать") { if let u = URL(string: url) { openURL(u) } }.font(.footnote.bold())
                Button { hidden = true } label: { Image(systemName: "xmark") }.font(.footnote)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.accent.opacity(0.1))
        }
    }
}
