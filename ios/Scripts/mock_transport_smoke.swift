import Foundation

@main
struct MockTransportSmoke {
    static func main() async throws {
        let sessionProvider = MockChatSessionProvider(seed: [])
        let session = try await sessionProvider.createSession()
        let transport = MockRubatoTransport(seed: [session.id: []])
        let user = ChatMessage(
            sessionID: session.id,
            role: .user,
            text: "스트리밍 점검",
            deliveryState: .sending
        )

        try await transport.sendUserMessage(user)
        let stream = await transport.streamAssistantResponse(
            sessionID: session.id,
            respondingTo: user
        )

        var didStart = false
        var didComplete = false
        var assembled = ""
        for try await event in stream {
            switch event {
            case .responseStarted:
                didStart = true
            case let .responseDelta(_, chunk):
                assembled.append(chunk)
            case .responseCompleted:
                didComplete = true
            }
        }

        precondition(didStart, "응답 시작 이벤트가 없어요")
        precondition(didComplete, "응답 완료 이벤트가 없어요")
        precondition(assembled.contains("Rubato"), "응답 조각이 합쳐지지 않았어요")

        let loaded = try await transport.loadInitialMessages(sessionID: session.id, limit: 10)
        precondition(loaded.count == 2, "사용자/에이전트 메시지가 저장되지 않았어요")
        precondition(loaded.first?.deliveryState == .sent, "저장된 사용자 메시지 상태가 달라요")
        precondition(loaded.last?.responseState == .completed, "저장된 응답 상태가 달라요")

        let flakyUser = ChatMessage(
            sessionID: session.id,
            role: .user,
            text: "/send-fail",
            deliveryState: .sending
        )
        do {
            try await transport.sendUserMessage(flakyUser)
            preconditionFailure("첫 /send-fail 전송은 실패해야 해요")
        } catch ChatTransportError.simulatedFailure {
            // 의도한 첫 시도 실패
        }
        try await transport.sendUserMessage(flakyUser)
        let afterRetry = try await transport.loadInitialMessages(sessionID: session.id, limit: 10)
        precondition(afterRetry.contains(where: { $0.id == flakyUser.id }), "재전송된 메시지가 저장되지 않았어요")

        try await sessionProvider.setPinned(sessionID: session.id, isPinned: true)
        let pinnedSessions = try await sessionProvider.loadSessions()
        precondition(pinnedSessions.first?.isPinned == true)
        try await sessionProvider.deleteSession(sessionID: session.id)
        let remainingSessions = try await sessionProvider.loadSessions()
        precondition(remainingSessions.isEmpty)

        print("mock transport smoke: OK (\(assembled.count) chars)")
    }
}
