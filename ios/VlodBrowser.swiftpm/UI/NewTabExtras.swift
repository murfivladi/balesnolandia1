import SwiftUI
import PhotosUI

/// Реклама ВлодПоиска на новой вкладке (платные объявления игроков).
struct SponsoredTile: View {
    @EnvironmentObject private var browser: Browser
    @State private var ad: JSON?

    var body: some View {
        Group {
            if let ad, !ad.isNull {
                Button {
                    Task {
                        let r = try? await API.post("/search/ads/click", ["token": ad["token"]?.string ?? ""])
                        browser.navigate(r?["url"]?.string ?? ad["url"]?.string ?? Balnet.newTab)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("**Реклама** · \(ad["display"]?.string ?? "")").font(.caption).foregroundStyle(.secondary)
                        Text(ad["title"]?.string ?? "").font(.headline).foregroundStyle(Theme.accent)
                        Text(ad["text"]?.string ?? "").font(.subheadline).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 14).fill(.regularMaterial))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
            }
        }
        .task {
            let r = try? await API.get("/search/ads/newtab")
            ad = r?["ad"]
        }
    }
}

/// Лента БалНовостей (novosti.bln): последние материалы, открываются во вкладке.
struct NewsFeed: View {
    @EnvironmentObject private var browser: Browser
    @State private var articles: [JSON] = []

    var body: some View {
        Group {
            if !articles.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("БалНовости").font(.title3.bold())
                        Spacer()
                        Button("Все новости") { browser.navigate("https://novosti.bln/") }.font(.subheadline)
                    }
                    ForEach(articles.indices, id: \.self) { i in
                        let a = articles[i]
                        Button {
                            browser.navigate("https://novosti.bln/a/\(a["id"]?.string ?? "")")
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(a["outlet"]?["title"]?.string ?? "")\(a["pinned"]?.bool == true ? " · 📌" : "")").font(.caption).foregroundStyle(.secondary)
                                Text(a["title"]?.string ?? "").font(.headline).foregroundStyle(.primary).multilineTextAlignment(.leading)
                                if let s = a["summary"]?.string, !s.isEmpty {
                                    Text(s).font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 12).fill(.regularMaterial))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .task {
            let feed = try? await API.get("/news/feed")
            articles = Array((feed?["articles"]?.array ?? []).prefix(5))
        }
    }
}

// MARK: Обои новой вкладки

enum Wallpapers {
    static let presets: [[Color]] = [
        [Color(red: 0.12, green: 0.31, blue: 0.75), Color(red: 0.05, green: 0.12, blue: 0.36)],
        [Color(red: 0.06, green: 0.46, blue: 0.43), Color(red: 0.02, green: 0.2, blue: 0.25)],
        [Color(red: 0.72, green: 0.56, blue: 0.12), Color(red: 0.45, green: 0.2, blue: 0.08)],
        [Color(red: 0.49, green: 0.23, blue: 0.93), Color(red: 0.75, green: 0.1, blue: 0.36)],
        [Color(red: 0.95, green: 0.6, blue: 0.4), Color(red: 0.55, green: 0.2, blue: 0.45)],
        [Color(red: 0.2, green: 0.22, blue: 0.26), Color(red: 0.05, green: 0.05, blue: 0.07)],
    ]

    static func photoURL(_ profileId: String) -> URL { Storage.dir.appendingPathComponent("wallpaper-\(profileId).jpg") }
}

struct WallpaperView: View {
    let value: String?
    let profileId: String

    var body: some View {
        if let v = value, v.hasPrefix("preset:"), let i = Int(v.dropFirst(7)), Wallpapers.presets.indices.contains(i) {
            LinearGradient(colors: Wallpapers.presets[i], startPoint: .topLeading, endPoint: .bottomTrailing).opacity(0.85)
        } else if value == "photo", let img = UIImage(contentsOfFile: Wallpapers.photoURL(profileId).path) {
            Image(uiImage: img).resizable().scaledToFill().overlay(Color.black.opacity(0.15))
        } else {
            Color.clear
        }
    }
}

struct WallpaperPicker: View {
    @EnvironmentObject private var browser: Browser
    @Environment(\.dismiss) private var dismiss
    @State private var item: PhotosPickerItem?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 12)], spacing: 12) {
                    Button { set(nil) } label: {
                        RoundedRectangle(cornerRadius: 12).stroke(Color.secondary).frame(height: 120)
                            .overlay(Text("Без обоев").font(.caption))
                    }
                    ForEach(Wallpapers.presets.indices, id: \.self) { i in
                        Button { set("preset:\(i)") } label: {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(LinearGradient(colors: Wallpapers.presets[i], startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(height: 120)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.accent, lineWidth: browser.profile.wallpaper == "preset:\(i)" ? 3 : 0))
                        }
                    }
                    PhotosPicker(selection: $item, matching: .images) {
                        RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.15)).frame(height: 120)
                            .overlay(Label("Из «Фото»", systemImage: "photo").font(.caption))
                    }
                }
                .padding()
            }
            .navigationTitle("Обои новой вкладки")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        .onChange(of: item) { picked in
            guard let picked else { return }
            Task {
                guard let data = try? await picked.loadTransferable(type: Data.self), let img = UIImage(data: data),
                      let jpg = scaled(img).jpegData(compressionQuality: 0.85) else { return }
                try? jpg.write(to: Wallpapers.photoURL(browser.profile.id), options: .atomic)
                set("photo")
            }
        }
    }

    private func scaled(_ img: UIImage) -> UIImage {
        let maxSide: CGFloat = 2000
        let s = min(1, maxSide / max(img.size.width, img.size.height))
        if s >= 1 { return img }
        let size = CGSize(width: img.size.width * s, height: img.size.height * s)
        return UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    }

    private func set(_ v: String?) {
        guard let i = browser.profiles.firstIndex(where: { $0.id == browser.profile.id }) else { return }
        browser.profiles[i].wallpaper = v
        browser.saveSettings()
    }
}
