import SwiftUI

/// Первый запуск: «договор» с провайдером БалНета и выбор DNS.
struct OnboardingView: View {
    @EnvironmentObject private var browser: Browser
    @State private var providers: [Provider] = []
    @State private var selected = "baltelecom"
    @State private var dnsMode = "provider"
    @State private var dns = ""
    @State private var loading = true
    @State private var error: String?
    @State private var agreed = false
    @State private var connecting = false

    private static let fallback = [
        Provider(code: "baltelecom", name: "БалТелеком", resolverIP: ""),
        Provider(code: "vlodlink", name: "ВлодЛинк", resolverIP: ""),
        Provider(code: "balesno-mobile", name: "Балесно-Мобайл", resolverIP: ""),
    ]

    private static let about: [String: String] = [
        "baltelecom": "Госоператор связи. Домашний интернет по всей Федерации.",
        "vlodlink": "Быстрый оптический интернет для дома и офиса.",
        "balesno-mobile": "Мобильный интернет: БалНет в кармане, где бы вы ни были.",
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        CoatOfArms(size: 64)
                        Text("ВлодБраузер").font(.largeTitle.bold())
                        Text("Чтобы открывать сайты БалНета, подключите интернет у одного из провайдеров Балесноландской Федерации.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color.clear)

                Section("Провайдер") {
                    if loading {
                        HStack { ProgressView(); Text("Загружаем список провайдеров…") }
                    }
                    ForEach(providers.isEmpty && !loading ? Self.fallback : providers) { p in
                        Button {
                            selected = p.code
                        } label: {
                            HStack(alignment: .top) {
                                Image(systemName: selected == p.code ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(selected == p.code ? Theme.accent : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name).font(.headline).foregroundStyle(.primary)
                                    Text(Self.about[p.code] ?? "Провайдер БалНета").font(.footnote).foregroundStyle(.secondary)
                                    if !p.resolverIP.isEmpty {
                                        Text("DNS провайдера: \(p.resolverIP)").font(.caption.monospaced()).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(Theme.danger)
                        Button("Повторить") { Task { await load() } }
                    }
                }

                Section {
                    Picker("DNS-сервер", selection: $dnsMode) {
                        Text("DNS провайдера").tag("provider")
                        Text("ВлодDNS 50.0.0.53").tag("public")
                        Text("Свой").tag("custom")
                    }
                    if dnsMode == "custom" {
                        TextField("IP-адрес DNS-сервера", text: $dns)
                            .keyboardType(.numbersAndPunctuation)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text("DNS")
                } footer: {
                    Text("Настройки можно поменять потом: меню → Настройки → Подключение.")
                }

                Section {
                    Toggle("Принимаю условия договора оказания услуг связи БалНета", isOn: $agreed)
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            Spacer()
                            if connecting { ProgressView() } else { Text("Подключить интернет").bold() }
                            Spacer()
                        }
                    }
                    .disabled(!agreed || connecting || (dnsMode == "custom" && !Balnet.isIP(dns)))
                } footer: {
                    Text(Config.disclaimer)
                }
            }
            .navigationTitle("Подключение")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            providers = try await NetClient.shared.providers()
            if !providers.contains(where: { $0.code == selected }), let f = providers.first { selected = f.code }
        } catch {
            self.error = "Нет связи с сервером БалНета. Можно подключиться позже — выберите провайдера и продолжайте."
        }
        loading = false
    }

    private func connect() async {
        connecting = true
        let net = NetSettings(provider: selected, dnsMode: dnsMode, dns: dns.trimmingCharacters(in: .whitespaces))
        browser.updateNet(net)
        if let l = try? await NetClient.shared.lease(clientId: browser.profile.clientId, provider: selected) {
            browser.lease = l
        }
        browser.settings.onboarded = true
        browser.saveSettings()
        connecting = false
        browser.activateCurrent()
    }
}

/// Герб Балесноландской Федерации (упрощённый, без внешних картинок).
struct CoatOfArms: View {
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            Shield()
                .fill(LinearGradient(colors: [Theme.accent, Color(red: 0.07, green: 0.18, blue: 0.48)], startPoint: .top, endPoint: .bottom))
            Shield()
                .stroke(Theme.gold, lineWidth: size / 16)
            Text("Б")
                .font(.system(size: size * 0.5, weight: .heavy, design: .serif))
                .foregroundStyle(Theme.gold)
                .offset(y: -size * 0.03)
        }
        .frame(width: size * 0.86, height: size)
        .accessibilityLabel("Герб БФ")
    }
}

struct Shield: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY + r.height * 0.08))
        p.addLine(to: CGPoint(x: r.midX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + r.height * 0.08))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + r.height * 0.5))
        p.addQuadCurve(to: CGPoint(x: r.midX, y: r.maxY), control: CGPoint(x: r.maxX, y: r.minY + r.height * 0.85))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.minY + r.height * 0.5), control: CGPoint(x: r.minX, y: r.minY + r.height * 0.85))
        p.closeSubpath()
        return p
    }
}
