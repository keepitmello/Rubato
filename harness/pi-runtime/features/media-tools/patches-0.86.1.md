# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/api/openai-responses-shared.js` | re-cut | 0.86.0이 `transformMessages` 호출을 `normalizedContext.messages`로 바꿔 앵커가 죽었다. `options`를 넘기는 의도는 그대로다(그 4번째 인자는 `providers:transform-messages-preserve`가 연다). 업스트림이 `options.deferredTools`/`deferredToolsMode`를 지운 것은 우리가 손대는 구간이 아니다. |
| `dist/types.d.ts` | keep | `Usage`·`AssistantMessage.content` 앵커 그대로. 0.86.1은 `ProviderNativeContent`를 들여오지 않았으므로 우리 타입 추가는 여전히 유일하다. |
| `dist/api/anthropic-messages.js` | re-cut | 세 곳이 죽었다: 도구호출 블록이 `context.tools` 대신 `currentTools`를 쓰고, `convertMessages` 시그니처가 바뀌었고, assistant 분기에 `flushPendingSystemMessages()`가 들어왔다. 같은 의도로 다시 걸고 `model`을 7번째 인자로 넘긴다. `supportsWebSearch`는 0.85.1에도 없던 플래그라 재생 가드의 동작은 두 버전에서 같다. |
