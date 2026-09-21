# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/extensions/types.d.ts` | keep | `ToolDefinition`·`ToolInfo` 앵커 그대로. 0.86.1은 `exposure`/`searchText` 같은 노출 필드를 들여오지 않았으므로 이 패치의 값은 그대로 유일하다. |
| `dist/core/agent-session.js` | keep | 도구 카탈로그 메타데이터와 직접 노출 필터 앵커 넷 다 그대로다. |
| `dist/core/extensions/index.d.ts` | keep | `wrapRegisteredTool` export 줄 앵커 그대로(0.86.1은 같은 줄의 타입 목록만 늘렸다). |
| `dist/index.d.ts` | keep | `ReadonlyFooterDataProvider` export 앵커 그대로. |
