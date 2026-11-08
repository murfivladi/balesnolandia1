import Foundation

struct Profile: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var color: String
    /// Устройство профиля в БалНете: ему провайдер выдаёт IP.
    var clientId: String
    var net = NetSettings()
    /// Хранилище WebKit госсайтов профиля (cookies входа ВлодУслуг).
    var dataStoreId: UUID = UUID()
}

struct HistoryItem: Codable, Identifiable, Equatable {
    var id = UUID()
    var url: String
    var title: String
    var ts: Date
}

struct Bookmark: Codable, Identifiable, Equatable {
    var id = UUID()
    var url: String
    var title: String
}

/// Вкладка (сохраняется между запусками). Своя история «назад/вперёд», как в веб-ВлодБраузере.
struct Tab: Codable, Identifiable, Equatable {
    var id: String = Tab.newId()
    var url: String
    var title: String
    var back: [String] = []
    var fwd: [String] = []
    /// Откуда пришли (Referer): страница, с которой открыли ссылку.
    var ref: String?

    init(url: String = Balnet.newTab, ref: String? = nil) {
        self.url = url
        self.title = Balnet.title(for: url)
        self.ref = ref
    }

    static func newId() -> String { "t" + UUID().uuidString.prefix(8).lowercased() }
}

struct Session: Codable, Equatable {
    var tabs: [Tab] = [Tab()]
    var activeId: String?
}

enum ThemeMode: String, Codable, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: return "Как в системе"
        case .light: return "Светлая"
        case .dark: return "Тёмная"
        }
    }
}

struct AppSettings: Codable, Equatable {
    var onboarded = false
    var activeProfile = "p1"
    var addressBarBottom = false
    var theme: ThemeMode = .system
    var restoreSession = true
}

/// Файлы приложения: Application Support/VlodBrowser/… (JSON). Инкогнито сюда не пишет.
enum Storage {
    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let d = base.appendingPathComponent("VlodBrowser", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    static func file(_ name: String) -> URL { dir.appendingPathComponent(name + ".json") }

    static func load<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let data = try? Data(contentsOf: file(name)) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(T.self, from: data)
    }

    static func save<T: Encodable>(_ value: T, _ name: String) {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(value) else { return }
        try? data.write(to: file(name), options: .atomic)
    }

    static func remove(_ name: String) {
        try? FileManager.default.removeItem(at: file(name))
    }

    static let profileColors = ["#1f4fbf", "#0f766e", "#b8901f", "#7c3aed", "#c2410c", "#be185d", "#475569"]
}
