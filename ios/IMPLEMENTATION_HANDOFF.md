# IMPLEMENTATION HANDOFF

## 상태

**IMPLEMENTED, RENDER VERIFICATION PENDING**

소스 구현과 현재 환경에서 가능한 정적·부분 실행 검증은 끝났다. 현재 환경이 Linux라 Xcode 26, iOS 26 SDK, 시뮬레이터, 실제 기기에서 빌드하거나 화면을 직접 확인하지 못했다.

## 1. 작업 목적

Rubato 하네스의 모바일 채팅 화면으로 이어 붙일 수 있는 iOS 26 전용 독립 샘플을 구현했다.

핵심 요구사항은 다음과 같다.

- ChatLayout을 유일한 채팅 배치·스크롤 엔진으로 사용한다.
- Exyte/Chat의 사용자 메시지, 입력창, 답장, 반응, 첨부, 음성녹음 배치와 동작을 이식한다.
- Exyte의 자체 목록 엔진이나 `ChatView`는 사용하지 않는다.
- 사용자 메시지는 Exyte형 말풍선으로, 에이전트 응답은 긴 글과 코드를 읽기 좋은 넓은 본문으로 표시한다.
- 스트리밍, 이전 메시지 추가, 키보드 이동, 취소·오류·재시도 상태를 채팅 UI에서 처리한다.
- 실제 Rubato 연결은 별도 통신 구현으로 교체할 수 있게 경계를 둔다.

## 2. 확정된 설계

로컬 검증 중에도 임의로 바꾸지 말아야 할 결정은 다음과 같다.

1. **지원 범위는 iOS 26 전용이다.** 하위 iOS 호환 분기를 추가하지 않는다.
2. **메시지 목록 엔진은 ChatLayout 하나뿐이다.** SwiftUI `List`, `ScrollView`, Exyte `ChatView`를 두 번째 채팅 엔진으로 섞지 않는다.
3. **ChatLayout은 고정 리비전 `cf01193e9d20d448d0005f563063924c667e4496`을 쓴다.** 로컬 검증 중 임의로 최신판으로 올리지 않는다.
4. **Exyte/Chat은 실행 의존성으로 추가하지 않는다.** 기준 리비전 `e3966b35fe4a8a28f98cbda027da4371ccf5ebe6`의 사용자 화면 구성과 음성 동작만 이식한다.
5. **사용자 메시지는 오른쪽 말풍선, 에이전트 메시지는 넓은 본문이다.** 에이전트 응답을 다시 말풍선 안에 가두지 않는다.
6. **입력창은 `inputAccessoryView`가 아니라 `keyboardLayoutGuide`에 붙인다.** iOS 26에서 입력창 수명과 키보드 이동을 안정적으로 다루기 위한 결정이다.
7. **스트리밍은 같은 에이전트 메시지 하나를 계속 갱신한다.** 조각마다 새 메시지를 추가하지 않는다.
8. **빠른 조각은 40밀리초 동안 모아서 화면에 반영한다.** 사용자에게는 실시간으로 보이되 레이아웃 재계산 폭주를 막는다.
9. **사용자가 맨 아래를 보고 있을 때만 응답을 자동 추적한다.** 위쪽 내용을 읽는 중에는 강제로 아래로 이동하지 않는다.
10. **이전 메시지를 앞에 추가할 때 현재 보이는 위치를 보존한다.** ChatLayout 위치 스냅샷을 기준으로 새 인덱스를 보정한다.
11. **실제 Rubato 연결은 `ChatSessionProvider`와 `ChatTransport` 구현 교체로 끝나야 한다.** UI 계층이 Rubato 통신 세부사항을 알게 만들지 않는다.
12. **사진·파일·음성 메시지를 포함한다.** GIF와 외부 미디어 선택기 의존성은 넣지 않는다.
13. **음성 입력은 Exyte 흐름을 따른다.** 짧게 누르면 잠금 녹음, 길게 누르면 누르는 동안 녹음, 왼쪽으로 밀면 취소, 위로 밀면 잠금이다.
14. **iOS 26 시스템 유리 효과를 사용한다.** 자체 모조 유리 렌더러를 만들지 않는다.

