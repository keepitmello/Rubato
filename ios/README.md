# Rubato Chat for iOS 26

**IMPLEMENTED, RENDER VERIFICATION PENDING**

ChatLayout을 유일한 메시지 배치 엔진으로 쓰고, Exyte/Chat의 메시지·입력창·답장·반응·첨부·음성녹음 구성을 이식한 iOS 26 전용 샘플 앱이다. Rubato 하네스와 아직 연결하지 않아도 세션 목록부터 메시지 전송, 가짜 에이전트 스트리밍, 취소·재시도까지 독립적으로 실행할 수 있다.

현재 환경은 Linux라 Xcode, iOS 26 시뮬레이터, 실제 기기에서 화면을 열어보지는 못했다. 소스 파싱, 핵심 상태 로직 형 검사, 가짜 통신과 채팅 저장소 상태 전이 실행, 마크다운 파서 실행, Xcode 프로젝트 파일 검사는 끝냈다. 실제 빌드·시험·화면 확인 절차는 `IMPLEMENTATION_HANDOFF.md`에 적었다.

## 구현된 화면과 동작

- iOS 메시지 앱 형태의 세션 목록, 검색, 고정, 삭제, 새 세션
- ChatLayout 기반 채팅 화면과 이전 메시지 추가 시 위치 보존
- 사용자 메시지의 Exyte형 말풍선, 묶음 간격, 시간·전송 상태
- 넓은 에이전트 응답 본문과 마크다운·코드 블록
- 빠른 응답 조각을 40밀리초 단위로 합쳐 갱신하는 스트리밍
- 사용자가 아래를 보고 있을 때만 자동 추적하고, 위를 읽을 때는 위치 유지
- 응답 중단, 오류 표시, 사용자 메시지 재전송, 에이전트 응답 재시도
- 답장, 복사, 반응 추가와 기존 반응 다시 누르기
- 사진과 파일 첨부, 첨부 미리보기, Quick Look 열기
- 짧게 눌러 잠금 녹음, 길게 누르는 동안 녹음, 왼쪽 취소, 위쪽 잠금
- 음성 파형, 재생·일시정지·탐색
- iOS 26 시스템 유리 효과와 `keyboardLayoutGuide` 입력창 고정
- VoiceOver 이름, 동적 글자 크기 기반 시스템 글꼴, 밝은/어두운 화면 대응

## 구조

```text
ConversationListView
└─ AppModel
   ├─ ChatSessionProvider        세션 목록·생성·삭제·고정 경계
   └─ ChatRoomStore
      ├─ ChatTransport           메시지·스트리밍·취소 경계
      ├─ AudioRecordingController
      └─ AudioPlaybackCenter

ChatRoomScreen
└─ ChatCollectionViewController
   ├─ UICollectionView
   ├─ CollectionViewChatLayout   유일한 목록/스크롤 엔진
   ├─ UIHostingConfiguration
   │  └─ MessageRowView          이식한 Exyte형 사용자 UI + 넓은 에이전트 UI
   └─ UIHostingController
      └─ MessageComposerView     이식한 입력·첨부·녹음 UI
```

Exyte/Chat 패키지는 설치하지 않는다. 이 프로젝트는 Exyte의 사용자 화면 구성과 동작을 현재 자료형에 맞게 이식했고, 채팅 목록 엔진은 ChatLayout 하나만 쓴다. 자세한 고지는 `ThirdPartyNotices/ATTRIBUTION.md`에 있다.

## 요구 환경

- macOS
- Xcode 26 이상
- iOS 26 SDK와 iOS 26 시뮬레이터 또는 실제 기기
- Swift Package Manager가 GitHub에서 ChatLayout 고정 리비전을 받을 수 있는 네트워크

## 열기와 실행

1. `RubatoChatDemo.xcodeproj`를 Xcode로 연다.
2. 패키지 해석이 끝날 때까지 기다린다.
3. `RubatoChatDemo` 스킴을 고른다.
4. 설치된 iOS 26 시뮬레이터나 실제 기기에서 실행한다.
5. 음성녹음을 처음 누를 때 마이크 권한을 허용한다.

명령줄 검증은 다음처럼 실행한다.

```bash
./Scripts/verify_static.sh

export DESTINATION='platform=iOS Simulator,name=<설치된 iOS 26 시뮬레이터>'
./Scripts/local_xcode_verify.sh
```

시뮬레이터 이름은 다음 명령으로 확인할 수 있다.

```bash
xcrun simctl list devices available
```

## 복구 흐름 시험용 입력

가짜 통신 구현에서는 아래 입력을 한 번씩 실패시킨 뒤 같은 메시지로 재시도할 수 있다. 실제 Rubato 명령이 아니라 이 샘플의 로컬 검증 장치다.

- `/send-fail` — 첫 사용자 메시지 전송이 실패하고, 다시 보내면 성공한다.
- `/stream-fail` — 첫 에이전트 응답이 일부 글을 남긴 뒤 오류로 끝나고, 다시 실행하면 완료된다.
- `/silent-end` — 첫 스트림이 완료 이벤트 없이 끝나며 복구 가능한 실패 상태로 바뀌고, 다시 실행하면 완료된다.

## Rubato 연결

`MockChatSessionProvider`와 `MockRubatoTransport`를 실제 구현으로 교체하면 된다. 화면과 ChatLayout 코드는 수정하지 않고, `ChatSessionProvider`와 `ChatTransport` 두 경계에서 Rubato 세션·메시지·응답 조각·취소 명령을 변환하는 방식이다.

연결 계약과 주의점은 `RUBATO_INTEGRATION.md`에 정리했다.
