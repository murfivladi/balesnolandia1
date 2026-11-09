import SwiftUI

/// Новая вкладка: ВлодПоиск, госсайты, часто посещаемые, игровое время.
struct NewTabView: View {
    @EnvironmentObject private var browser: Browser
    @State private var query = ""

    private struct Tile: Identifiable { var id: String { url }; let url: String; let title: String }

    private var tiles: [Tile] {
        let gov = Balnet.govOrder.compactMap { h in Balnet.govSites[h].map { Tile(url: "https://\(h)/", title: $0.title) } }
        var counts: [String: (title: String, n: Int)] = [:]
        for h in browser.history {
            let key = h.url.components(separatedBy: CharacterSet(charactersIn: "?#")).first ?? h.url
            if key.hasPrefix("balnet://") || key.contains("://poisk.bln/") || gov.contains(where: { $0.url == key }) { continue }
            counts[key, default: (h.title, 0)].n += 1
        }
        let top = counts.sorted { $0.value.n > $1.value.n }.prefix(8).map { Tile(url: $0.key, title: $0.value.title) }
        return gov + top
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                if browser.incognito {
                    VStack(spacing: 10) {
                        Image(systemName: "eyeglasses").font(.system(size: 44))
                        Text("Режим инкогнито").font(.title2.bold())
                        Text("ВлодБраузер не сохранит историю, вкладки и данные сайтов этого режима — всё исчезнет при выходе из инкогнито. У вкладок инкогнито свой временный IP-адрес.")
                            .multilineTextAlignment(.center)
                        Text("Вход на госсайты общий с обычным режимом. Ваши действия всё равно видны сайтам и провайдеру БалНета.")
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 30)
                } else {
                    HStack(spacing: 12) {
                        CoatOfArms(size: 52)
                        Text("ВлодПоиск").font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(Theme.accent)
                    }
                    .padding(.top, 36)
                }
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Найти во ВлодПоиске или ввести адрес", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit {
                            if let u = Balnet.parseInput(query) { browser.navigate(u, typed: true) }
                        }
                }
                .padding(.horizontal, 16)
                .frame(height: 46)
                .background(Capsule().fill(Color(uiColor: .secondarySystemBackground)))
                .padding(.horizontal, 20)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 10)], spacing: 16) {
                    ForEach(tiles) { t in
                        Button { browser.navigate(t.url) } label: {
                            VStack(spacing: 6) {
                                Favicon(url: t.url, size: 44)
                                Text(t.title.isEmpty ? Balnet.display(t.url) : t.title)
                                    .font(.caption)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.center)
                                    .foregroundStyle(.primary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)

                if let m = browser.clockMonth {
                    HStack {
                        Image(systemName: "calendar")
                        Text("Игровое время БФ: \(GameTime.label(m))\(browser.paused ? " · пауза" : "")")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 30)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

struct HistoryView: View {
    @EnvironmentObject private var browser: Browser
    @State private var filter = ""

    private var items: [HistoryItem] {
        let f = filter.lowercased()
        let list = f.isEmpty ? browser.history : browser.history.filter { $0.url.lowercased().contains(f) || $0.title.lowercased().contains(f) }
        return Array(list.prefix(500))
    }

    var body: some View {
        List {
            if browser.incognito {
                Text("В режиме инкогнито история не сохраняется.").foregroundStyle(.secondary)
            }
            RemoteTabsSection()
            ForEach(items) { h in
                Button { browser.navigate(h.url) } label: {
                    HStack(spacing: 10) {
                        Favicon(url: h.url, size: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.title.isEmpty ? Balnet.display(h.url) : h.title).lineLimit(1).foregroundStyle(.primary)
                            Text(Balnet.display(h.url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(h.ts, style: .time).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { idx in
                let ids = idx.map { items[$0].id }
                browser.history.removeAll { ids.contains($0.id) }
                browser.scheduleSave()
            }
            if !browser.history.isEmpty {
                Button("Очистить историю", role: .destructive) { browser.clearHistory() }
            }
        }
        .searchable(text: $filter, prompt: "Поиск по истории")
    }
}

struct BookmarksView: View {
    @EnvironmentObject private var browser: Browser

    var body: some View {
        List {
            if browser.bookmarks.isEmpty {
                Text("Закладок пока нет. Откройте сайт и нажмите ☆ в меню.").foregroundStyle(.secondary)
            }
            ForEach(browser.bookmarks) { b in
                Button { browser.navigate(b.url) } label: {
                    HStack(spacing: 10) {
                        Favicon(url: b.url, size: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b.title).lineLimit(1).foregroundStyle(.primary)
                            Text(Balnet.display(b.url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            .onDelete { idx in
                browser.bookmarks.remove(atOffsets: idx)
                browser.scheduleSave()
            }
            .onMove { from, to in
                browser.bookmarks.move(fromOffsets: from, toOffset: to)
                browser.scheduleSave()
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var browser: Browser
    @State private var providers: [Provider] = []
    @State private var net = NetSettings()

    var body: some View {
        Form {
            Section("Подключение") {
                Picker("Провайдер", selection: $net.provider) {
                    if providers.isEmpty {
                        Text("БалТелеком").tag("baltelecom")
                        Text("ВлодЛинк").tag("vlodlink")
                        Text("Балесно-Мобайл").tag("balesno-mobile")
                    }
                    ForEach(providers) { Text($0.name).tag($0.code) }
                }
                Picker("DNS", selection: $net.dnsMode) {
                    Text("DNS провайдера").tag("provider")
                    Text("ВлодDNS 50.0.0.53").tag("public")
                    Text("Свой").tag("custom")
                }
                if net.dnsMode == "custom" {
                    TextField("IP-адрес DNS-сервера", text: $net.dns)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                }
                if let l = browser.lease {
                    LabeledContent("IP-адрес", value: l.ip)
                    LabeledContent("DNS провайдера", value: l.resolverIP)
                }
                Button("Сохранить подключение") { browser.updateNet(net) }
                    .disabled(net == browser.profile.net || (net.dnsMode == "custom" && !Balnet.isIP(net.dns)))
            }
            AccountSection(sync: browser.sync)
            Section {
                Toggle("\(OwnerAuth.biometryName) при входе во ВлодБанк", isOn: Binding(get: { browser.bankLockEnabled }, set: { browser.setBankLock($0) }))
                Button("Пароли сайтов") { browser.navigate("balnet://passwords/") }
                Button("Скачанные файлы") { browser.navigate("balnet://downloads/") }
                if !browser.savedPins.isEmpty {
                    Button("Забыть сохранённые PIN карт (\(browser.savedPins.count))", role: .destructive) { browser.forgetPins(); browser.objectWillChange.send() }
                }
            } header: {
                Text("Безопасность")
            } footer: {
                Text("PIN карт хранится в связке ключей iPhone/iPad и подставляется на pay.bank.bln и в банкомате только после \(OwnerAuth.biometryName).")
            }
            ImportSection()
            Section("Вид") {
                Picker("Тема", selection: $browser.settings.theme) {
                    ForEach(ThemeMode.allCases) { Text($0.label).tag($0) }
                }
                Toggle("Адресная строка внизу (iPhone)", isOn: $browser.settings.addressBarBottom)
                Toggle("Восстанавливать вкладки при запуске", isOn: $browser.settings.restoreSession)
            }
            Section("Профиль") {
                LabeledContent("Профиль", value: browser.profile.name)
                LabeledContent("Устройство", value: browser.profile.clientId)
            }
            Section {
                Button("Очистить историю", role: .destructive) { browser.clearHistory() }
            }
        }
        .onAppear { net = browser.profile.net }
        .onChange(of: browser.settings) { _ in browser.saveSettings() }
        .task { providers = (try? await NetClient.shared.providers()) ?? [] }
    }
}

struct AboutView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                CoatOfArms(size: 72)
                Text("ВлодБраузер для iOS").font(.title.bold())
                Text("Версия \(Config.version) (\(Config.build))").foregroundStyle(.secondary)
                Text("Браузер БалНета — вымышленного интернета Балесноландской Федерации. Сайты, DNS, сертификаты и провайдеры работают на сервере игры.")
                    .multilineTextAlignment(.center)
                Text(Config.disclaimer)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Link("Скачать новую версию", destination: URL(string: "\(Config.site)/ios/")!)
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
    }
}

struct ProfilesView: View {
    @EnvironmentObject private var browser: Browser
    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(browser.profiles) { p in
                        Button {
                            browser.switchProfile(p.id)
                            dismiss()
                        } label: {
                            HStack {
                                Circle().fill(Theme.color(hex: p.color)).frame(width: 28, height: 28)
                                    .overlay(Text(String(p.name.prefix(1))).font(.caption.bold()).foregroundStyle(.white))
                                Text(p.name).foregroundStyle(.primary)
                                Spacer()
                                if p.id == browser.profile.id && !browser.incognito { Image(systemName: "checkmark") }
                            }
                        }
                        .swipeActions {
                            if browser.profiles.count > 1 {
                                Button("Удалить", role: .destructive) { browser.deleteProfile(p.id) }
                            }
                        }
                    }
                } footer: {
                    if #available(iOS 17.0, *) {
                        Text("У каждого профиля свои вкладки, история, закладки, вход на госсайты и IP-адрес в БалНете.")
                    } else {
                        Text("У каждого профиля свои вкладки, история, закладки и IP-адрес в БалНете. Вход на госсайты на iOS 16 общий для всех профилей — выходите из аккаунта вручную.")
                    }
                }
                Section("Новый профиль") {
                    TextField("Имя", text: $newName)
                    Button("Добавить профиль") {
                        browser.addProfile(name: newName.trimmingCharacters(in: .whitespaces))
                        dismiss()
                    }
                }
            }
            .navigationTitle("Профили")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
    }
}
