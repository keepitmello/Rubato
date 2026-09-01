import Foundation

// MARK: - Conversation

enum ChatRole: String, Codable, Hashable, Sendable {
    case user
    case assistant
    case system
}

enum ChatSessionState: String, Codable, Hashable, Sendable {
    case idle
    case running
    case waitingForUser
    case failed

    var displayName: String {
        switch self {
        case .idle: "대기 중"
        case .running: "작업 중"
        case .waitingForUser: "응답 대기"
        case .failed: "오류"
        }
    }
}

struct ChatSession: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var title: String
    var subtitle: String
    var updatedAt: Date
    var unreadCount: Int
    var state: ChatSessionState
    var isPinned: Bool

    init(
        id: UUID = UUID(),
        title: String,
        subtitle: String,
        updatedAt: Date = .now,
        unreadCount: Int = 0,
        state: ChatSessionState = .idle,
        isPinned: Bool = false
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.updatedAt = updatedAt
        self.unreadCount = unreadCount
        self.state = state
        self.isPinned = isPinned
    }
}

// MARK: - Message content

enum MessageDeliveryState: Hashable, Sendable {
    case queued
    case sending
    case sent
    case failed(String)
}

enum AssistantResponseState: Hashable, Sendable {
    case none
    case waiting
    case streaming
    case completed
    case cancelled
    case failed(String)

    var isActive: Bool {
        switch self {
        case .waiting, .streaming: true
        default: false
        }
    }
}

struct ChatAttachment: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case image
        case file
    }

    let id: UUID
    var kind: Kind
    var displayName: String
    var localURL: URL
    var byteCount: Int64?

    init(
        id: UUID = UUID(),
        kind: Kind,
        displayName: String,
        localURL: URL,
        byteCount: Int64? = nil
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.localURL = localURL
        self.byteCount = byteCount
    }
}

struct VoiceClip: Identifiable, Hashable, Sendable {
    let id: UUID
    var localURL: URL
    var duration: TimeInterval
    var waveformSamples: [Float]

    init(
        id: UUID = UUID(),
        localURL: URL,
        duration: TimeInterval,
        waveformSamples: [Float]
    ) {
        self.id = id
        self.localURL = localURL
        self.duration = duration
        self.waveformSamples = waveformSamples
    }
}

struct MessageReaction: Identifiable, Hashable, Sendable {
    var id: String { emoji }
    var emoji: String
    var count: Int
    var isSelectedByCurrentUser: Bool
}

struct ReplyReference: Hashable, Sendable {
    var messageID: UUID
    var authorName: String
    var preview: String
}

enum UserInputDelivery: String, Hashable, Sendable {
    case submit
    case steer
    case followUp
}

struct ChatMessage: Identifiable, Hashable, Sendable {
    let id: UUID
    let sessionID: UUID
    var role: ChatRole
    var text: String
    var createdAt: Date
    var attachments: [ChatAttachment]
    var voiceClip: VoiceClip?
    var replyTo: ReplyReference?
    var reactions: [MessageReaction]
    var deliveryState: MessageDeliveryState
    var responseState: AssistantResponseState
    var delivery: UserInputDelivery

    init(
        id: UUID = UUID(),
        sessionID: UUID,
        role: ChatRole,
        text: String = "",
        createdAt: Date = .now,
        attachments: [ChatAttachment] = [],
        voiceClip: VoiceClip? = nil,
        replyTo: ReplyReference? = nil,
        reactions: [MessageReaction] = [],
        deliveryState: MessageDeliveryState = .sent,
        responseState: AssistantResponseState = .none,
        delivery: UserInputDelivery = .submit
    ) {
        self.id = id
        self.sessionID = sessionID
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.attachments = attachments
        self.voiceClip = voiceClip
        self.replyTo = replyTo
        self.reactions = reactions
        self.deliveryState = deliveryState
        self.responseState = responseState
        self.delivery = delivery
    }

    var replyReference: ReplyReference {
        let authorName = role == .user ? "나" : "Rubato"
        let rawPreview: String
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            rawPreview = text
        } else if voiceClip != nil {
            rawPreview = "음성 메시지"
        } else if let first = attachments.first {
            rawPreview = first.displayName
        } else {
            rawPreview = "메시지"
        }

        return ReplyReference(
            messageID: id,
            authorName: authorName,
            preview: String(rawPreview.prefix(120))
        )
    }

    var previewText: String {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return text.replacingOccurrences(of: "\n", with: " ")
        }
        if voiceClip != nil { return "음성 메시지" }
        if let first = attachments.first { return first.displayName }
        return "메시지"
    }
}

struct MessageDraft: Hashable, Sendable {
    var text: String = ""
    var attachments: [ChatAttachment] = []
    var voiceClip: VoiceClip?
    var replyTo: ReplyReference?

    var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && attachments.isEmpty
            && voiceClip == nil
    }
}

enum ChatStreamEvent: Hashable, Sendable {
    case responseStarted(ChatMessage)
    case responseDelta(messageID: UUID, text: String)
    case responseCompleted(messageID: UUID)
}

enum MessageGroupPosition: Hashable, Sendable {
    case single
    case first
    case middle
    case last

    var isTop: Bool {
        self == .single || self == .first
    }

    var isBottom: Bool {
        self == .single || self == .last
    }
}
