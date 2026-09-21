# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/compaction/compaction.js` | keep | 앵커 여섯 개(프롬프트 템플릿·`shouldCompact`·커서 thinking 제거·도구호출 폴백 둘) 모두 그대로다. 0.86.0의 모델별 compaction 예산(`compaction.modelOverrides`)은 reserveTokens/keepRecentTokens를 모델별로 가르는 별개 축이고, 우리 비율 임계값(`thresholdRatio`)을 대체하지 않는다. |
| `dist/core/settings-manager.js` | re-cut | 0.86.0이 `getCompactionSettings`에 `model` 인자를 붙였다. 새 시그니처로 다시 걸면서 반환 객체에 `model`도 넣었다 — 우리 `shouldCompact`가 `settings.model`로 비율을 고르는데 0.85.1 패치는 그 키를 채운 적이 없어서 모델별 기본값(`*grok*` 등)이 한 번도 발동하지 않았다. |
| `dist/api/anthropic-messages.js` | re-cut | `convertMessages` 시그니처가 바뀌고 `loadedToolNames`가 사라져 뒤쪽 앵커가 죽었다. 그 패치는 media-tools의 `providerNative` 블록이 없으면 조기 반환하므로 **단독 적용 검사로는 안 드러난다** — 합성(media-tools 먼저)에서만 터진다. 루프 머리로 다시 걸었다. |