## 3. 변경 파일

### 프로젝트와 안내

- `RubatoChatDemo.xcodeproj/project.pbxproj` — iOS 26 앱·단위 시험 대상, ChatLayout 고정 패키지 참조
- `RubatoChatDemo.xcodeproj/xcshareddata/xcschemes/RubatoChatDemo.xcscheme` — 공유 실행·시험 스킴
- `README.md` — 실행 방법, 구현 범위, 구조, 현재 검증 상태
- `RUBATO_INTEGRATION.md` — Rubato 세션·메시지·스트리밍·첨부 연결 계약
- `.gitignore` — Xcode와 빌드 산출물 제외

### 앱과 자료형

- `Sources/App/RubatoChatDemoApp.swift` — 앱 진입점
- `Sources/App/AppModel.swift` — 세션 목록, 방별 저장소, 생성·삭제·고정, 목록 오류 상태
- `Sources/Models/ChatModels.swift` — 세션, 메시지, 첨부, 음성, 답장, 반응, 전송·응답 상태
- `Sources/Support/SampleData.swift` — 독립 실행용 예제 세션과 메시지

### Rubato 교체 경계와 가짜 구현

- `Sources/Services/ChatSessionProvider.swift` — 세션 목록·생성·삭제·고정 계약
- `Sources/Services/ChatTransport.swift` — 메시지 조회·전송·스트리밍·취소 계약
- `Sources/Services/MockChatSessionProvider.swift` — 메모리 기반 세션 구현
- `Sources/Services/MockRubatoTransport.swift` — 메모리 기반 메시지와 실시간 응답 조각 구현

### 파일과 음성

- `Sources/Services/AttachmentFileStore.swift` — 사진·보안 범위 파일을 앱 임시 폴더로 복사
- `Sources/Services/AudioRecorder.swift` — 마이크 권한, 녹음, 파형 표본, Exyte형 녹음 상태
- `Sources/Services/AudioPlaybackCenter.swift` — 음성 재생, 일시정지, 탐색, 진행 상태

### 채팅 상태와 화면

- `Sources/Store/ChatRoomStore.swift` — 메시지 상태, 스트리밍 병합, 취소·재시도, 이전 메시지, 답장·반응, 초안
- `Sources/Views/ConversationList/ConversationListView.swift` — iOS 메시지 앱 형태의 세션 목록
- `Sources/Views/Chat/ChatRoomScreen.swift` — 채팅 화면 진입, 메뉴, 불러오기·오류 상태
- `Sources/Views/Chat/ChatCollectionViewController.swift` — ChatLayout, 차등 스냅샷, 셀 재구성, 위치 보존, 키보드·입력창 연결
- `Sources/Views/Chat/MessageRowViews.swift` — 사용자 말풍선, 넓은 에이전트 응답, 답장·반응·상태·메뉴
- `Sources/Views/Chat/AttachmentViews.swift` — 사진·파일 그리드와 초안 미리보기
- `Sources/Views/Chat/AudioMessageView.swift` — 음성 메시지와 파형
- `Sources/Views/Composer/MessageComposerView.swift` — 텍스트, 사진·파일, 답장, 전송·중단, 음성녹음 제스처
- `Sources/Views/Shared/GlassComponents.swift` — Exyte 치수, iOS 26 유리 효과, 날짜·시간 형식, 햅틱
- `Sources/Views/Shared/MarkdownBlocks.swift` — 에이전트 마크다운과 코드 블록

### 시험과 보조 도구

