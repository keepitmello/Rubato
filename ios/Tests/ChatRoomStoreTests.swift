import XCTest
@testable import RubatoChatDemo

@MainActor
final class ChatRoomStoreTests: XCTestCase {
    func testGroupsAdjacentMessagesFromSameRole() async {
        let session = ChatSession(title: "test", subtitle: "")
        let first = ChatMessage(
            sessionID: session.id,
            role: .user,
            text: "첫 메시지",
            createdAt: Date(timeIntervalSince1970: 100)
        )
        let second = ChatMessage(
            sessionID: session.id,
            role: .user,
            text: "둘째 메시지",
            createdAt: Date(timeIntervalSince1970: 120)
        )
        let third = ChatMessage(
            sessionID: session.id,
            role: .assistant,
            text: "응답",
            createdAt: Date(timeIntervalSince1970: 140),
            responseState: .completed
        )
        let transport = ImmediateTransport(seed: [first, second, third])
        let store = ChatRoomStore(session: session, transport: transport) { _ in }

        await store.loadInitialIfNeeded()

        XCTAssertEqual(store.groupPosition(for: first.id), .first)
        XCTAssertEqual(store.groupPosition(for: second.id), .last)
        XCTAssertEqual(store.groupPosition(for: third.id), .single)
    }

    func testStreamingUpdatesOneAssistantMessage() async {
        let session = ChatSession(title: "test", subtitle: "")
        let transport = ImmediateTransport(seed: [])
        let store = ChatRoomStore(session: session, transport: transport) { _ in }

        await store.loadInitialIfNeeded()
        store.draftText = "테스트"
        store.sendCurrentDraft()

        for _ in 0..<50 {
            if !store.isResponseActive, store.messages.count >= 2 { break }
            try? await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertEqual(store.messages.count, 2)
        XCTAssertEqual(store.messages.last?.role, .assistant)
        XCTAssertEqual(store.messages.last?.text, "완료된 응답")
        XCTAssertEqual(store.messages.last?.responseState, .completed)
    }
}

private actor ImmediateTransport: ChatTransport {
    private var messages: [ChatMessage]

    init(seed: [ChatMessage]) {
        messages = seed
    }

    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] {
        Array(messages.suffix(limit))
    }

    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] {
        []
    }

    func sendUserMessage(_ message: ChatMessage) async throws {
        messages.append(message)
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

@MainActor
extension ChatRoomStoreTests {
    func testReactionTogglesWithoutLeavingZeroCountEntry() async {
        let session = ChatSession(title: "test", subtitle: "")
        let message = ChatMessage(sessionID: session.id, role: .assistant, text: "응답")
        let transport = ImmediateTransport(seed: [message])
        let store = ChatRoomStore(session: session, transport: transport) { _ in }

        await store.loadInitialIfNeeded()
        store.toggleReaction(messageID: message.id, emoji: "👍")
        XCTAssertEqual(store.messages.first?.reactions.first?.count, 1)

        store.toggleReaction(messageID: message.id, emoji: "👍")
        XCTAssertTrue(store.messages.first?.reactions.isEmpty == true)
    }

    func testCancellationBeforeResponseMessageExistsReachesTransport() async {
        let session = ChatSession(title: "test", subtitle: "")
        let transport = DelayedStartTransport()
        let store = ChatRoomStore(session: session, transport: transport) { _ in }

        await store.loadInitialIfNeeded()
        store.draftText = "취소 테스트"
        store.sendCurrentDraft()

        for _ in 0..<50 {
            if store.isResponseActive { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(store.isResponseActive)
        XCTAssertNil(store.activeResponseMessageID)

        store.cancelActiveResponse()
        for _ in 0..<50 {
            if await transport.cancellationCount() > 0 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }

        let cancellationCount = await transport.cancellationCount()
        let cancelledMessageID = await transport.cancelledMessageID()
        XCTAssertFalse(store.isResponseActive)
        XCTAssertEqual(store.messages.last?.responseState, .cancelled)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertNil(cancelledMessageID)
    }
}

private actor DelayedStartTransport: ChatTransport {
    private var cancellationCalls = 0
    private var cancelledID: UUID?

    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] { [] }
    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] { [] }
    func sendUserMessage(_ message: ChatMessage) async throws {}

    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await Task.sleep(for: .seconds(1))
                    let response = ChatMessage(
                        sessionID: sessionID,
                        role: .assistant,
                        responseState: .waiting
                    )
                    continuation.yield(.responseStarted(response))
                    continuation.finish()
                } catch {
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async {
        cancellationCalls += 1
        cancelledID = messageID
    }

    func cancellationCount() -> Int { cancellationCalls }
    func cancelledMessageID() -> UUID? { cancelledID }
}


@MainActor
extension ChatRoomStoreTests {
    func testStreamEndingWithoutCompletionBecomesRecoverableFailure() async {
        let session = ChatSession(title: "test", subtitle: "")
        let transport = SilentEndTransport()
        let store = ChatRoomStore(session: session, transport: transport) { _ in }

        await store.loadInitialIfNeeded()
        store.draftText = "완료 신호 누락"
        store.sendCurrentDraft()

        for _ in 0..<100 {
            if !store.isResponseActive, store.messages.count >= 2 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertFalse(store.isResponseActive)
        XCTAssertEqual(store.messages.last?.text, "부분 응답")
        guard case let .failed(reason) = store.messages.last?.responseState else {
            return XCTFail("완료 신호가 없는 스트림을 실패 상태로 남겨야 해요")
        }
        XCTAssertTrue(reason.contains("완료 신호"))
    }
}

private actor SilentEndTransport: ChatTransport {
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
