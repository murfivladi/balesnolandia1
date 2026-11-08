import SwiftUI

/// Игровая строка состояния: провайдер и «сигнал», IP БалНета, игровая дата.
struct StatusStrip: View {
    @Environment(Browser.self) private var browser
    @State private var showIP = false

    private var bars: Int {
        guard browser.online, let ms = browser.latency else { return 0 }
        if ms < 150 { return 4 }
        if ms < 400 { return 3 }
        if ms < 1000 { return 2 }
        return 1
    }

    var body: some View {
        HStack(spacing: 8) {
            SignalBars(level: bars)
            Text(browser.lease?.providerName ?? providerName)
                .font(.caption2.weight(.semibold))
            if browser.incognito {
                Label("Инкогнито", systemImage: "eyeglasses").font(.caption2).labelStyle(.titleAndIcon)
            }
            Button {
                showIP.toggle()
            } label: {
                Text(showIP ? (browser.lease?.ip ?? "нет IP") : "IP")
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("IP-адрес в БалНете")
            Spacer()
            if browser.paused {
                Text("БалНет на обслуживании").font(.caption2).foregroundStyle(Theme.danger)
            } else if let m = browser.clockMonth {
                Text(GameTime.label(m)).font(.caption2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
        .foregroundStyle(browser.incognito ? Color.white.opacity(0.85) : Color.secondary)
        .background(browser.incognito ? Theme.incognito : Color(uiColor: .secondarySystemBackground))
    }

    private var providerName: String {
        switch browser.profile.net.provider {
        case "baltelecom": return "БалТелеком"
        case "vlodlink": return "ВлодЛинк"
        case "balesno-mobile": return "Балесно-Мобайл"
        default: return browser.profile.net.provider
        }
    }
}

struct SignalBars: View {
    let level: Int
    var body: some View {
        HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .frame(width: 3, height: CGFloat(4 + i * 2))
                    .opacity(i < level ? 1 : 0.25)
            }
        }
        .accessibilityLabel("Сигнал: \(level) из 4")
    }
}

/// Значок слева от адреса.
struct SecurityBadge: View {
    let security: Browser.Security
    @State private var info = false

    var body: some View {
        Button { info = true } label: { label }
            .buttonStyle(.plain)
            .popover(isPresented: $info) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.headline)
                    Text(details).font(.callout).foregroundStyle(.secondary)
                }
                .padding()
                .frame(minWidth: 260)
                .presentationCompactAdaptation(.popover)
            }
    }

    @ViewBuilder private var label: some View {
        switch security {
        case .gov:
            HStack(spacing: 3) {
                Image(systemName: "checkmark.shield.fill")
                Text("Госсайт БФ").font(.caption.weight(.semibold))
            }
            .foregroundStyle(Theme.gov)
        case .secure:
            Image(systemName: "lock.fill").foregroundStyle(.secondary)
        case .insecure:
            HStack(spacing: 3) {
                Image(systemName: "exclamationmark.triangle")
                Text("Не защищено").font(.caption)
            }
            .foregroundStyle(.secondary)
        case .danger(let t):
            HStack(spacing: 3) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(t).font(.caption.weight(.semibold))
            }
            .foregroundStyle(Theme.danger)
        case .internal:
            Image(systemName: "globe").foregroundStyle(Theme.accent)
        case .none:
            Image(systemName: "info.circle").foregroundStyle(.secondary)
        }
    }

    private var title: String {
        switch security {
        case .gov: return "Госсайт Балесноландской Федерации"
        case .secure: return "Подключение защищено"
        case .insecure: return "Подключение не защищено"
        case .danger(let t): return t
        case .internal: return "Страница ВлодБраузера"
        case .none: return "Сайт БалНета"
        }
    }

    private var details: String {
        switch security {
        case .gov(let owner): return "Владелец: \(owner). Сайт открыт с госсервера, сертификат проверен."
        case .secure: return "Сертификат сайта проверен: данные передаются в зашифрованном виде."
        case .insecure: return "Сайт открыт по http: не вводите здесь пароли и данные карт."
        case .danger: return "Сертификат сайта не прошёл проверку. Злоумышленники могут видеть ваши данные."
        case .internal: return "Встроенная страница браузера."
        case .none: return "Подключение к сайту ещё не установлено."
        }
    }
}