- `Tests/ChatRoomStoreTests.swift` — 메시지 묶음, 스트리밍, 반응, 응답 시작 전 취소
- `Tests/MarkdownBlockParserTests.swift` — 일반 글과 코드 울타리 파싱
- `Scripts/regenerate_xcodeproj.py` — 파일 목록에서 Xcode 프로젝트를 결정적으로 다시 생성
- `Scripts/verify_static.sh` — 파싱, 핵심 형 검사, 저장소 시험 형 검사, 가짜 통신·마크다운 실행, 프로젝트 검사
- `Scripts/local_xcode_verify.sh` — macOS에서 패키지 해석, 빌드, 단위 시험 실행
- `Scripts/mock_transport_smoke.swift` — 가짜 세션·메시지·스트리밍 실행 점검
- `Scripts/store_runtime_smoke.swift` — 저장소의 스트리밍·전송 재시도·완료 신호 누락 복구 실행 점검
- `Scripts/store_typecheck_stubs.swift` — iOS 화면 모듈 없이 상태 계층을 엄격 동시성 모드로 형 검사하기 위한 보조 선언

### 오픈소스 고지

- `ThirdPartyNotices/ATTRIBUTION.md` — 기준 리비전, 이식 대응, 의도적 차이
- `ThirdPartyNotices/ChatLayout-LICENSE.txt` — ChatLayout MIT 라이선스
- `ThirdPartyNotices/ExyteChat-LICENSE.txt` — Exyte/Chat MIT 라이선스

## 4. 구현 내용

### ChatLayout 연결

`ChatCollectionViewController`가 `UICollectionView`와 `CollectionViewChatLayout`을 직접 소유한다. SwiftUI 메시지 화면은 `UIHostingConfiguration`으로 셀 안에 들어가며, 입력창은 별도 `UIHostingController`로 호스팅한다.

- 모든 메시지는 `.fullWidth` 정렬을 사용하고 내부 SwiftUI가 사용자·에이전트 정렬을 결정한다.
- 내용이 바뀐 기존 메시지는 차등 스냅샷 `reconfigureItems`와 ChatLayout `reconfigureItems(at:)`를 함께 호출한다.
- 새 메시지·삭제 같은 구조 변경만 애니메이션하고, 스트리밍 문자 갱신은 구조 애니메이션 없이 재구성한다.
- 화면 적용 중 새 조각이 들어오면 가장 최신 메시지 배열 하나만 대기시킨 뒤 순서대로 반영한다.
- 메시지 내용뿐 아니라 인접 메시지에 따라 바뀌는 묶음 위치와 날짜 구분선도 비교해 필요한 이웃 셀을 다시 그린다.
- 과거 메시지 추가 전 상단 기준 위치를 저장하고, 추가 개수만큼 인덱스를 이동해 복원한다.
- 현재 사용자 질문을 `indexPathForExtendedLayout`에 연결해 ChatLayout의 에이전트 확장 배치를 사용한다.

### Exyte 화면 이식

Exyte 패키지는 포함하지 않았다. 원본의 메시지·입력·음성 화면을 현재 모델에 맞게 옮겼다.

- 화면 가장자리 12, 사용자 반대쪽 여유 70, 글 안쪽 여백 12
- 입력창 최소 높이 48, 모서리 18
- 사용자 말풍선 모서리 20
- 같은 발신자 묶음 4, 다른 묶음 8
- 204 너비의 첨부 미디어 그리드
- 답장 인용선, 누를 수 있는 반응 캡슐, 전송 상태와 실패한 사용자 메시지 재전송
- 사진·파일 초안 미리보기
- 녹음 시간, 파형, 재생·일시정지·탐색
- 녹음 누르기·밀기 제스처

의도적으로 달라진 부분은 넓은 에이전트 응답, iOS 26 시스템 유리 입력창, 시스템 문맥 메뉴다. 이 셋은 확정된 제품 방향과 두 엔진 중복 제거를 위한 변경이다.

### 스트리밍과 복구

