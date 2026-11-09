import SwiftUI
import QuickLook
import UniformTypeIdentifiers
import WebKit

// MARK: Аккаунт ВлодБраузера и синхронизация (раздел настроек)

struct AccountSection: View {
    @EnvironmentObject private var browser: Browser
    @ObservedObject var sync: SyncManager
    @State private var phrase = ""
    @State private var phrase2 = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Section {
            if browser.incognito {
                Text("В инкогнито аккаунт браузера недоступен.").foregroundStyle(.secondary)
            } else if let acc = sync.account {
                LabeledContent("Аккаунт", value: acc.address)
                if !sync.hasKey {
                    Text(sync.phraseExists ? "Введите кодовую фразу, заданную на другом устройстве." : "Придумайте кодовую фразу: ею шифруются закладки, история и пароли. Сервер её не знает — без неё данные не восстановить.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    SecureField("Кодовая фраза", text: $phrase)
                    if !sync.phraseExists { SecureField("Ещё раз", text: $phrase2) }
                    Button(busy ? "Проверяем…" : "Включить синхронизацию") { run { try await sync.setPhrase(phrase); phrase = ""; phrase2 = "" } }
                        .disabled(busy || phrase.count < 8 || (!sync.phraseExists && phrase != phrase2))
                    if phrase.count > 0 && phrase.count < 8 { Text("Не короче 8 символов").font(.caption).foregroundStyle(.secondary) }
                } else {
                    LabeledContent("Синхронизация", value: statusText)
                    Button("Синхронизировать сейчас") { Task { await sync.sync() } }
                        .disabled(sync.status == .syncing)
                }
                Button("Выйти из аккаунта", role: .destructive) { Task { await sync.signOut() } }
            } else {
                Text("Закладки, история, пароли, открытые вкладки и настройки — общие на iPhone, iPad и в веб-ВлодБраузере. Нужен ящик ВлодПочты.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button(busy ? "Входим…" : "Войти через ВлодПочту") { run { try await signIn() } }
                    .disabled(busy)
                Button("Открыть ВлодПочту (mail.bln)") { browser.navigate("https://mail.bln/", newTab: true) }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
        } header: {
            Text("Аккаунт ВлодБраузера")
        }
        .task { await sync.refreshPhraseState() }
    }

    private var statusText: String {
        switch sync.status {
        case .idle: return "включена"
        case .syncing: return "идёт…"
        case .ok(let d): return "в \(d.formatted(date: .omitted, time: .shortened))"
        case .error(let e): return "ошибка: \(e)"
        }
    }

    private func signIn() async throws {
        let cookies = await browser.govCookies()
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        try await sync.signIn(deviceName: "ВлодБраузер · \(browser.profile.name) · \(device)", cookies: cookies)
        await sync.refreshPhraseState()
    }

    private func run(_ f: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await f() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

// MARK: Пароли

struct PasswordsView: View {
    @EnvironmentObject private var browser: Browser
    @State private var unlocked = false
    @State private var shown: Set<String> = []
    @State private var filter = ""

    var body: some View {
        Group {
            if unlocked {
                List {
                    if browser.passwords.isEmpty {
                        Text("Сохранённых паролей нет. ВлодБраузер предложит сохранить пароль, когда вы войдёте на сайт БалНета.").foregroundStyle(.secondary)
                    }
                    ForEach(browser.passwords.filter { filter.isEmpty || $0.origin.localizedCaseInsensitiveContains(filter) || $0.username.localizedCaseInsensitiveContains(filter) }) { p in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Balnet.display(p.origin)).font(.headline)
                            Text(p.username.isEmpty ? "без логина" : p.username).font(.subheadline)
                            HStack {
                                Text(shown.contains(p.id) ? p.password : String(repeating: "•", count: 8)).font(.body.monospaced())
                                Spacer()
                                Button { if shown.contains(p.id) { shown.remove(p.id) } else { shown.insert(p.id) } } label: {
                                    Image(systemName: shown.contains(p.id) ? "eye.slash" : "eye")
                                }
                                .buttonStyle(.borderless)
                                Button { UIPasteboard.general.string = p.password } label: { Image(systemName: "doc.on.doc") }
                                    .buttonStyle(.borderless)
                            }
                        }
                        .swipeActions { Button("Удалить", role: .destructive) { browser.deletePassword(p) } }
                    }
                    if let never = browser.profile.neverSave, !never.isEmpty {
                        Section("Не сохранять для") {
                            ForEach(never, id: \.self) { Text(Balnet.display($0)) }
                        }
                    }
                }
                .searchable(text: $filter, prompt: "Поиск")
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "key.fill").font(.system(size: 44)).foregroundStyle(Theme.accent)
                    Text("Пароли защищены").font(.title3.bold())
                    Button("Показать (\(OwnerAuth.biometryName))") { Task { unlocked = await OwnerAuth.confirm("Показать сохранённые пароли") } }
                        .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { if !unlocked { unlocked = await OwnerAuth.confirm("Показать сохранённые пароли") } }
    }
}

// MARK: Скачанные файлы

struct DownloadsView: View {
    @ObservedObject var downloads: Downloads
    @State private var preview: URL?
    @State private var export: URL?
    @State private var photoMessage: String?

    var body: some View {
        List {
            if downloads.items.isEmpty {
                Text("Здесь появятся скачанные файлы: чеки, паспорт, выписки.").foregroundStyle(.secondary)
            }
            ForEach(downloads.items) { d in
                HStack(spacing: 12) {
                    Image(systemName: d.isImage ? "photo" : "doc").font(.title2).foregroundStyle(Theme.accent).frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name).lineLimit(1)
                        Text(d.failed ?? (d.done ? "\(ByteCountFormatter.string(fromByteCount: d.bytes, countStyle: .file)) · \(d.date.formatted(date: .abbreviated, time: .shortened))" : "скачивается…"))
                            .font(.caption)
                            .foregroundStyle(d.failed != nil ? Theme.danger : .secondary)
                    }
                    Spacer()
                    if d.done {
                        Menu {
                            Button { preview = d.url } label: { Label("Открыть", systemImage: "eye") }
                            ShareLink(item: d.url) { Label("Поделиться", systemImage: "square.and.arrow.up") }
                            Button { export = d.url } label: { Label("Сохранить в «Файлы»", systemImage: "folder") }
                            if d.isImage {
                                Button { saveToPhotos(d) } label: { Label("Сохранить в «Фото»", systemImage: "photo.on.rectangle") }
                            }
                            Button(role: .destructive) { downloads.remove(d) } label: { Label("Удалить", systemImage: "trash") }
                        } label: {
                            Image(systemName: "ellipsis.circle").font(.title3)
                        }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { if d.done { preview = d.url } }
                .swipeActions { Button("Удалить", role: .destructive) { downloads.remove(d) } }
            }
            if !downloads.items.isEmpty {
                Button("Удалить все", role: .destructive) { downloads.clear() }
            }
        }
        .sheet(item: Binding(get: { preview.map(IdentifiedURL.init) }, set: { preview = $0?.url })) { p in
            QuickLookView(url: p.url).ignoresSafeArea()
        }
        .sheet(item: Binding(get: { export.map(IdentifiedURL.init) }, set: { export = $0?.url })) { p in
            ExportPicker(url: p.url)
        }
        .alert(photoMessage ?? "", isPresented: Binding(get: { photoMessage != nil }, set: { if !$0 { photoMessage = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private func saveToPhotos(_ d: DownloadItem) {
        guard let img = UIImage(contentsOfFile: d.url.path) else { photoMessage = "Не удалось открыть картинку"; return }
        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
        photoMessage = "Сохранено в «Фото»"
    }
}

struct IdentifiedURL: Identifiable {
    var id: String { url.absoluteString }
    let url: URL
}

struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UINavigationController {
        let q = QLPreviewController()
        q.dataSource = context.coordinator
        return UINavigationController(rootViewController: q)
    }

    func updateUIViewController(_ vc: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// «Сохранить в Файлы»: системный выбор папки.
struct ExportPicker: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        UIDocumentPickerViewController(forExporting: [url], asCopy: true)
    }
    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}
}

// MARK: Импорт из веб-ВлодБраузера

struct ImportSection: View {
    @EnvironmentObject private var browser: Browser
    @State private var fileImporter = false
    @State private var scanner = false
    @State private var message: String?

    var body: some View {
        Section {
            Button { fileImporter = true } label: { Label("Импорт из файла JSON", systemImage: "doc") }
            Button { scanner = true } label: { Label("Сканировать QR с закладками", systemImage: "qrcode.viewfinder") }
                .disabled(!QRScannerView.isAvailable)
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        } header: {
            Text("Перенос из веб-ВлодБраузера")
        } footer: {
            Text("В веб-версии: Настройки → «Перенос во ВлодБраузер для iOS». Пароли переносятся только через аккаунт (синхронизация).")
        }
        .fileImporter(isPresented: $fileImporter, allowedContentTypes: [.json, .plainText]) { result in
            guard case .success(let url) = result else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { message = "Не удалось прочитать файл"; return }
            apply(text)
        }
        .sheet(isPresented: $scanner) {
            QRScannerSheet { text in
                scanner = false
                apply(text)
            }
        }
    }

    private func apply(_ text: String) {
        guard let r = BrowserImport.parse(text) else { message = "Это не экспорт ВлодБраузера"; return }
        let n = browser.importData(r)
        message = "Добавлено закладок: \(n), записей истории: \(r.history.count)"
    }
}

// MARK: Вкладки с других устройств (на странице истории)

struct RemoteTabsSection: View {
    @EnvironmentObject private var browser: Browser

    var body: some View {
        ForEach(browser.remoteTabsByDevice, id: \.name) { dev in
            Section("Вкладки: \(dev.name)") {
                ForEach(dev.tabs.indices, id: \.self) { i in
                    let t = dev.tabs[i]
                    let url = t["url"]?.string ?? ""
                    Button { browser.navigate(url) } label: {
                        HStack(spacing: 10) {
                            Favicon(url: url, size: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t["title"]?.string ?? Balnet.display(url)).lineLimit(1).foregroundStyle(.primary)
                                Text(Balnet.display(url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
    }
}

extension Browser {
    /// Cookies госсайтов профиля (вход во ВлодУслуги и ВлодПочту) — для входа в аккаунт браузера.
    func govCookies() async -> [HTTPCookie] {
        let store: WKWebsiteDataStore
        if #available(iOS 17.0, *) { store = WKWebsiteDataStore(forIdentifier: profile.dataStoreId) } else { store = .default() }
        return await withCheckedContinuation { cont in
            store.httpCookieStore.getAllCookies { cont.resume(returning: $0) }
        }
    }
}
