import Foundation

/// Адреса игры и версия приложения. Сервер задан жёстко — сменить в приложении нельзя.
enum Config {
    /// API на VPS: сеть БалНета, шлюз сайтов игроков, игровое время.
    static let api = "https://vps.vladislavb.qzz.io"
    /// Фронтенд госсайтов (Cloudflare Pages): /bank/, /services/, /pos/…
    static let site = "https://bln.vladislavb.qzz.io"
    static let siteHost = "bln.vladislavb.qzz.io"
    static let apiHost = "vps.vladislavb.qzz.io"

    /// Версия приложения — та же, что displayVersion в Package.swift. Сервер сообщает последнюю (GET /api/app/ios).
    static let version = "0.1.0"
    static let build = 1

    static let disclaimer = "Игровой сервис. Не является банком, госорганом, платёжным средством или удостоверением личности."
}
