import Foundation

actor MockRubatoTransport: ChatTransport {
    private var messagesBySession: [UUID: [ChatMessage]]
    private var failedSendOnce: Set<UUID> = []
    private var failedStreamOnce: Set<UUID> = []
    private var endedStreamSilentlyOnce: Set<UUID> = []

    init(seed: [UUID: [ChatMessage]]) {
        messagesBySession = seed
    }

    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] {
        let messages = messagesBySession[sessionID, default: []]
        return Array(messages.suffix(limit))
    }

    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] {
        let stored = messagesBySession[sessionID, default: []]
            .filter { $0.createdAt < before }

        if stored.count > limit {
            return Array(stored.suffix(limit))
        }

        guard stored.isEmpty else {
            return stored
        }

        let generated = Self.makeEarlierMessages(sessionID: sessionID, before: before, count: min(limit, 12))
        messagesBySession[sessionID, default: []].insert(contentsOf: generated, at: 0)
        return generated
    }

    func sendUserMessage(_ message: ChatMessage) async throws {
        if message.text.contains("/send-fail"), failedSendOnce.insert(message.id).inserted {
            throw ChatTransportError.simulatedFailure
        }

        var persisted = message
        persisted.deliveryState = .sent
        messagesBySession[message.sessionID, default: []].append(persisted)
    }

    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let responseID = UUID()
        let response = ChatMessage(
            id: responseID,
            sessionID: sessionID,
            role: .assistant,
            text: "",
            createdAt: .now.addingTimeInterval(0.001),
            deliveryState: .sent,
            responseState: .waiting
        )
        let answer = Self.answer(for: message)
        let chunks = Self.chunk(answer, targetSize: 7)
        let shouldFail = message.text.contains("/stream-fail")
            && failedStreamOnce.insert(message.id).inserted
        let shouldEndSilently = message.text.contains("/silent-end")
            && endedStreamSilentlyOnce.insert(message.id).inserted

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await Task.sleep(for: .milliseconds(280))
                    try Task.checkCancellation()
                    continuation.yield(.responseStarted(response))

                    var assembled = ""
                    for (index, chunk) in chunks.enumerated() {
                        try await Task.sleep(for: .milliseconds(32))
                        try Task.checkCancellation()
                        assembled.append(chunk)
                        continuation.yield(.responseDelta(messageID: responseID, text: chunk))

                        let reachedFailurePoint = index >= max(2, chunks.count / 5)
                        if shouldFail, reachedFailurePoint {
                            throw ChatTransportError.simulatedFailure
                        }
                        if shouldEndSilently, reachedFailurePoint {
                            continuation.finish()
                            return
                        }
                    }

                    var completed = response
                    completed.text = assembled
                    completed.responseState = .completed
                    self.persist(completed)
                    continuation.yield(.responseCompleted(messageID: responseID))
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async {
        // 실제 Rubato 연결부에서는 서버/세션 취소 명령을 전달한다.
    }


    private func persist(_ message: ChatMessage) {
        messagesBySession[message.sessionID, default: []].append(message)
    }

    private static func chunk(_ text: String, targetSize: Int) -> [String] {
        var chunks: [String] = []
        var current = ""

        for character in text {
            current.append(character)
            if current.count >= targetSize || character == "\n" {
                chunks.append(current)
                current = ""
            }
        }

        if !current.isEmpty {
            chunks.append(current)
        }
        return chunks
    }

    private static func answer(for message: ChatMessage) -> String {
        let prompt = message.previewText
        return """
        요청을 받았어요. 이 화면은 Rubato 하네스와 연결하기 전에도 채팅 동작을 검증할 수 있도록 만든 독립 예제예요.

        사용자 메시지: **\(prompt)**

        현재 구현에서 확인할 수 있는 항목은 다음과 같아요.

        1. 응답이 들어오는 동안 같은 메시지 셀의 높이가 계속 바뀌어요.
        2. 사용자가 위쪽 내용을 읽고 있으면 화면을 강제로 아래로 끌어내리지 않아요.
        3. 맨 아래를 보고 있을 때는 새 내용이 자연스럽게 따라와요.
        4. 중단과 재시도 상태가 메시지 안에 남아요.

        ```swift
        for try await event in transport.streamAssistantResponse(...) {
            await store.consume(event)
        }
        ```

        실제 Rubato 통합에서는 `ChatTransport` 구현만 교체하면 되고, 메시지 배치와 화면 구성은 그대로 유지돼요.
        """
    }

    private static func makeEarlierMessages(sessionID: UUID, before: Date, count: Int) -> [ChatMessage] {
        (0..<count).map { index in
            let role: ChatRole = index.isMultiple(of: 2) ? .user : .assistant
            return ChatMessage(
                sessionID: sessionID,
                role: role,
                text: role == .user
                    ? "이전 대화 \(count - index)를 다시 확인해 줘."
                    : "이전 실행 기록을 확인했어요. 필요한 부분을 이어서 볼 수 있어요.",
                createdAt: before.addingTimeInterval(TimeInterval(-(count - index) * 90)),
                deliveryState: .sent,
                responseState: role == .assistant ? .completed : .none
            )
        }
    }
}
