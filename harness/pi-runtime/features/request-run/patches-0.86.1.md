# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/core/agent-session.js` | re-cut | `_emitAgentSettled` 첫 줄에 `this._cacheWarmer?.onAgentSettled()`가 들어와 앵커가 죽었다. 원장 정산 호출을 `_isAgentRunActive` 해제 뒤·`agent_settled` emit 앞에 다시 걸었다. 나머지 앵커는 input-lifecycle·abort-provenance가 먼저 적용된 텍스트를 전제하므로 합성에서만 검증된다(스테이징 통과). |
| `dist/core/agent-session.d.ts` | keep | `RequestTimelineSnapshot` 삽입 지점과 `queue_update`·`pendingMessageCount` 앵커 그대로. |
| `dist/modes/rpc/rpc-mode.js` | keep | `get_state` 반환 앵커 그대로(0.86.1은 `steer`/`follow_up`에 source만 더했다). |
