import Foundation
import UIKit

/// Отчёты о сбоях: при падении приложение записывает файл, при следующем запуске отправляет его на сервер игры
/// (POST /api/app/crash) — админ видит их в «Система → Сбои приложений». Личных данных нет.
enum CrashReporter {
    private static let file = Storage.dir.appendingPathComponent("crash-pending.json")
    /// Путь заранее в виде C-строки: в обработчике сигнала нельзя выделять память.
    private static var cPath: [CChar] = Array(file.path.utf8CString)

    static func install() {
        _ = cPath.count
        NSSetUncaughtExceptionHandler { e in
            CrashReporter.write(kind: "NSException \(e.name.rawValue)", message: e.reason ?? "", stack: e.callStackSymbols.joined(separator: "\n"))
        }
        for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
            signal(sig) { s in
                CrashReporter.writeSignal(s)
                signal(s, SIG_DFL)
                raise(s)
            }
        }
    }

    private static func signalName(_ s: Int32) -> String {
        switch s {
        case SIGABRT: return "SIGABRT"
        case SIGSEGV: return "SIGSEGV"
        case SIGBUS: return "SIGBUS"
        case SIGILL: return "SIGILL"
        case SIGTRAP: return "SIGTRAP"
        case SIGFPE: return "SIGFPE"
        default: return "SIG\(s)"
        }
    }

    /// Сигнал (ошибка Swift — обычно SIGTRAP). Стек — насколько получится в аварийном состоянии.
    private static func writeSignal(_ s: Int32) {
        let message = s == SIGTRAP ? "Ошибка Swift (fatalError, выход за границы массива, nil)" : "Аварийный сигнал \(signalName(s))"
        write(kind: signalName(s), message: message, stack: Thread.callStackSymbols.prefix(60).joined(separator: "\n"))
    }

    private static func write(kind: String, message: String, stack: String) {
        let j: JSON = .object([
            "kind": .string(kind),
            "message": .string(String(message.prefix(1000))),
            "stack": .string(String(stack.prefix(20000))),
            "at": .number((Date().timeIntervalSince1970 * 1000).rounded()),
        ])
        let data = Array(j.jsonText.utf8)
        let fd = open(&cPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        if fd >= 0 {
            _ = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
            close(fd)
        }
    }

    /// Отправить отчёт прошлого запуска, если он есть.
    static func sendPending() {
        guard let data = try? Data(contentsOf: file), let j = JSON.parse(data) else { return }
        let device = deviceModel()
        let os = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
        Task {
            do {
                _ = try await API.post("/app/crash", [
                    "platform": "ios", "version": Config.version, "build": Config.build, "device": device, "os": os,
                    "kind": j["kind"]?.string ?? "crash", "message": j["message"]?.string ?? "", "stack": j["stack"]?.string ?? "",
                    "at": j["at"]?.double ?? 0,
                ])
                try? FileManager.default.removeItem(at: file)
            } catch let e as APIError where e.status == 400 {
                try? FileManager.default.removeItem(at: file)
            } catch {
                // Нет связи — отправим при следующем запуске.
            }
        }
    }

    private static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
    }
}
