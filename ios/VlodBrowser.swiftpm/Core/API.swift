import Foundation

/// Ошибка API в том же виде, что ApiError веб-клиента: status 0 — нет связи с сервером.
struct APIError: Error, LocalizedError {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
}

/// Клиент API игры. Сетевые маршруты БалНета работают без входа, поэтому cookies здесь не нужны.
enum API {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    static func url(_ path: String) -> URL {
        URL(string: Config.api + "/api" + path)!
    }

    static func get(_ path: String) async throws -> JSON {
        try await send(URLRequest(url: url(path)))
    }

    static func post(_ path: String, _ body: [String: Any] = [:], headers: [String: String] = [:]) async throws -> JSON {
        var req = URLRequest(url: url(path))
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req)
    }

    private static func send(_ req: URLRequest) async throws -> JSON {
        var r = req
        r.setValue("VlodBrowser-iOS/\(Config.version)", forHTTPHeaderField: "User-Agent")
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: r)
        } catch {
            throw APIError(status: 0, code: "network", message: "Нет связи с сервером")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = data.isEmpty ? JSON.null : (JSON.parse(data) ?? .null)
        if !(200..<300).contains(status) {
            throw APIError(status: status, code: json["error"]?.string ?? "error", message: json["message"]?.string ?? "Ошибка \(status)")
        }
        return json
    }
}
