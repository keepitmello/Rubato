# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/session-manager.js` | re-cut | `listAll`이 `(sessionDirOrOnProgress, onProgressOrSignal, signal)`로 바뀌어 앵커가 죽었다. `listPage`/`listAllPage`를 그 앞에 다시 걸고 `signal`을 받아 우리 카탈로그까지 내려보낸다. 되돌려 내보내는 `listAll` 선언도 새 시그니처로 고쳤다 — 안 고치면 업스트림의 signal 지원이 조용히 사라진다. |
| `dist/core/session-manager.d.ts` | re-cut | `SessionListProgress`가 `partialSessions`를 얻어 앵커가 죽었다. 페이지 타입은 그 앞에 붙이고, `list` 선언 앵커는 `signal`까지 포함한 줄로 다시 걸었다. |
