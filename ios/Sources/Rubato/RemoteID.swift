import CryptoKit
import Foundation

enum RemoteID {
    static func uuid(from remote: String) -> UUID {
        if let parsed = UUID(uuidString: remote) {
            return parsed
        }

        let digest = SHA256.hash(data: Data(remote.utf8))
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}

enum ISO8601Dates {
    static func parse(_ value: String?) -> Date {
        guard let value else { return .now }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? .now
    }
}
