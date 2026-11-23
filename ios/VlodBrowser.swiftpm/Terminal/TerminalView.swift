import SwiftUI

/// balnet://terminal — нативный терминал с панелью клавиш (Tab, ↑, ↓, Ctrl+C) и редактором nano для SSH.
struct TerminalView: View {
    @EnvironmentObject private var browser: Browser
    @ObservedObject var engine: TerminalEngine
    @State private var input = ""
    @State private var hpos = -1
    @FocusState private var focused: Bool

    private static let commands = ["help", "ipconfig", "nslookup", "host", "dig", "ping", "traceroute", "whois", "curl", "openssl s_client -connect ", "ssh ", "open ", "clear"]

    var body: some View {
        Group {
            if engine.editor != nil {
                NanoView(engine: engine)
            } else {
                terminal
            }
        }
        .onAppear {
            engine.browser = browser
            focused = true
        }
    }

    private var terminal: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(engine.lines.joined(separator: "\n"))
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Color(red: 0.85, green: 0.93, blue: 0.85))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 6) {
                            Text(engine.busy ? "…" : engine.promptLabel)
                                .foregroundStyle(Color(red: 0.45, green: 0.85, blue: 0.5))
                            Group {
                                if engine.secureInput {
                                    SecureField("", text: $input)
                                } else {
                                    TextField("", text: $input)
                                }
                            }
                            .focused($focused)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.send)
                            .disabled(engine.busy)
                            .onSubmit(submit)
                            .foregroundStyle(.white)
                        }
                        .font(.system(size: 13, design: .monospaced))
                        .id("end")
                    }
                    .padding(10)
                }
                .onChange(of: engine.lines.count) { _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
            keys
        }
        .background(Color(red: 0.07, green: 0.08, blue: 0.09))
        .onTapGesture { focused = true }
    }

    private var keys: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                key("Tab") { complete() }
                key("↑") { historyStep(-1) }
                key("↓") { historyStep(1) }
                key("Ctrl+C") {
                    if engine.ssh != nil && engine.ssh?.session == nil { engine.ssh = nil }
                    input = ""
                }
                key("clear") { engine.lines = [] }
                ForEach(["dig ", "ping ", "nslookup ", "curl -I ", "whois ", "traceroute "], id: \.self) { c in
                    key(c.trimmingCharacters(in: .whitespaces)) { input = c; focused = true }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .background(Color(red: 0.12, green: 0.13, blue: 0.15))
    }

    private func key(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.12)))
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private func submit() {
        let line = input
        input = ""
        hpos = -1
        Task {
            await engine.submit(line)
            focused = true
        }
    }

    private func historyStep(_ d: Int) {
        let h = engine.history
        guard !h.isEmpty else { return }
        if d < 0 {
            hpos = hpos < 0 ? h.count - 1 : max(0, hpos - 1)
            input = h[hpos]
        } else if hpos >= 0 {
            hpos += 1
            if hpos >= h.count { hpos = -1; input = "" } else { input = h[hpos] }
        }
    }

    private func complete() {
        let s = input.lowercased()
        guard !s.isEmpty, !s.contains(" ") else { return }
        if let m = Self.commands.first(where: { $0.hasPrefix(s) }) {
            input = m.hasSuffix(" ") ? m : m + " "
        }
    }
}

/// GNU nano (БалНет): правка файла на сервере хостинга по SSH.
private struct NanoView: View {
    @ObservedObject var engine: TerminalEngine
    @State private var confirmExit = false

    var body: some View {
        VStack(spacing: 0) {
            Text("GNU nano (БалНет) · \(engine.editor?.path ?? "")\(engine.editor?.dirty == true ? " · изменён" : "")")
                .font(.system(size: 13, design: .monospaced))
                .frame(maxWidth: .infinity)
                .padding(6)
                .background(Color.white)
                .foregroundStyle(.black)
            TextEditor(text: Binding(get: { engine.editor?.content ?? "" }, set: { engine.editor?.content = $0 }))
                .font(.system(size: 13, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .scrollContentBackground(.hidden)
                .background(Color(red: 0.07, green: 0.08, blue: 0.09))
                .foregroundStyle(.white)
            HStack(spacing: 18) {
                Button("^S Записать") { Task { await engine.saveEditor() } }
                Button("^X Выход") {
                    if engine.editor?.dirty == true { confirmExit = true } else { engine.editor = nil }
                }
                Spacer()
            }
            .font(.system(size: 13, design: .monospaced))
            .padding(10)
            .background(Color(red: 0.12, green: 0.13, blue: 0.15))
            .foregroundStyle(.white)
        }
        .confirmationDialog("Выйти без сохранения изменений?", isPresented: $confirmExit, titleVisibility: .visible) {
            Button("Выйти без сохранения", role: .destructive) { engine.editor = nil }
            Button("Записать и выйти") { Task { await engine.saveEditor(); engine.editor = nil } }
        }
    }
}