- 사용자 전송이 성공하면 `AsyncThrowingStream`을 연다.
- 시작 이벤트에서 에이전트 메시지 하나를 만든다.
- 응답 조각은 메시지 ID별 버퍼에 더하고 40밀리초 간격으로 한 번에 반영한다.
- 완료 전 남은 조각을 먼저 비운 다음 완료 상태를 기록한다.
- 오류가 나면 받은 글은 남겨두고 실패 상태와 재시도 버튼을 표시한다.
- 사용자가 응답 시작 전에 중단해도 `messageID == nil`인 취소 명령을 통신 계층에 보낸다.
- 사용자 메시지 전송 실패와 에이전트 응답 실패를 별도 상태로 관리한다. 실패한 사용자 상태 표시는 바로 다시 보내는 동작과 연결했다.
- 스트림이 오류 없이 닫히더라도 완료 이벤트가 없으면 부분 응답을 보존한 복구 가능한 실패로 바꾼다.

### 입력과 음성

입력창 하단은 `view.keyboardLayoutGuide.topAnchor`에 묶었다. 사진은 시스템 사진 선택기, 파일은 시스템 파일 선택기를 사용한다.

음성녹음은 AAC, 12kHz, 단일 채널이며 50밀리초마다 음량 표본을 만든다. 녹음 중에도 잠금 햅틱이 나오도록 오디오 세션을 설정했다. 초안 녹음과 메시지 음성은 같은 재생 계층을 공유한다.

### Rubato 연결 준비

- 세션 목록은 `ChatSessionProvider`
- 방별 메시지와 응답은 `ChatTransport`

두 가짜 구현을 실제 구현으로 교체하면 된다. 세부 이벤트 계약은 `RUBATO_INTEGRATION.md`에 있다.

## 5. 아직 실행하지 못한 검증

현재 환경에서는 다음을 실행하지 못했다.

- Xcode 26에서 프로젝트 열기와 Swift Package Manager 패키지 해석
- iOS 26 SDK 기준 전체 앱 형 검사
- `xcodebuild` 앱 빌드와 단위 시험
- iOS 26 시뮬레이터 실행
- 실제 아이폰에서 60Hz·120Hz 스크롤 확인
- Liquid Glass 실제 렌더링과 터치 반응
- 키보드 표시·숨김·대화형 닫기·회전 중 입력창 위치
- `UIHostingConfiguration` 셀의 실제 자체 크기 계산
- ChatLayout 스트리밍 중 실제 화면 위치 보존
- 사진 선택기, 파일 선택기, Quick Look 표시
- 마이크 권한 허용·거절·재요청
- 실제 음성녹음, 블루투스 입력, 전화·오디오 중단
- 음성 파형 탐색과 여러 음성 메시지 간 재생 전환
- VoiceOver 순서와 큰 글자 크기에서 잘림
- 메모리와 프레임 성능
- Rubato 실제 세션·스트림·취소 연결

이 항목들은 성공했다고 간주하면 안 된다.

현재 환경에서 실제로 끝낸 검증은 다음과 같다.

- Swift 6.2.1로 앱·시험 Swift 파일 전체 파싱
- 핵심 모델·두 통신 계약·가짜 구현의 엄격 동시성 형 검사
- 화면 프레임워크 대체 선언을 사용한 `ChatRoomStore`와 `AppModel` 엄격 동시성 형 검사
- 저장소 단위 시험 소스의 비동기 형 검사
- 가짜 세션 생성·고정·삭제, 사용자 전송, 응답 스트리밍, 완료 저장 실행
- `ChatRoomStore`의 정상 스트리밍, 첫 전송 실패 뒤 재전송, 완료 신호 누락 복구 실행
- 마크다운 일반 글·코드 블록·닫히지 않은 울타리 실행
- Xcode 프로젝트 재생성
- `plutil -lint` 프로젝트 파일 검사
- ChatLayout 고정 리비전 포함 검사
- 공유 Xcode 스킴 XML과 앱·시험 대상 식별자 검사
- 첫 전송 실패 뒤 동일 메시지 재전송을 가짜 통신에서 실행

## 6. 로컬 검증 절차

### 6.1 준비

