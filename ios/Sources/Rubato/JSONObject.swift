import Foundation

struct JSONObject: @unchecked Sendable {
    let raw: [String: Any]

    init(_ raw: [String: Any] = [:]) {
        self.raw = raw
    }

    init?(value: Any?) {
        guard let raw = value as? [String: Any] else { return nil }
        self.raw = raw
    }

    subscript(_ key: String) -> Any? { raw[key] }

    func string(_ key: String) -> String? {
        raw[key] as? String
    }

    func bool(_ key: String) -> Bool? {
        switch raw[key] {
        case let value as Bool: value
        case let value as NSNumber: value.boolValue
        default: nil
        }
    }

    func int(_ key: String) -> Int? {
        switch raw[key] {
        case let value as Int: value
        case let value as Int64: Int(value)
        case let value as Double: Int(value)
        case let value as NSNumber: value.intValue
        case let value as String: Int(value)
        default: nil
        }
    }

    func double(_ key: String) -> Double? {
        switch raw[key] {
        case let value as Double: value
        case let value as Int: Double(value)
        case let value as NSNumber: value.doubleValue
        default: nil
        }
    }

    func object(_ key: String) -> JSONObject? {
        JSONObject(value: raw[key])
    }

    func array(_ key: String) -> [Any] {
        raw[key] as? [Any] ?? []
    }

    func objects(_ key: String) -> [JSONObject] {
        array(key).compactMap(JSONObject.init(value:))
    }

    func strings(_ key: String) -> [String] {
        array(key).compactMap { $0 as? String }
    }

    static func parse(_ data: Data) throws -> Any {
        try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func parseObject(_ data: Data) throws -> JSONObject {
        guard let object = JSONObject(value: try parse(data)) else {
            throw HubClientError.invalidJSON
        }
        return object
    }
}

extension Error {
    var isMissingHubRoute: Bool {
        guard case let .http(status, _, _) = self as? HubClientError else { return false }
        return status == 404 || status == 405 || status == 503
    }
}

enum HubClientError: LocalizedError, Sendable {
    case invalidJSON
    case invalidURL
    case http(status: Int, code: String?, message: String)
    case unauthorized
    case missingHostId
    case sessionNotReady

    var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "허브 응답을 읽지 못했어요."
        case .invalidURL:
            return "호스트 주소가 올바르지 않아요."
        case .sessionNotReady:
            return "이 세션은 아직 대화 입력을 받을 수 없어요. 비상 터미널을 쓰거나, 맥에서 세션이 준비될 때까지 기다려 주세요."
        case let .http(status, code, message):
            if status == 503 || code == "busy" {
                return HubClientError.sessionNotReady.errorDescription
            }
            return message
        case .unauthorized:
            return "Mac 허브 인증에 실패했어요. Tailscale 연결과 페어링을 확인하세요."
        case .missingHostId:
            return "호스트 정보를 아직 받지 못했어요."
        }
    }
}
