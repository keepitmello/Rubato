# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/sdk.js` | re-cut | 0.86.0이 streamFn 안의 옵션 조립을 `buildRequestOptions`로 빼냈다. `providerExecuteTool`/`providerExecCwd`/`providerExecAgentDir`/`providerExecLineageId` 주입을 그 함수가 돌려주는 객체 안으로 옮겼다 — 요청마다 이 createAgentSession 클로저에서 도구 소유권을 푸는 의도는 그대로다. |
| `dist/agent-loop.js` | re-cut | pi-ai import 목록이 늘어 앵커가 죽었다. `isCursorExecResolved` import를 `./stream-fn.js` 앞에 다시 걸었다(그 심볼은 `providers`가 pi-ai에 심는 `utils/block-symbols.js`에서 온다). 나머지 단계는 그대로 맞는다. |
| `dist/core/extensions/runner.js` | keep | 앵커 두 곳(`emitToolResult`의 `addedToolNames` 전달) 그대로다. `addedToolNames` 자체는 **의도적 keep**이다 — 아래 각주를 볼 것. |
| `dist/core/agent-session.js` | keep | `afterToolCall` 반환에 `addedToolNames`를 싣는 앵커 그대로다. `addedToolNames` 자체는 **의도적 keep**이다 — 아래 각주를 볼 것. |

## 각주 — `addedToolNames`를 지우지 않은 이유

0.86.0이 이 필드의 **소비자를 지웠다**: pi-ai `types.d.ts`의 `ToolResultMessage.addedToolNames`
제거, `utils/deferred-tools.js`(`splitDeferredTools`)·`estimateContextTokens`의 사용 제거,
pi-agent-core `agent-loop.js`의 toolResult 복사 제거. 업스트림은 대신 시스템 메시지의
`toolsAdded`/`toolsRemoved`와 `declareToolChanges`로 같은 일을 한다.

그래도 여기서 지우지 않는다. 이 필드는 아직 **두 feature가 함께 쓰는 살아 있는 계약**이다:
`provider-execution/cursor-exec-bridge.mjs`가 읽고, `tool-execution/runtime.mjs`가 쓰고,
provider-execution 테스트가 `afterToolCall` 전달을 단언한다. 버전 마이그레이션 중에
동작하는 공유 필드를 뜯어내는 것은 얻는 게 없고, 내 feature가 아닌 `tool-execution` 쪽을
깨뜨릴 위험만 만든다. 업스트림의 `toolsAdded` 방식으로 갈아타는 일은 **이 마이그레이션의
범위가 아니다** — `tool-execution`과 함께 보는 별도 후속 작업이고, 그때의 책임자는
owner-ui다(2026-09-20 리드 판정).
