# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/modes/interactive/components/tool-execution.js` | keep | 앵커 아홉 개 전부 그대로. 0.86.1은 이미지 변환 캐시를 소스 키로 바꿨을 뿐 접힘/확장 로직은 손대지 않았다. |
| `dist/modes/interactive/interactive-mode.js` | keep | 앵커 열네 개 전부 그대로. 다만 0.86.0이 `setStatusIndicator`/`clearStatusIndicator`에서 `WorkingStatusIndicator` 타입 검사를 걷어내 **모든** 상태 표시기를 에디터 테두리에 임베딩하므로, 우리 phase 라벨과의 상호작용은 런타임에서 따로 볼 것. |
