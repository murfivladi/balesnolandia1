import SwiftUI

/// Сетка вкладок (как в Chrome для iOS): миниатюры, свайп закрывает, переключатель обычные / инкогнито.
struct TabGridView: View {
    @EnvironmentObject private var browser: Browser
    @Binding var isPresented: Bool
    @State private var mode = 0

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(browser.tabs) { t in
                        TabCard(tab: t, runtime: browser.runtime(t.id), active: t.id == browser.activeId) {
                            browser.select(t.id)
                            isPresented = false
                        } onClose: {
                            withAnimation { browser.close(t.id) }
                        }
                    }
                }
                .padding(14)
            }
            .background(browser.incognito ? Theme.incognito : Color(uiColor: .systemGroupedBackground))
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Режим", selection: $mode) {
                        Image(systemName: "square.on.square").tag(0)
                        Image(systemName: "eyeglasses").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 140)
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Закрыть все", role: .destructive) { browser.closeAll() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Готово") { isPresented = false }.bold()
                }
                ToolbarItem(placement: .bottomBar) {
                    Button {
                        browser.newTab()
                        isPresented = false
                    } label: {
                        Label(browser.incognito ? "Новая вкладка инкогнито" : "Новая вкладка", systemImage: "plus.circle.fill")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        }
        .environment(\.colorScheme, browser.incognito ? .dark : colorScheme)
        .onAppear { mode = browser.incognito ? 1 : 0 }
        .onChange(of: mode) { m in browser.setIncognito(m == 1) }
    }

    @Environment(\.colorScheme) private var colorScheme
}

private struct TabCard: View {
    @EnvironmentObject private var browser: Browser
    let tab: Tab
    @ObservedObject var runtime: TabRuntime
    let active: Bool
    let onOpen: () -> Void
    let onClose: () -> Void
    @State private var offset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Favicon(url: tab.url, size: 16)
                Text(tab.title.isEmpty ? Balnet.display(tab.url) : tab.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button(action: onClose) { Image(systemName: "xmark").font(.caption2.bold()) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Закрыть вкладку")
            }
            .padding(8)
            ZStack {
                Color(uiColor: .secondarySystemBackground)
                if let img = runtime.snapshot {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    VStack(spacing: 6) {
                        Favicon(url: tab.url, size: 36)
                        Text(Balnet.display(tab.url)).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .padding(8)
                }
            }
            .frame(height: 170)
            .clipped()
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(uiColor: .systemBackground)))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(active ? Theme.accent : Color.secondary.opacity(0.25), lineWidth: active ? 3 : 1))
        .offset(x: offset)
        .opacity(1 - Double(min(abs(offset), 200)) / 300)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .gesture(
            DragGesture(minimumDistance: 20)
                .onChanged { v in if abs(v.translation.width) > abs(v.translation.height) { offset = v.translation.width } }
                .onEnded { v in
                    if abs(v.translation.width) > 110 { onClose() } else { withAnimation(.spring()) { offset = 0 } }
                }
        )
    }
}
