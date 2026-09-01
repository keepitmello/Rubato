import Foundation

protocol ChatTransport: Sendable {
    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage]
    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage]
    func sendUserMessage(_ message: ChatMessage) async throws
    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error>
    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async
}

enum ChatTransportError: LocalizedError, Sendable {
    case unavailable
    case simulatedFailure

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "연결할 수 없어요. 네트워크 상태를 확인해 주세요."
        case .simulatedFailure:
            "예제 응답을 만드는 중 오류가 발생했어요."
        }
    }
}
