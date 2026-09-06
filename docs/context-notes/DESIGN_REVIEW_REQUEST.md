# 해결: 실제 AgentSession에서 new_context 직후 공급자 요청

작성일 2026-09-06. 작업 노트 문맥 관리 2차 패킷 인수인계 §9. 원인은 체크포인트가 아니라 센피의 다음 턴 준비였다.

## 실제 원인

`turn_end`에서 `applyCompaction`은 경계를 저장하고 `this.agent.state.messages`를 새 창으로 다시 만든다. 그런데 `_installAgentNextTurnRefresh` → `prepareNextTurnWithContext`는 이렇게 고른다.

```js
const messages = compactedBeforeCallback ? this.agent.state.messages.slice() : turn.context.messages;
```

`compactedBeforeCallback`은 센피 자신의 threshold 압축이 그 prepare에서 돌았을 때만 true다. 확장의 `turn_end` 압축은 무시되므로, `new_context` 도구 결과 뒤의 공급자 요청은 옛 창 원문을 그대로 보낸다.

## 수정

`core-context-notes.mjs`의 `session` 대상에 일곱 번째 연결을 넣었다. `engine-gate.mjs`의 `notesTurnMessages(turn, agentMessages)`는 노트 모드에서 에이전트 메시지가 창 안내로 시작하는데 `turn.context.messages`에는 없을 때만 재구성 결과를 쓴다. 요약 모드에서는 그대로 둔다.

## 업스트림 보고 초안

extension `applyCompaction` during `turn_end` is not reflected in `prepareNextTurnWithContext` unless the built-in threshold compaction also ran. After an extension commits a compaction at `turn_end`, `_executeCompaction` rebuilds `this.agent.state.messages`, but the next provider admission still sends `turn.context.messages` because `compactedBeforeCallback` is true only when senpi's own `_enforceCompactionBeforeProvider` ran in that prepare. Hosts that own compaction (external-owner / applyCompaction) therefore emit one stale full-window request after a successful boundary. Reading `this.agent.state.messages` when it already carries the new compaction carrier would close the gap without changing threshold timing.
