import Foundation
import Combine
import WebKit

/// Скачанный файл (чек PNG, паспорт, выписка): лежит в Documents/Downloads приложения.
struct DownloadItem: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var source: String
    var date: Date
    var bytes: Int64 = 0
    var done = false
    var failed: String?

    var url: URL { Downloads.dir.appendingPathComponent(name) }
    var isImage: Bool { ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(url.pathExtension.lowercased()) }
}

/// Загрузки WebKit (WKDownload): ссылки download, blob:, файлы с API игры. Список — как «Скачанные» в Chrome.
@MainActor
final class Downloads: NSObject, ObservableObject, WKDownloadDelegate {
    @Published private(set) var items: [DownloadItem] = []
    /// Последняя завершённая загрузка — браузер показывает плашку «Скачано».
    @Published var lastFinished: DownloadItem?
    private var active: [ObjectIdentifier: UUID] = [:]

    static let dir: URL = {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    func load() {
        items = (Storage.load([DownloadItem].self, "downloads") ?? []).filter { FileManager.default.fileExists(atPath: $0.url.path) || !$0.done }
    }

    private func save() { Storage.save(items, "downloads") }

    func start(_ download: WKDownload) {
        download.delegate = self
    }

    func remove(_ item: DownloadItem) {
        try? FileManager.default.removeItem(at: item.url)
        items.removeAll { $0.id == item.id }
        save()
    }

    func clear() {
        for i in items { try? FileManager.default.removeItem(at: i.url) }
        items = []
        save()
    }

    private func unique(_ suggested: String) -> String {
        var base = (suggested as NSString).deletingPathExtension
        let ext = (suggested as NSString).pathExtension
        if base.isEmpty { base = "file" }
        base = base.replacingOccurrences(of: "/", with: "_")
        var name = ext.isEmpty ? base : "\(base).\(ext)"
        var n = 2
        while FileManager.default.fileExists(atPath: Downloads.dir.appendingPathComponent(name).path) {
            name = ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"
            n += 1
        }
        return name
    }

    // MARK: WKDownloadDelegate

    nonisolated func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let source = download.originalRequest?.url?.absoluteString ?? ""
        let key = ObjectIdentifier(download)
        Task { @MainActor in
            let name = self.unique(suggestedFilename)
            let item = DownloadItem(name: name, source: source, date: Date())
            self.items.insert(item, at: 0)
            self.active[key] = item.id
            self.save()
            completionHandler(item.url)
        }
    }

    nonisolated func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        Task { @MainActor in self.finish(key, error: nil) }
    }

    nonisolated func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        let msg = error.localizedDescription
        Task { @MainActor in self.finish(key, error: msg) }
    }

    private func finish(_ key: ObjectIdentifier, error: String?) {
        guard let id = active.removeValue(forKey: key), let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].done = error == nil
        items[i].failed = error
        items[i].bytes = ((try? FileManager.default.attributesOfItem(atPath: items[i].url.path))?[.size] as? NSNumber)?.int64Value ?? 0
        save()
        if error == nil { lastFinished = items[i] }
    }
}
