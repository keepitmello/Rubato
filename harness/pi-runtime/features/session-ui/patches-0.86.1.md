# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/modes/interactive/interactive-mode.d.ts` | keep | 앵커 `InteractiveModeOptions` 그대로. 0.86.1은 같은 인터페이스에 `terminal?`을 더했고 우리가 넣는 `hosted?`와 겹치지 않는다. |
| `dist/main.js` | keep | `selectSession` 호출에 `signal`이 붙었지만 우리 앵커(`createAgentSessionRuntime` 호출부·`process.exit`·`configureHttp`)는 전부 그대로다. |
| `dist/migrations.js` | keep | 0.86.1에서 바뀐 것은 마이그레이션 안내 URL 두 개뿐이다. |
| `dist/core/session-manager.js` | keep | 세션 발견·압축 경계가 바뀌었지만 우리 앵커(`_rewriteFile`·`_persist`·`appendSessionInfo`)는 셋 다 살아 있다. |
| `dist/core/model-runtime.js` | keep | 0.86.1은 `normalizeContext`만 추가했다. 우리가 import하는 `defaultProviderAuthContext`는 pi-ai 인덱스가 `export * from \"./auth/context.js\"`로 여전히 내보낸다. |
| `dist/modes/rpc/rpc-mode.js` | keep | `steer`/`follow_up`에 `{source:\"rpc\"}`가 붙었지만 우리 앵커(백프레셔 대기·`bindExtensions`·signal 정리)와 무관하다. |
| `dist/modes/interactive/interactive-mode.js` | keep | 0.86.1이 크래시 기록·`/bug`·캐시 워밍 표시·작업 표시기 임베딩을 더했지만 우리 앵커는 모두 살아 있다. 다만 업스트림이 이제 **모든** 상태 표시기를 에디터 테두리에 임베딩하므로(turn-chrome 참고) 런타임 동작은 별도로 볼 것. |
| `dist/utils/clipboard.js` | keep | 0.86.0이 클립보드 계층을 통째로 다시 썼지만 우리가 이 파일에 넣는 것은 컨텍스트 모듈 import 한 줄뿐이다. |
| `dist/core/agent-session.js` | keep | `bindExtensions`·`subscribe`·`bindUiContext`·`bindUiCallback` 앵커 넷 다 그대로다. 0.86.1의 시스템 프롬프트 재작성은 이 seam과 겹치지 않는다. |
| `@earendil-works/pi-tui dist/terminal.js` | keep | import 한 줄만 앞에 붙이는 패치라 앵커가 없다. 0.86.1의 윈도우 네이티브 헬퍼 로딩 변경과 무관하다. |
