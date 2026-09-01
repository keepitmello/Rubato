import Foundation

enum RubatoProtocol {
    static let name = "rubato.remote.v1"
    static let minVersion = 1
    static let version = 2
    static let apiPrefix = "/rubato/api/v1"

    static func negotiatedVersion(from json: JSONObject) -> Int {
        let version = json.object("negotiation")?.int("version")
            ?? json.object("protocol")?.int("max")
            ?? minVersion
        return min(max(version, minVersion), self.version)
    }
}

struct HubHost: Sendable, Hashable {
    var hostId: String
    var displayName: String
    var ownerLogin: String
    var baseURL: URL
}

struct ProjectChoiceItem: Identifiable, Hashable, Sendable {
    var id: String { path }
    var path: String
    var label: String
    var source: String
}

struct RemoteTreeEntry: Identifiable, Hashable, Sendable {
    var id: String
    var label: String
    var current: Bool
}

struct RemoteCommand: Identifiable, Hashable, Sendable {
    var id: String { name }
    var name: String
    var description: String
    var category: String
    var remoteMode: String
}

struct RemoteUiOption: Identifiable, Hashable, Sendable {
    var id: String { value }
    var label: String
    var value: String
}

struct RemoteUiRequest: Hashable, Sendable {
    var requestId: String
    var kind: String
    var title: String
    var message: String?
    var options: [RemoteUiOption]
    var placeholder: String?
}

struct RemoteTool: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var summary: String
    var status: String
    var output: String?
    var artifactId: String?
}

struct RemoteImage: Identifiable, Hashable, Sendable {
    var id: String
    var alt: String
    var url: String
}

struct GitFileEntry: Identifiable, Hashable, Sendable {
    var id: String { path }
    var path: String
    var status: String
}

struct GitView: Sendable {
    var files: [GitFileEntry]
    var summary: String
    var diffText: String
}

struct ConversationEntry: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case message
        case thinking
        case tool
        case image
        case notice
    }

    var id: String
    var kind: Kind
    var role: String? = nil
    var text: String = ""
    var streaming: Bool = false
    var at: Date? = nil
    var name: String? = nil
    var summary: String? = nil
    var status: String? = nil
    var output: String? = nil
    var artifactId: String? = nil
    var alt: String? = nil
    var url: String? = nil
    var requestRunId: String? = nil
    var phase: String? = nil
    var delivery: String? = nil
}

struct HubEvent: Sendable {
    var type: String
    var liveSessionId: String
    var seq: Int
    var at: String
    var payload: JSONObject
    var messageId: String?
}

struct SessionSnapshot: Sendable {
    var liveSessionId: String
    var hostId: String
    var revision: Int
    var lastSeq: Int
    var title: String
    var cwd: String
    var execution: String
    var lifecycle: String
    var modelLabel: String
    var thinkingLevel: String?
    var backgroundLabels: [String]
    var entries: [ConversationEntry]
    var tree: [RemoteTreeEntry]
    var commands: [RemoteCommand]
    var uiRequest: RemoteUiRequest?
    var tools: [RemoteTool]
    var images: [RemoteImage]
    var capabilities: [String] = []
}

@MainActor
final class RubatoSessionExtras: ObservableObject {
    struct Snapshot: Sendable {
        var lastSeq: Int = 0
        var revision: Int = 0
        var execution: String = "idle"
        var cwd: String = ""
        var modelLabel: String = ""
        var thinkingLevel: String?
        var tools: [RemoteTool] = []
        var images: [RemoteImage] = []
        var uiRequest: RemoteUiRequest?
        var tree: [RemoteTreeEntry] = []
        var commands: [RemoteCommand] = []
        var backgroundLabels: [String] = []
        var connection: String = "offline"
        var capabilities: [String] = []

        var acceptsChat: Bool {
            capabilities.contains("standard-ui") || capabilities.contains("interactive-control")
        }

        var isTerminalOnly: Bool {
            capabilities.contains("terminal-required") && !acceptsChat
        }
    }

    @Published var bySession: [UUID: Snapshot] = [:]

    func snapshot(for sessionID: UUID) -> Snapshot {
        bySession[sessionID] ?? Snapshot()
    }

    func update(_ sessionID: UUID, mutate: (inout Snapshot) -> Void) {
        var value = snapshot(for: sessionID)
        mutate(&value)
        bySession[sessionID] = value
    }
}

enum HostSettings {
    static let defaultBaseURL = URL(string: "https://wy-mac.tail4fd4a3.ts.net")!
    private static let urlKey = "rubato.hostBaseURL"
    private static let pinKey = "rubato.pinnedSessionIDs"

    static var baseURL: URL {
        get {
            if let stored = UserDefaults.standard.string(forKey: urlKey),
               let url = URL(string: stored),
               let scheme = url.scheme,
               scheme == "https" || scheme == "http"
            {
                return url
            }
            return defaultBaseURL
        }
        set {
            UserDefaults.standard.set(newValue.absoluteString, forKey: urlKey)
        }
    }

