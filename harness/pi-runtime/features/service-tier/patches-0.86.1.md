# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/settings-manager.js` | re-cut | 0.86.0이 http-dispatcher import와 `isMergeableObject` 사이에 compaction 기본값·`CACHE_WARMING_MODES`를 끼워 넣어 앵커가 죽었다. 삽입 지점을 `function isMergeableObject(value) {` 앞으로 옮겼다. 메서드 단계 앵커(`removeModelThinkingLevel` → `getTransport`)는 그대로다. |
| `dist/core/settings-manager.d.ts` | keep | 타입·필드·메서드 선언 앵커 세 곳 그대로(0.86.1은 캐시 워밍 타입과 `modelOverrides`를 다른 자리에 더했다). |