/// Адресная строка: без фокуса — короткий адрес и значок, при вводе — полный адрес.
struct AddressBar: View {
    @Environment(Browser.self) private var browser
    let tab: Tab
    let runtime: TabRuntime
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            if !focused {
                SecurityBadge(security: browser.security(tab))
            } else {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            }
            ZStack(alignment: .leading) {
                TextField("Поиск или адрес сайта БалНета", text: $text)
                    .focused($focused)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .opacity(focused ? 1 : 0)
                if !focused {
                    Text(shown.isEmpty ? "Поиск или адрес сайта БалНета" : shown)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .foregroundStyle(shown.isEmpty ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture { focused = true }
                }
            }
            if focused && !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
            } else if !focused && runtime.isLoading {
                Button { runtime.webView?.stopLoading() } label: { Image(systemName: "xmark").foregroundStyle(.secondary) }
            } else if !focused && tab.url.hasPrefix("http") {
                Button { browser.reload() } label: { Image(systemName: "arrow.clockwise").foregroundStyle(.secondary) }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 38)
        .background(RoundedRectangle(cornerRadius: 19).fill(Color(uiColor: .tertiarySystemBackground)))
        .overlay(alignment: .bottom) {
            if runtime.isLoading || runtime.phase == .loading {
                GeometryReader { g in
                    Rectangle().fill(Theme.accent)
                        .frame(width: g.size.width * max(0.08, runtime.phase == .loading ? 0.15 : runtime.progress), height: 2)
                }
                .frame(height: 2)
                .padding(.horizontal, 14)
            }
        }
        .onChange(of: focused) { _, f in
            if f { text = tab.url == Balnet.newTab ? "" : tab.url }
        }
    }

    private var shown: String { Balnet.display(tab.url) }

    private func submit() {
        guard let url = Balnet.parseInput(text) else { return }
        focused = false
        browser.navigate(url, typed: true)
    }
}

/// Полоса вкладок iPad (как в десктопном Chrome).
struct TabStrip: View {
    @Environment(Browser.self) private var browser
    @Binding var showGrid: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(browser.tabs) { t in
                        TabChip(tab: t, active: t.id == browser.activeId)
                            .id(t.id)
                    }
                    Button { browser.newTab() } label: {
                        Image(systemName: "plus").frame(width: 32, height: 30)
                    }
                    .foregroundStyle(browser.incognito ? Color.white : Color.primary)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }
            .onChange(of: browser.activeId) { _, id in
                if let id { withAnimation { proxy.scrollTo(id) } }
            }
        }
        .background(browser.incognito ? Theme.incognito.opacity(0.9) : Color(uiColor: .systemGray5))
    }
}

private struct TabChip: View {
    @Environment(Browser.self) private var browser
    let tab: Tab
    let active: Bool

    var body: some View {
        HStack(spacing: 6) {
            Favicon(url: tab.url, size: 16)
            Text(tab.title.isEmpty ? Balnet.display(tab.url) : tab.title)
                .font(.footnote)
                .lineLimit(1)
                .frame(maxWidth: 160, alignment: .leading)
            Button { browser.close(tab.id) } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Закрыть вкладку")
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8)
                .fill(active ? (browser.incognito ? Theme.incognito : Color(uiColor: .secondarySystemBackground)) : Color.clear)
        )
        .foregroundStyle(browser.incognito ? Color.white : Color.primary)
        .contentShape(Rectangle())
        .onTapGesture { browser.select(tab.id) }
    }
}

/// Значок сайта: госсайты — свой цвет и буква, остальные — первая буква домена.
struct Favicon: View {
    let url: String
    var size: CGFloat = 24

    var body: some View {
        let host = Balnet.split(url)?.host ?? ""
        let gov = Balnet.govSites[host]
        ZStack {
            RoundedRectangle(cornerRadius: size / 4)
                .fill(url.hasPrefix("balnet://") ? Theme.accent : (gov != nil ? Theme.gov : Color.gray.opacity(0.5)))
            if url.hasPrefix("balnet://") {
                Image(systemName: icon(for: Balnet.split(url)?.host ?? ""))
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(.white)
            } else {
                Text(String((gov?.title ?? host).prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
    }

    private func icon(for page: String) -> String {
        switch page {
        case "history": return "clock"
        case "bookmarks": return "book"
        case "settings": return "gearshape"
        case "terminal": return "terminal"
        case "about": return "info"
        default: return "globe"
        }
    }
}
