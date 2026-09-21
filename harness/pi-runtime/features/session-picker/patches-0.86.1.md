# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/modes/interactive/components/session-selector.js` | re-cut | 0.86.0이 로딩 관리를 `currentLoading/allLoading/allLoadSeq`에서 `AbortController`+`loadScope(scope)`로 다시 썼다. 페이지 적재는 그 위에 얹었다 — 첫 페이지는 `loadScope`가 `pager.apply`로 받고, 더 불러오기는 `loadMore`가 맡는다. **이 패치에서 단계 하나를 삭제했다**: `preserve-selected-path`. 업스트림 `SessionList.setSessions`가 `selectionTouched` 가드로 같은 일을 직접 한다(`session-selector.js`의 필드 236, `setSessions` 295–302, `handleInput` 512). 패치 자체는 re-cut으로 남으므로 삭제는 단계 단위다. |
| `dist/modes/interactive/components/session-selector.d.ts` | re-cut | `SessionsLoader`가 `(onProgress?, signal?)`로 바뀌었다. `(onProgress?, page?, signal?)`로 다시 걸고, `currentPaging/allPaging`·`pagingFor`·`loadMore`·`disposePaging` 선언을 맞췄다. |
| `dist/modes/interactive/interactive-mode.js` | re-cut | 업스트림 로더 호출이 `(onProgress, signal)`로 바뀌어 앵커가 죽었다. 페이지 인자를 끼운 `(onProgress, page, signal)`로 다시 걸었다. |
| `dist/main.js` | re-cut | 같은 이유. `selectSession`에 넘기는 두 로더를 `(onProgress, page, signal)`로 다시 걸었다. |
| `dist/cli/session-picker.d.ts` | re-cut | `SessionsLoader` 타입이 `signal`을 얻어 앵커가 죽었다. `page`까지 받는 형태로 다시 걸었다. |

## 단계 단위 삭제 1건 (패치 단위 삭제 0건)

`preserve-selected-path` 단계만 업스트림에 흡수돼 사라졌다. 이건 텍스트 대조로는 안 잡힌다 —
업스트림은 `canonicalizePath` 비교 대신 `selectionTouched` 가드 + 정확 경로 비교로 다시 썼기
때문이다. 0.86.1 소스를 읽어야만 나온다. 이 마이그레이션 전체에서 유일한 흡수다.

남는 차이 하나: 우리 판은 항상 선택을 보존했고, 업스트림 판은 사용자가 선택을 건드린 뒤에만
보존한다(안 건드렸으면 0번으로 되돌린다). 그리고 업스트림은 경로를 정규화하지 않고 정확 비교한다.
우리 페이징은 같은 카탈로그에서 온 경로만 다루므로 문제되지 않지만, 경로 표기가 갈리는
호출자가 생기면 여기가 먼저 의심할 자리다.
