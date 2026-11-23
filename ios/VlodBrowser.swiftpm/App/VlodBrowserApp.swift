import SwiftUI

@main
struct VlodBrowserApp: App {
    @StateObject private var browser = Browser()
    @Environment(\.scenePhase) private var phase

    init() {
        CrashReporter.install()
        CrashReporter.sendPending()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(browser)
                .onChange(of: phase) { p in
                    if p == .background || p == .inactive { browser.saveNow() }
                    if p == .active { browser.refreshStatus() }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var browser: Browser

    var body: some View {
        Group {
            if browser.settings.onboarded {
                BrowserView()
            } else {
                OnboardingView()
            }
        }
        .preferredColorScheme(browser.settings.theme == .system ? nil : (browser.settings.theme == .dark ? .dark : .light))
        .tint(Theme.accent)
    }
}

enum Theme {
    static let accent = Color(red: 0.12, green: 0.31, blue: 0.75)
    static let gov = Color(red: 0.06, green: 0.46, blue: 0.43)
    static let danger = Color(red: 0.75, green: 0.15, blue: 0.15)
    static let gold = Color(red: 0.72, green: 0.56, blue: 0.12)
    static let incognito = Color(red: 0.16, green: 0.17, blue: 0.20)

    static func color(hex: String) -> Color {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard h.count == 6, let v = Int(h, radix: 16) else { return accent }
        return Color(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

enum GameTime {
    static let months = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]

    /// Номер игрового месяца → «март 3 г. БФ» (как gameDateLabel).
    static func label(_ index: Int) -> String {
        let i = max(0, index)
        return "\(months[i % 12]) \(i / 12 + 1) г. БФ"
    }

    /// Игровые секунды сертификата → «день 12, месяц 3».
    static func certDate(_ sec: Double) -> String {
        let s = Int(sec)
        let month = s / (30 * 86400)
        let day = (s % (30 * 86400)) / 86400 + 1
        return "день \(day), месяц \(month)"
    }
}
