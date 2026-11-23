import SwiftUI

/// Плашка внизу страницы: сохранить пароль, подставить пароль, сохранить PIN карты, «Скачано».
struct PromptBar: View {
    @EnvironmentObject private var browser: Browser
    @ObservedObject var downloads: Downloads

    var body: some View {
        VStack(spacing: 8) {
            if let p = browser.prompt {
                card(for: p)
            }
            if let d = downloads.lastFinished {
                bar(icon: "arrow.down.circle.fill", title: "Скачано: \(d.name)", text: nil) {
                    Button("Открыть") {
                        downloads.lastFinished = nil
                        browser.navigate("balnet://downloads/", newTab: true)
                    }
                    .bold()
                    Button { downloads.lastFinished = nil } label: { Image(systemName: "xmark") }
                }
                .task {
                    try? await Task.sleep(nanoseconds: 6_000_000_000)
                    if downloads.lastFinished?.id == d.id { downloads.lastFinished = nil }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .animation(.easeInOut(duration: 0.2), value: browser.prompt)
    }

    @ViewBuilder private func card(for p: BrowserPrompt) -> some View {
        switch p {
        case .savePassword(let pw):
            bar(icon: "key.fill", title: "Сохранить пароль?", text: "\(pw.username.isEmpty ? "без логина" : pw.username) · \(Balnet.display(pw.origin))") {
                Button("Никогда") {
                    browser.neverSave(pw.origin)
                    browser.prompt = nil
                }
                Button("Сохранить") {
                    browser.storePassword(pw)
                    browser.prompt = nil
                }
                .bold()
            }
        case .fillPassword(let tabId, let ticket, let pw):
            bar(icon: "key.fill", title: "Войти как \(pw.username.isEmpty ? "сохранённый пользователь" : pw.username)?", text: "Пароль подставит \(OwnerAuth.biometryName)") {
                Button { browser.prompt = nil } label: { Image(systemName: "xmark") }
                Button("Заполнить") {
                    browser.prompt = nil
                    Task { await browser.fill(tabId: tabId, ticket: ticket, pw) }
                }
                .bold()
            }
        case .savePin(let number, let pin):
            bar(icon: "faceid", title: "Сохранить PIN карты •••• \(number.suffix(4))?", text: "В следующий раз PIN подставит \(OwnerAuth.biometryName)") {
                Button("Нет") { browser.prompt = nil }
                Button("Сохранить") {
                    browser.savePin(number: number, pin: pin)
                    browser.prompt = nil
                }
                .bold()
            }
        }
    }

    private func bar<Buttons: View>(icon: String, title: String, text: String?, @ViewBuilder buttons: () -> Buttons) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(Theme.accent).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(2)
                if let text { Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 4)
            HStack(spacing: 14) { buttons() }.font(.subheadline)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(.regularMaterial))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// ВлодБанк закрыт, пока владелец не подтвердит себя Face ID (настройка профиля).
struct BankLockView: View {
    @EnvironmentObject private var browser: Browser
    @State private var asked = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield.fill").font(.system(size: 56)).foregroundStyle(Theme.gov)
            Text("ВлодБанк защищён").font(.title2.bold())
            Text("Подтвердите, что это вы: \(OwnerAuth.biometryName).").foregroundStyle(.secondary)
            Button("Разблокировать") { Task { await browser.unlockBank() } }
                .buttonStyle(.borderedProminent)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .task {
            guard !asked else { return }
            asked = true
            await browser.unlockBank()
        }
    }
}

/// Размытие поверх банка в переключателе приложений: баланс не виден.
struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            VStack(spacing: 10) {
                CoatOfArms(size: 56)
                Text("ВлодБраузер").font(.headline)
            }
        }
        .ignoresSafeArea()
    }
}
