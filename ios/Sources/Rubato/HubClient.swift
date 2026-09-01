import Foundation

actor HubClient {
    var baseURL: URL
    private(set) var hostId: String?
    private(set) var protocolVersion = RubatoProtocol.minVersion
    private let urlSession: URLSession

    init(baseURL: URL = HostSettings.baseURL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        configuration.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: configuration)
    }

    var origin: String {
        let port = baseURL.port.map { ":\($0)" } ?? ""
        return "\(baseURL.scheme ?? "https")://\(baseURL.host ?? "")\(port)"
    }

    func setBaseURL(_ url: URL) {
        baseURL = url
        hostId = nil
        protocolVersion = RubatoProtocol.minVersion
    }

    func ensureHost() async throws -> HubHost {
        let json = try await get("/host?protocolMin=\(RubatoProtocol.minVersion)&protocolMax=\(RubatoProtocol.version)")
        protocolVersion = RubatoProtocol.negotiatedVersion(from: json)
        let host = HubHost(
            hostId: json.string("hostId") ?? "",
            displayName: json.string("displayName") ?? "Rubato",
            ownerLogin: json.string("ownerLogin") ?? "",
            baseURL: baseURL
        )
        hostId = host.hostId
        return host
    }

    func inventory() async throws -> [JSONObject] {
        try await get("/inventory").objects("sessions")
    }

    func snapshot(liveSessionId: String) async throws -> JSONObject {
        try await get("/live/\(liveSessionId)/snapshot")
    }

    func messages(liveSessionId: String, before: String?, limit: Int) async throws -> JSONObject {
        var query = "limit=\(limit)"
        if let before {
            query += "&before=\(before.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? before)"
        }
        return try await get("/live/\(liveSessionId)/messages?\(query)")
    }

    func createLive(cwd: String, name: String?, thinkingLevel: String?) async throws -> String {
        var body: [String: Any] = ["cwd": cwd, "attachAfterCreate": false]
        if let name, !name.isEmpty { body["name"] = name }
        if let thinkingLevel { body["thinkingLevel"] = thinkingLevel }
        let json = try await send(method: "POST", path: "/live", body: body)
        guard let id = json.string("liveSessionId") else { throw HubClientError.invalidJSON }
        return id
    }

    func terminate(liveSessionId: String, force: Bool) async throws {
        _ = try await send(method: "DELETE", path: "/live/\(liveSessionId)", body: ["force": force])
    }

    func action(
        liveSessionId: String,
        action: String,
        payload: JSONObject,
        expectedRevision: Int? = nil
    ) async throws {
        let hostId = try await resolvedHostId()
        let payloadObject = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: payload.raw))
        var body: [String: Any] = [
            "protocol": RubatoProtocol.name,
            "requestId": UUID().uuidString,
            "hostId": hostId,
            "liveSessionId": liveSessionId,
            "action": action,
            "payload": payloadObject,
        ]
        if let expectedRevision { body["expectedRevision"] = expectedRevision }
        _ = try await send(method: "POST", path: "/live/\(liveSessionId)/actions", body: body)
    }

    func uploadImage(liveSessionId: String, fileName: String, mimeType: String, data: Data) async throws -> String {
        let json = try await send(
            method: "POST",
            path: "/live/\(liveSessionId)/images",
            body: [
                "fileName": fileName,
                "mimeType": mimeType,
                "dataBase64": data.base64EncodedString(),
            ]
        )
        guard let imageId = json.string("imageId") else { throw HubClientError.invalidJSON }
        return imageId
    }

    func gitStatus(liveSessionId: String) async throws -> JSONObject {
        try await get("/live/\(liveSessionId)/git/status")
    }

    func gitDiff(liveSessionId: String) async throws -> JSONObject {
        try await get("/live/\(liveSessionId)/git/diff")
    }

    func gitView(liveSessionId: String) async throws -> GitView {
        let status = try await gitStatus(liveSessionId: liveSessionId)
        let diff = try await gitDiff(liveSessionId: liveSessionId)
        let files = status.objects("files").compactMap { file -> GitFileEntry? in
            guard let path = file.string("path") else { return nil }
            return GitFileEntry(path: path, status: file.string("status") ?? "")
        }
        let hunks = (diff.object("diff")?.array("hunks") ?? []).compactMap { $0 as? String }
        return GitView(
            files: files,
            summary: diff.string("summary") ?? "\(files.count)개 파일 변경",
            diffText: hunks.joined(separator: "\n")
        )
    }

    func artifact(liveSessionId: String, artifactId: String) async throws -> String {
        let json = try await get("/live/\(liveSessionId)/artifacts/\(artifactId)")
        let content = json.string("content") ?? ""
        if json.string("encoding") == "base64", let data = Data(base64Encoded: content) {
            return String(data: data, encoding: .utf8) ?? content
        }
        return content
    }

    func projects() async throws -> [ProjectChoiceItem] {
        let favorites = try await get("/projects/favorites")
        let recent = try await get("/projects/recent")
        let mapped = { (source: String, json: JSONObject) in
            json.objects("projects").compactMap { project -> ProjectChoiceItem? in
                guard let path = project.string("path") else { return nil }
                return ProjectChoiceItem(
                    path: path,
                    label: project.string("label") ?? ConversationMapping.shortPath(path),
                    source: project.string("source") ?? source
                )
            }
        }
        return mapped("favorite", favorites) + mapped("recent", recent)
    }

    func browse(path: String?) async throws -> JSONObject {
        var body: [String: Any] = [:]
        if let path { body["path"] = path }
        return try await send(method: "POST", path: "/projects/browse", body: body)
    }

    func eventTicket() async throws -> String {
        let json = try await send(method: "POST", path: "/auth/ticket", body: ["purpose": "events"])
        guard let ticket = json.string("ticket") else { throw HubClientError.invalidJSON }
        return ticket
    }

    func terminalTicket(liveSessionId: String) async throws -> String {
        let json = try await send(
            method: "POST",
            path: "/live/\(liveSessionId)/terminal/ticket",
            body: ["purpose": "terminal"]
        )
        guard let ticket = json.string("ticket") else { throw HubClientError.invalidJSON }
        return ticket
    }

    func websocketURL(ticket: String, terminal: Bool) throws -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "http" ? "ws" : "wss"
        components?.path = terminal ? "\(RubatoProtocol.apiPrefix)/terminal" : "\(RubatoProtocol.apiPrefix)/ws"
        components?.queryItems = [
            URLQueryItem(name: "ticket", value: ticket),
            URLQueryItem(name: "protocolVersion", value: "\(protocolVersion)"),
        ]
        guard let url = components?.url else { throw HubClientError.invalidURL }
        return url
    }

    func websocketRequest(ticket: String, terminal: Bool) throws -> URLRequest {
        var request = URLRequest(url: try websocketURL(ticket: ticket, terminal: terminal))
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }

    private func resolvedHostId() async throws -> String {
        if let hostId { return hostId }
        return try await ensureHost().hostId
    }

    private func get(_ path: String) async throws -> JSONObject {
        try await send(method: "GET", path: path, body: nil)
    }

    private func send(method: String, path: String, body: [String: Any]?) async throws -> JSONObject {
        let url = try endpoint(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw HubClientError.sessionNotReady
        }
        guard let http = response as? HTTPURLResponse else { throw HubClientError.invalidJSON }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw HubClientError.unauthorized
        }
        if http.statusCode == 503 {
            throw HubClientError.sessionNotReady
        }
        if !(200..<300).contains(http.statusCode) {
            let error = (try? JSONObject.parseObject(data))?.object("error")
            throw HubClientError.http(
                status: http.statusCode,
                code: error?.string("code"),
                message: error?.string("message") ?? "요청을 마치지 못했어요 (\(http.statusCode))."
            )
        }
        if data.isEmpty { return JSONObject() }
        return try JSONObject.parseObject(data)
    }

    private func endpoint(_ path: String) throws -> URL {
        let trimmed = path.hasPrefix("/") ? path : "/\(path)"
        let full = trimmed.hasPrefix("/rubato/") ? trimmed : "\(RubatoProtocol.apiPrefix)\(trimmed)"
        guard let url = URL(string: full, relativeTo: baseURL)?.absoluteURL else {
            throw HubClientError.invalidURL
        }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw HubClientError.invalidURL
        }
        var items = components.queryItems ?? []
        if !items.contains(where: { $0.name == "protocolVersion" }) {
            items.append(URLQueryItem(name: "protocolVersion", value: "\(protocolVersion)"))
        }
        components.queryItems = items
        guard let resolved = components.url else { throw HubClientError.invalidURL }
        return resolved
    }
}
