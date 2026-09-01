import Foundation

private actor StoreSmokeTransport: ChatTransport {
    private var firstSendFailureIDs: Set<UUID> = []

    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] {
        []
    }

    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] {
        []
    }

    func sendUserMessage(_ message: ChatMessage) async throws {
        if message.text == "/send-fail", firstSendFailureIDs.insert(message.id).inserted {
            throw ChatTransportError.simulatedFailure
        }
    }

    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let response = ChatMessage(
            sessionID: sessionID,
            role: .assistant,
            responseState: .waiting
        )

        return AsyncThrowingStream { continuation in
            continuation.yield(.responseStarted(response))
            continuation.yield(.responseDelta(messageID: response.id, text: "완료된 "))
            continuation.yield(.responseDelta(messageID: response.id, text: "응답"))
            continuation.yield(.responseCompleted(messageID: response.id))
            continuation.finish()
        }
    }

    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async {}
}

private actor SilentStoreSmokeTransport: ChatTransport {
    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] { [] }
    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] { [] }
    func sendUserMessage(_ message: ChatMessage) async throws {}

    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let response = ChatMessage(
            sessionID: sessionID,
            role: .assistant,
            responseState: .waiting
        )
        return AsyncThrowingStream { continuation in
            continuation.yield(.responseStarted(response))
            continuation.yield(.responseDelta(messageID: response.id, text: "부분 응답"))
            continuation.finish()
        }
    }

    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async {}
}

@main
struct StoreRuntimeSmoke {
    @MainActor
    static func main() async {
        await verifyNormalStreamingAndSendRetry()
        await verifySilentEndRecovery()
        print("chat store smoke: OK")
    }

    @MainActor
    private static func verifyNormalStreamingAndSendRetry() async {
        let session = ChatSession(title: "store-smoke", subtitle: "")
        let transport = StoreSmokeTransport()
        let store = ChatRoomStore(session: session, transport: transport) { _ in }
        await store.loadInitialIfNeeded()

        store.draftText = "일반 응답"
        store.sendCurrentDraft()
        await waitUntil { !store.isResponseActive && store.messages.count == 2 }
        precondition(store.messages.last?.text == "완료된 응답")
        precondition(store.messages.last?.responseState == .completed)

        store.draftText = "/send-fail"
        store.sendCurrentDraft()
        await waitUntil {
            guard let lastUser = store.messages.last(where: { $0.role == .user }) else { return false }
            if case .failed = lastUser.deliveryState { return true }
            return false
        }

        guard let failedUser = store.messages.last(where: { $0.role == .user }) else {
            preconditionFailure("실패한 사용자 메시지를 찾지 못했어요")
        }
        store.retrySending(messageID: failedUser.id)
        await waitUntil {
            !store.isResponseActive
                && store.messages.last?.role == .assistant
                && store.messages.last?.responseState == .completed
        }
        precondition(store.messages.last?.text == "완료된 응답")
    }

    @MainActor
    private static func verifySilentEndRecovery() async {
        let session = ChatSession(title: "silent-smoke", subtitle: "")
        let store = ChatRoomStore(
            session: session,
            transport: SilentStoreSmokeTransport()
        ) { _ in }
        await store.loadInitialIfNeeded()
        store.draftText = "완료 신호 누락"
        store.sendCurrentDraft()

        await waitUntil { !store.isResponseActive && store.messages.count == 2 }
        precondition(store.messages.last?.text == "부분 응답")
        guard case let .failed(reason) = store.messages.last?.responseState else {
            preconditionFailure("완료 신호 없는 응답을 실패로 바꾸지 못했어요")
        }
        precondition(reason.contains("완료 신호"))
    }

    @MainActor
    private static func waitUntil(
        attempts: Int = 200,
        condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<attempts {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        preconditionFailure("상태 전이가 제한 시간 안에 끝나지 않았어요")
    }
}
