# Rubato 연결 안내

이 샘플의 채팅 화면은 Rubato 통신 방식과 분리돼 있다. 로컬 저장소에서 `MockChatSessionProvider`와 `MockRubatoTransport`를 실제 구현으로 바꾸면 된다.

## 1. 세션 목록 경계

`ChatSessionProvider`는 다음 네 동작을 맡는다.

```swift
protocol ChatSessionProvider: Sendable {
    func loadSessions() async throws -> [ChatSession]
    func createSession() async throws -> ChatSession
    func deleteSession(sessionID: UUID) async throws
    func setPinned(sessionID: UUID, isPinned: Bool) async throws
}
```

Rubato의 세션 식별자가 UUID가 아니라면 변환표를 영구 저장하거나, `ChatSession.id` 자료형을 확정된 Rubato 식별자 형식으로 한 번만 바꿔야 한다. 화면 안에서 임시 UUID를 매번 새로 만들면 앱 재실행 뒤 같은 세션을 찾지 못한다.

`ChatSession.state`는 다음처럼 대응하면 된다.

| Rubato 상태 | 앱 상태 |
|---|---|
| 실행 중, 모델 응답 중, 도구 실행 중 | `.running` |
| 사용자 승인이나 입력을 기다림 | `.waitingForUser` |
| 정상 대기·완료 | `.idle` |
| 복구가 필요한 실패 | `.failed` |

## 2. 메시지와 스트리밍 경계

`ChatTransport`가 채팅방 자료를 맡는다.

```swift
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
```

에이전트 응답은 한 메시지를 다음 순서로 갱신한다.

```text
responseStarted(assistantMessage)
responseDelta(messageID, chunk) 0회 이상
responseCompleted(messageID)
```

중요한 조건은 다음과 같다.

1. `responseStarted`의 메시지 ID와 모든 후속 이벤트의 ID가 같아야 한다.
2. 조각은 이미 누적된 전체 문자열이 아니라 새로 들어온 부분만 보낸다.
3. 완료 이벤트는 마지막 조각 뒤 한 번만 보낸다.
4. 스트림이 오류를 던지면 화면은 지금까지 받은 부분을 남긴 채 실패 상태와 재시도 버튼을 보여준다.
5. 오류 없이 스트림이 닫혀도 완료 이벤트가 없으면 화면은 연결 실패로 처리한다.
6. 소비 `Task`가 취소되면 네트워크 읽기와 서버 실행도 가능한 범위에서 중단한다.
7. 응답 메시지가 아직 만들어지기 전에도 취소할 수 있으므로 `messageID`는 선택값이다.

## 3. 순서와 중복 방지

- 초기·과거 메시지는 `createdAt` 오름차순으로 정렬할 수 있어야 한다.
- 같은 메시지는 언제 다시 받아도 같은 `id`를 써야 한다.
- 과거 메시지 요청은 `before`보다 이전 자료만 반환한다.
- 한 페이지에 중복 ID가 들어와도 `ChatRoomStore`가 기존 메시지를 한 번 걸러내지만, 실제 통신 계층에서도 중복을 막는 편이 좋다.
- 서버가 시간 순서를 보장하지 않는다면 서버 순번을 모델에 추가하고 그 값을 정렬 기준으로 쓰는 설계 검토가 필요하다.

## 4. 첨부파일

현재 `ChatAttachment.localURL`과 `VoiceClip.localURL`은 기기 안의 파일을 가리킨다. 실제 Rubato 연결에서는 전송 전에 업로드하거나, 하네스가 접근 가능한 통로로 복사한 다음 원격 식별자를 함께 관리해야 한다.

현재 화면이 이해하는 첨부 유형은 사진과 일반 파일이다. 원격 파일을 다시 열어야 한다면 다음 중 하나를 구현한다.

- 내려받은 파일을 앱 캐시에 저장하고 `localURL`을 채운다.
- 첨부 모델에 원격 주소·다운로드 상태를 추가하고, 열기 직전에 내려받는다.

보안 범위가 있는 파일 선택기는 `AttachmentFileStore`가 앱 임시 폴더로 복사한다. 영구 보존이 필요하면 앱 지원 폴더나 별도 저장소로 바꿔야 한다.

## 5. 음성 메시지

녹음은 MPEG-4 AAC, 12kHz, 단일 채널을 기본으로 쓴다. Rubato에서 다른 형식을 요구하면 `AudioRecorderSettings`만 바꿀 수 있다. 서버 업로드가 성공한 뒤 로컬 임시 파일을 지울지, 대화 캐시로 남길지도 통합 단계에서 결정해야 한다.

## 6. 앱에 실제 구현 주입하기

`RubatoChatDemoApp`에서 `AppModel`을 만들 때 두 구현을 넣는다.

```swift
let sessionProvider = RealRubatoSessionProvider(...)
let transport = RealRubatoChatTransport(...)

let appModel = AppModel(
    sessions: [],
    transport: transport,
    sessionProvider: sessionProvider
)
```

실제 앱에서 의존성 보관 방식이 이미 정해져 있다면 그 방식에 맞춰 생성 위치만 옮긴다. `ChatRoomStore`, `ChatCollectionViewController`, 메시지 셀은 Rubato 프로토콜을 알 필요가 없다.

## 7. 재연결과 이어보기

모바일 네트워크가 끊길 수 있으므로 실제 통신 구현은 다음 정보를 보존하는 편이 좋다.

- 세션 ID
- 마지막으로 확정된 메시지 ID 또는 서버 순번
- 진행 중인 응답 ID
- 마지막으로 적용한 응답 조각 위치
- 사용자가 취소했는지 여부

재연결 뒤 서버가 누적 전체 응답을 보내는 방식이라면 `responseDelta`로 바로 전달하지 말고, 현재 화면 문자열과 비교해 새 부분만 계산해야 중복이 생기지 않는다. 계산이 불가능하면 누적 문자열을 교체하는 별도 이벤트를 설계해야 하며, 이 경우 `ChatStreamEvent` 변경을 먼저 검토해야 한다.