```bash
cd rubato-chat-ios26
xcode-select -p
xcodebuild -version
xcrun simctl list devices available
```

Xcode 26과 iOS 26 시뮬레이터가 보여야 한다.

### 6.2 정적·부분 실행 검증

```bash
./Scripts/verify_static.sh
```

마지막에 다음이 모두 나와야 한다.

```text
mock transport smoke: OK
chat store smoke: OK
markdown parser smoke: OK
RubatoChatDemo.xcodeproj/project.pbxproj: OK
RubatoChatDemo.xcodeproj/xcshareddata/xcschemes/RubatoChatDemo.xcscheme: XML OK
static verification: OK
```

### 6.3 패키지 해석

```bash
xcodebuild \
  -resolvePackageDependencies \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo
```

ChatLayout이 리비전 `cf01193e9d20d448d0005f563063924c667e4496`으로 해석돼야 한다.

### 6.4 빌드와 단위 시험

설치된 시뮬레이터 이름으로 실행한다.

```bash
export DESTINATION='platform=iOS Simulator,name=<설치된 iOS 26 시뮬레이터>'
./Scripts/local_xcode_verify.sh
```

문제가 생기면 개별 명령으로 나눠 확인한다.

```bash
xcodebuild \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo \
  -configuration Debug \
  -destination "$DESTINATION" \
  CODE_SIGNING_ALLOWED=NO \
  clean build

xcodebuild \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo \
  -configuration Debug \
  -destination "$DESTINATION" \
  CODE_SIGNING_ALLOWED=NO \
  test
```

### 6.5 화면 수동 검증

다음 흐름을 처음부터 끝까지 직접 걸어간다.

1. 앱을 열면 세션 목록이 보이고 검색, 고정, 편집 삭제, 밀어서 삭제가 동작한다.
2. 새 세션을 만들면 빈 방으로 이동한다.
3. 짧은 글과 여러 줄 글을 보내면 사용자 말풍선이 오른쪽에 나타난다.
4. 에이전트 답변은 넓은 본문 하나가 실시간으로 커지고 코드 블록이 따로 보인다.
5. 맨 아래에 있을 때 답변을 따라가고, 답변 중 위로 스크롤하면 위치가 고정된다.
6. 아래 화살표를 누르면 최신 메시지로 돌아간다.
7. 답변 중단 뒤 부분 응답과 중단 상태가 남는다.
8. `/send-fail`, `/stream-fail`, `/silent-end`를 각각 보내 첫 실패 뒤 다시 전송·다시 실행이 완료되는지 본다.
9. 메시지를 길게 눌러 복사, 답장, 반응, 재시도를 확인하고, 표시된 반응 캡슐도 직접 눌러 선택·취소한다.
10. 답장을 선택하면 입력창 위 인용 표시가 나타나고 취소할 수 있다.
11. 사진 여러 장과 일반 파일을 첨부하고 제거·전송·열기를 확인한다.
12. 오래된 메시지를 위에 추가해도 현재 보던 메시지가 튀지 않는지 확인한다.
13. 키보드를 대화형으로 내리고 올리며 입력창과 목록 사이 빈 공간·겹침이 없는지 본다.
14. 기기를 회전하고 창 크기를 바꿔 셀 너비와 위치가 정상인지 본다.
15. 밝은 화면, 어두운 화면, 대비 증가, 동작 줄이기에서 읽을 수 있는지 본다.
16. 글자 크기를 접근성 최대로 올려 목록, 말풍선, 에이전트 본문, 입력창이 잘리지 않는지 본다.
17. VoiceOver로 세션 행, 메시지, 첨부, 전송·중단 버튼 순서를 확인한다.

### 6.6 음성 수동 검증

실제 기기에서도 반드시 확인한다.