    static var origin: String {
        let url = baseURL
        return "\(url.scheme ?? "https")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"
    }

    static var pinnedIDs: Set<UUID> {
        get {
            let values = UserDefaults.standard.stringArray(forKey: pinKey) ?? []
            return Set(values.compactMap(UUID.init(uuidString:)))
        }
        set {
            UserDefaults.standard.set(newValue.map(\.uuidString), forKey: pinKey)
        }
    }
}

enum ConversationMapping {
    static func entries(from values: [Any]) -> [ConversationEntry] {
        values.compactMap { value in
            guard let object = JSONObject(value: value), let id = object.string("id") else { return nil }
            let kind = ConversationEntry.Kind(rawValue: object.string("kind") ?? "message") ?? .message
            return ConversationEntry(
                id: id,
                kind: kind,
                role: object.string("role"),
                text: object.string("text") ?? "",
                streaming: object.bool("streaming") ?? false,
                at: object.string("at").map(ISO8601Dates.parse),
                name: object.string("name"),
                summary: object.string("summary"),
                status: object.string("status"),
                output: object.string("output"),
                artifactId: object.string("artifactId"),
                alt: object.string("alt"),
                url: object.string("url"),
                requestRunId: object.string("requestRunId"),
                phase: object.string("phase"),
                delivery: object.string("delivery")
            )
        }
    }

    static func chatMessages(sessionID: UUID, entries: [ConversationEntry]) -> [ChatMessage] {
        entries.compactMap { entry in
            guard entry.kind == .message else { return nil }
            let role: ChatRole = entry.role == "user" ? .user : entry.role == "system" ? .system : .assistant
            return ChatMessage(
                id: RemoteID.uuid(from: entry.id),
                sessionID: sessionID,
                role: role,
                text: entry.text,
                createdAt: entry.at ?? .now,
                deliveryState: .sent,
                responseState: role == .assistant
                    ? (entry.streaming ? .streaming : .completed)
                    : .none
            )
        }
        .sorted { $0.createdAt < $1.createdAt }
    }

    static func session(from summary: JSONObject, pinned: Set<UUID>) -> ChatSession? {
        guard let liveSessionId = summary.string("liveSessionId") else { return nil }
        let id = RemoteID.uuid(from: liveSessionId)
        let execution = summary.string("execution") ?? "idle"
        let lifecycle = summary.string("lifecycle") ?? "ready"
        let presentation = summary.object("presentation")
        let activeStatus = presentation?.object("activeRequest")?.string("status")
        let state: ChatSessionState
        if lifecycle == "exited" || lifecycle == "degraded" {
            state = .failed
        } else if activeStatus == "awaiting_input" {
            state = .waitingForUser
        } else if execution == "working" || lifecycle == "starting" {
            state = .running
        } else {
            state = .idle
        }
        let preview = presentation?.string("lastFinalResponsePreview")
            ?? summary.string("cwd").map { shortPath($0) }
            ?? "Rubato 세션"
        return ChatSession(
            id: id,
            title: summary.string("title").flatMap { $0.isEmpty ? nil : $0 } ?? shortPath(summary.string("cwd") ?? liveSessionId),
            subtitle: preview,
            updatedAt: ISO8601Dates.parse(summary.string("lastAssistantAt") ?? summary.string("createdAt")),
            unreadCount: 0,
            state: state,
            isPinned: pinned.contains(id)
        )
    }

    static func shortPath(_ path: String) -> String {
        path.replacingOccurrences(of: "^/Users/[^/]+", with: "~", options: .regularExpression)
    }

    static func tools(from entries: [ConversationEntry]) -> [RemoteTool] {
        entries.filter { $0.kind == .tool }.map {
            RemoteTool(
                id: $0.id,
                name: $0.name ?? "도구",
                summary: $0.summary ?? $0.text,
                status: $0.status ?? "running",
                output: $0.output,
                artifactId: $0.artifactId
            )
        }
    }

    static func images(from entries: [ConversationEntry]) -> [RemoteImage] {
        entries.filter { $0.kind == .image }.map {
            RemoteImage(id: $0.id, alt: $0.alt ?? $0.text, url: $0.url ?? "")
        }
    }

    static func uiRequest(from object: JSONObject?) -> RemoteUiRequest? {
        guard let object, let requestId = object.string("requestId"), let title = object.string("title") else {
            return nil
        }
        let options = object.objects("options").compactMap { option -> RemoteUiOption? in
            guard let label = option.string("label"), let value = option.string("value") else { return nil }
            return RemoteUiOption(label: label, value: value)
        }
        return RemoteUiRequest(
            requestId: requestId,
            kind: object.string("kind") ?? "input",
            title: title,
            message: object.string("message"),
            options: options,
            placeholder: object.string("placeholder")
        )
    }
}
