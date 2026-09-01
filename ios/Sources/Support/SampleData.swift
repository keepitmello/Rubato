import Foundation

enum SampleData {
    static let primarySessionID = UUID(uuidString: "68C67E61-9452-42B0-B650-2E73717C59C1")!
    static let secondarySessionID = UUID(uuidString: "EC17679B-F3EE-42CD-807A-CA7916E5C0D3")!
    static let tertiarySessionID = UUID(uuidString: "9F75D7D4-9699-4AA2-A511-770947D64A85")!

    static let sessions: [ChatSession] = [
        ChatSession(
            id: primarySessionID,
            title: "rubato-mobile",
            subtitle: "ChatLayout 위에 모바일 채팅 화면을 구성하고 있어요.",
            updatedAt: .now.addingTimeInterval(-120),
            unreadCount: 0,
            state: .running,
            isPinned: true
        ),
        ChatSession(
            id: secondarySessionID,
            title: "txgame",
            subtitle: "실시간 상태 흐름을 다시 확인했어요.",
            updatedAt: .now.addingTimeInterval(-3_600),
            unreadCount: 2,
            state: .waitingForUser,
            isPinned: false
        ),
        ChatSession(
            id: tertiarySessionID,
            title: "hotel-tablet",
            subtitle: "다음 작업을 시작할 준비가 됐어요.",
            updatedAt: .now.addingTimeInterval(-86_400),
            unreadCount: 0,
            state: .idle,
            isPinned: false
        )
    ]

    static var messagesBySession: [UUID: [ChatMessage]] {
        [
            primarySessionID: [
                ChatMessage(
                    sessionID: primarySessionID,
                    role: .assistant,
                    text: "Rubato 모바일 채팅 예제예요. 메시지를 보내면 긴 에이전트 응답이 실시간으로 이어져요.",
                    createdAt: .now.addingTimeInterval(-600),
                    responseState: .completed
                ),
                ChatMessage(
                    sessionID: primarySessionID,
                    role: .user,
                    text: "스트리밍 도중 스크롤이 튀지 않는지 확인해 줘.",
                    createdAt: .now.addingTimeInterval(-540),
                    deliveryState: .sent
                ),
                ChatMessage(
                    sessionID: primarySessionID,
                    role: .assistant,
                    text: "현재 화면은 ChatLayout이 셀 배치와 위치 보존을 맡고, 사용자에게 보이는 구성은 Exyte Chat의 간격과 입력 구조를 옮겨서 만들었어요. 위로 스크롤하면 자동 추적을 멈추고, 다시 맨 아래로 돌아오면 응답을 따라가요.",
                    createdAt: .now.addingTimeInterval(-500),
                    responseState: .completed
                )
            ],
            secondarySessionID: [
                ChatMessage(
                    sessionID: secondarySessionID,
                    role: .user,
                    text: "현재 라운드 상태를 요약해 줘.",
                    createdAt: .now.addingTimeInterval(-4_000)
                ),
                ChatMessage(
                    sessionID: secondarySessionID,
                    role: .assistant,
                    text: "라운드 상태와 소켓 연결 상태를 읽었어요. 실제 하네스 연결은 `ChatTransport` 구현에서 붙이면 돼요.",
                    createdAt: .now.addingTimeInterval(-3_900),
                    responseState: .completed
                )
            ],
            tertiarySessionID: [
                ChatMessage(
                    sessionID: tertiarySessionID,
                    role: .assistant,
                    text: "새 대화를 시작할 수 있어요.",
                    createdAt: .now.addingTimeInterval(-87_000),
                    responseState: .completed
                )
            ]
        ]
    }
}
