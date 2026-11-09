import Foundation
import Security
import LocalAuthentication

/// Связка ключей iOS: токен и ключ синхронизации, пароли сайтов, PIN карт (под Face ID).
enum Keychain {
    private static let service = "io.qzz.vladislavb.vlodbrowser"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// Обычная запись: доступна, пока устройство разблокировано, и не уходит в резервные копии других устройств.
    static func set(_ data: Data, for account: String) {
        delete(account)
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func get(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    static func setJSON(_ v: JSON, for account: String) { set(Data(v.jsonText.utf8), for: account) }
    static func getJSON(_ account: String) -> JSON? { get(account).flatMap { JSON.parse($0) } }

    // MARK: Под Face ID: прочитать можно только после проверки владельца (Face ID / Touch ID / код-пароль)

    static func setProtected(_ data: Data, for account: String) -> Bool {
        delete(account)
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, nil) else { return false }
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessControl as String] = access
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    /// Чтение с системным запросом Face ID (в фоне — не блокирует интерфейс).
    static func getProtected(_ account: String, reason: String) async -> Data? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let ctx = LAContext()
                ctx.localizedReason = reason
                var q = query(account)
                q[kSecReturnData as String] = true
                q[kSecMatchLimit as String] = kSecMatchLimitOne
                q[kSecUseAuthenticationContext as String] = ctx
                var out: AnyObject?
                let status = SecItemCopyMatching(q as CFDictionary, &out)
                cont.resume(returning: status == errSecSuccess ? out as? Data : nil)
            }
        }
    }
}

/// Проверка владельца: Face ID, Touch ID или код-пароль устройства.
enum OwnerAuth {
    /// true — подтверждено. Если на устройстве нет ни кода, ни Face ID, проверять нечем — разрешаем (игра).
    static func confirm(_ reason: String) async -> Bool {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            return (err as? LAError)?.code == .passcodeNotSet
        }
        do {
            return try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }

    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "код-пароль"
        }
    }
}
