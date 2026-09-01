# 오픈소스 고지와 이식 범위

## ChatLayout

- 저장소: `ekazaev/ChatLayout`
- 고정 리비전: `cf01193e9d20d448d0005f563063924c667e4496`
- 사용 방식: Swift Package Manager 외부 의존성
- 역할: `UICollectionView` 채팅 배치, 동적 셀 크기, 삽입·삭제·재구성, 위치 스냅샷 복원, 에이전트 응답 확장 배치
- 라이선스: MIT (`ChatLayout-LICENSE.txt`)

ChatLayout 소스 자체를 이 산출물에 복사하지 않았다. Xcode 프로젝트가 위 리비전을 직접 받는다.

## Exyte/Chat

- 저장소: `exyte/Chat`
- 기준 리비전: `e3966b35fe4a8a28f98cbda027da4371ccf5ebe6`
- 사용 방식: 패키지를 실행 의존성으로 넣지 않고, 사용자에게 보이는 채팅 구성과 녹음 동작을 현재 프로젝트 자료형에 맞게 이식
- 라이선스: MIT (`ExyteChat-LICENSE.txt`)

주요 대응 관계는 다음과 같다.

| Exyte 원본 영역 | 이 프로젝트의 대응 파일 |
|---|---|
| `Views/MessageView/MessageView.swift` | `Sources/Views/Chat/MessageRowViews.swift` |
| 첨부파일 그리드와 미리보기 | `Sources/Views/Chat/AttachmentViews.swift` |
| `Views/InputView/InputView.swift` | `Sources/Views/Composer/MessageComposerView.swift` |
| `Views/Recording/Recorder.swift` | `Sources/Services/AudioRecorder.swift` |
| `Views/Recording/RecordingPlayer.swift` | `Sources/Services/AudioPlaybackCenter.swift` |
| `Views/Recording/RecordWaveform.swift` | `Sources/Views/Chat/AudioMessageView.swift` |

이식하면서 구조상 필요한 변경만 적용했다.

1. Exyte의 채팅 목록 엔진과 `ChatView`는 쓰지 않고 ChatLayout 하나로 통일했다.
2. 사용자 메시지는 Exyte의 기본 간격·폭·말풍선·답장·첨부·상태 배치를 유지했다.
3. 에이전트 메시지는 확정된 설계에 따라 말풍선 대신 넓은 본문으로 바꿨다.
4. 입력창의 최소 높이, 모서리, 좌우 간격, 첨부 미리보기, 녹음 상태와 제스처 흐름을 이식했다.
5. iOS 26 전용 시스템 유리 효과와 시스템 사진·파일 선택기를 사용했다.
6. GIF, ExyteMediaPicker, Kingfisher, AnchoredPopup은 포함하지 않았다.
7. 메시지 메뉴는 iOS 시스템 문맥 메뉴로 연결했다. 복사·답장·반응·재시도 기능은 유지하되, Exyte의 자체 전체화면 오버레이 엔진은 가져오지 않았다.

이 프로젝트는 Apple, Exyte 또는 ChatLayout 저자와 제휴하거나 승인을 받은 제품이 아니다.