1. 마이크 권한을 거절하면 오류 안내가 보이고 앱이 멈추지 않는다.
2. 다시 시도해 권한을 허용하면 녹음이 시작된다.
3. 짧게 눌렀을 때 잠금 녹음이 시작되고 정지 뒤 초안 파형이 보인다.
4. 길게 누르고 손을 떼면 음성이 즉시 전송된다.
5. 길게 누른 채 왼쪽으로 밀면 파일을 남기지 않고 취소된다.
6. 길게 누른 채 위로 밀면 잠금 상태가 되고 손을 떼도 계속 녹음된다.
7. 파형을 눌러 위치를 바꾸고 재생·일시정지할 수 있다.
8. 다른 음성 메시지를 재생하면 이전 재생이 자연스럽게 전환되는지 본다.
9. 유선·블루투스·기기 마이크에서 녹음하고 출력 경로를 확인한다.
10. 녹음 중 전화, 알림, 다른 오디오 세션이 끼어들 때 상태를 확인한다.

### 6.7 성능 검증

가짜 응답을 다음 크기로 바꿔 점검한다.

- 5천 자
- 2만 자
- 코드 블록 20개 이상
- 초당 수백 개 응답 조각
- 메시지 1천 개 이상

Instruments에서 메인 스레드 정지, 메모리 증가, 반복 셀 생성, 오디오 파일 누수를 본다. 120Hz 기기에서는 빠르게 위아래로 스크롤하며 눈에 띄는 끊김이 없는지 확인한다.

## 7. 성공 조건

아래 조건을 모두 만족하면 이번 구현을 완료된 것으로 본다.

1. Xcode 26에서 경고를 검토한 뒤 오류 없이 앱이 빌드된다.
2. 포함한 단위 시험이 모두 통과한다.
3. ChatLayout 외에 다른 채팅 목록 엔진이 들어가지 않는다.
4. 사용자 메시지가 Exyte형 오른쪽 말풍선과 확정된 간격으로 표시된다.
5. 에이전트 메시지가 넓은 본문으로 표시되고 긴 글·코드가 읽기 쉽다.
6. 빠른 스트리밍 중 같은 메시지만 커지고 빈 셀·튀는 셀·중복 메시지가 없다.
7. 사용자가 위를 읽을 때 자동으로 아래로 끌려가지 않는다.
8. 과거 메시지를 추가해도 보던 위치가 유지된다.
9. 키보드 이동, 회전, 큰 글자 크기에서 입력창과 메시지가 겹치지 않는다.
10. 사진·파일 첨부와 Quick Look이 동작한다.
11. 네 가지 음성녹음 흐름과 재생·탐색이 실제 기기에서 동작한다.
12. 취소·오류·재시도 상태가 사라지지 않고 복구할 수 있다.
13. 밝은/어두운 화면과 VoiceOver에서 핵심 흐름을 완료할 수 있다.
14. `ChatSessionProvider`와 `ChatTransport` 가짜 구현을 실제 Rubato 구현으로 교체해도 UI·ChatLayout 코드를 다시 설계할 필요가 없다.

## 8. 주의할 부분

