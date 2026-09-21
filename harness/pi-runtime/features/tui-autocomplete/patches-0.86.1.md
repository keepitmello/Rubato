# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `@earendil-works/pi-tui dist/autocomplete.js` | re-cut | 0.86.1이 `./utils.js` import를 `PATH_DELIMITERS` 앞에 끼워 넣어 앵커가 죽었다. 우리 import를 `const PATH_DELIMITERS = ...` 바로 앞으로 옮겼다. 나머지 세 앵커(선행 슬래시·인라인 스킬·적용)는 그대로다. |
| `@earendil-works/pi-tui dist/components/editor.js` | keep | 앵커 세 곳(import·트리거 분기·슬래시 헬퍼) 그대로. 0.86.1의 자동완성 경계 정규식(CJK 문장부호) 변경은 우리가 대체하는 구간과 겹치지 않는다. |
