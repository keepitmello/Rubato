# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/agent-session.js` | keep | `emit(this._sessionStartEvent)` 앵커 그대로다. 0.86.1의 세션 시작 이벤트 재구성은 `bindExtensions` 경로가 아니라 그 앞단이다. |
| `dist/core/agent-session.d.ts` | keep | `ExtensionBindings` 인터페이스 선언 앵커 그대로. |
| `dist/modes/rpc/rpc-mode.js` | keep | `runRpcMode` 시그니처·stdout 대체·백프레셔 4곳·`rebindSession`·`shutdown` 앵커가 모두 살아 있다(0.86.1은 `steer`/`follow_up` 명령 본문만 바꿨다). |