- **전체 iOS 형 검사가 아직 안 됐다.** Linux `swiftc`는 SwiftUI, UIKit, AVFoundation, PhotosUI, QuickLook, ChatLayout을 형 검사하지 못했다. Xcode에서 드러나는 단순 서명 차이는 수정해도 된다.
- **ChatLayout 리비전을 고정했다.** 최신판으로 올리면 에이전트 확장 배치나 재구성 동작이 바뀔 수 있다.
- **Exyte 전체 패키지는 의도적으로 제외했다.** 이를 다시 추가하면 목록 엔진과 상태 계층이 중복될 수 있다.
- **시스템 문맥 메뉴를 쓴다.** Exyte의 자체 전체화면 반응 메뉴를 그대로 넣지 않은 것은 의도된 범위다. 이를 바꾸려면 현재 셀 호스팅과 스크롤 상호작용을 실제 기기에서 먼저 검토해야 한다.
- **첨부와 녹음은 임시 폴더를 쓴다.** 앱 재실행 뒤 영구 복원이 필요하면 Rubato 통합 때 영구 저장 정책을 추가해야 한다.
- **원격 첨부 모델이 없다.** 실제 서버 업로드·다운로드 식별자는 `ChatAttachment`와 `VoiceClip`에 추가하거나 별도 매핑 계층에 둬야 한다.
- **응답 조각은 추가분이라는 전제다.** 서버가 누적 전체 문자열을 보낸다면 그대로 연결하면 글이 중복된다.
- **메시지 정렬은 날짜 기준이다.** 서버 순서가 더 강한 의미를 가진다면 순번 필드를 설계해야 한다.
- **음성 중단 복구가 최소 수준이다.** 전화, Siri, 블루투스 경로 변경 같은 실제 중단은 로컬 시험 결과에 따라 단순 구현 보완이 필요할 수 있다.
- **앱 아이콘과 배포 서명은 넣지 않았다.** 샘플 앱 실행에 집중한 결과물이다.
- **Apple 또는 원본 프로젝트와 제휴한 제품이 아니다.** 배포 시 라이선스와 상표 표기를 다시 확인한다.

## 9. 로컬 에이전트의 수정 권한

로컬 검증 중 발견되는 다음 문제는 확정된 설계 의도를 바꾸지 않는 범위에서 개발 에이전트가 직접 수정하고 다시 검증해도 된다.

- Xcode 26에서 달라진 단순 함수 서명이나 형 이름
- Swift 6 엄격 동시성 경고·오류의 격리 표기 보완
- 프로젝트 파일의 이름·경로·대상 포함 누락
- ChatLayout 공개 함수 호출의 사소한 인자 차이
- 오토레이아웃 제약 충돌이나 안전 영역 상수 보정
- 작은 여백·크기 오차를 Exyte 기준값으로 되돌리는 수정
- 단순 시험 실패, 가짜 자료 오류, 접근성 이름 누락
- 마이크 권한 문구·파일 형식·임시 경로의 단순 구현 오류
- 메모리 해제나 관찰자 정리처럼 구조를 바꾸지 않는 수정
- 실제 Rubato 자료형과 현재 어댑터 사이의 이름·변환 차이

다음 문제가 발견되면 임의로 새로운 설계를 선택하지 않는다.

- ChatLayout을 버리거나 다른 목록 엔진을 함께 써야만 해결되는 문제
- Exyte `ChatView` 전체를 실행 의존성으로 다시 넣어야 하는 문제
- 사용자 말풍선·넓은 에이전트 본문이라는 책임 경계를 바꿔야 하는 문제
- 메시지 ID, 순서, 스트리밍 자료 흐름을 근본적으로 바꿔야 하는 문제
- `ChatSessionProvider`와 `ChatTransport`의 경계를 합치거나 UI 안으로 통신을 밀어 넣어야 하는 문제
- 응답 방식이 조각 추가가 아니라 전체 교체여서 새 이벤트 설계가 필요한 문제
- Rubato가 모바일에서 직접 접근할 수 없는 통신 방식을 사용해 외부 중계 구조를 새로 정해야 하는 문제
- 선택한 기술이나 고정 리비전으로 핵심 요구사항을 충족할 수 없는 문제
- 실제 렌더 결과가 Exyte 이식 또는 iOS 26 전용 전제를 깨는 문제
- 여러 대안 중 제품 판단이 다시 필요한 문제

이 경우 억지로 구현을 계속하지 말고 설계 검토로 되돌릴 자료를 만든다. 그 자료에는 반드시 다음을 포함한다.

1. 문제가 발생한 위치
2. 재현 방법
3. 기대했던 결과
4. 실제 결과
5. 기존 설계가 실패하는 이유
6. 영향을 받는 범위
7. 현재 확인된 가능한 대안
8. 어떤 설계 판단을 다시 내려야 하는지

기존 설계 전체를 폐기하지 말고, 실제 실행 결과로 문제가 확인된 부분과 그 영향을 받는 범위만 다시 검토한다.
