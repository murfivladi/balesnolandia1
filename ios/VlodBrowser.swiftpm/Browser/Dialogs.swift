import Foundation
import Observation

/// alert / confirm / prompt страниц: показывает браузер, страница ждёт ответа.
@Observable
@MainActor
final class Dialogs {
    struct Item: Identifiable {
        enum Kind { case alert, confirm, prompt }
        let id = UUID()
        let kind: Kind
        let host: String
        let message: String
        var text: String
    }

    var current: Item?
    @ObservationIgnored private var resume: ((Bool, String?) -> Void)?

    private func show(_ item: Item) async -> (Bool, String?) {
        finish(false, nil)
        return await withCheckedContinuation { cont in
            current = item
            resume = { ok, text in cont.resume(returning: (ok, text)) }
        }
    }

    func finish(_ ok: Bool, _ text: String?) {
        let r = resume
        resume = nil
        current = nil
        r?(ok, text)
    }

    func alert(host: String, message: String) async {
        _ = await show(Item(kind: .alert, host: host, message: message, text: ""))
    }

    func confirm(host: String, message: String) async -> Bool {
        await show(Item(kind: .confirm, host: host, message: message, text: "")).0
    }

    func prompt(host: String, message: String, defaultText: String) async -> String? {
        let r = await show(Item(kind: .prompt, host: host, message: message, text: defaultText))
        return r.0 ? (r.1 ?? "") : nil
    }
}
