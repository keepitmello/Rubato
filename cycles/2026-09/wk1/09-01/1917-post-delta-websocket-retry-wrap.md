---
date: 2026-09-01
scope: [rubato-engine, retry, cursor]
type: fix
---

## TL;DR

모델이 글을 조금 내보낸 뒤 WebSocket이 끊기면 Rubato가 모든 시도를
`senpi:no-turn-retry:`로 끝내 다른 세션까지 대기 상태에 빠졌다.
provider가 실제로 도구를 실행한 경우만 재시도를 막고, 나머지는 Senpi가 원래 가진
횟수 제한 재시도로 넘기도록 경계를 좁혔다.

## Keywords

`withRubatoStream` `senpi:no-turn-retry:` `WebSocket error`
`kCursorExecResolved` `AgentSession._isRetryableError`

## 왜 바꿨나

`senpi:no-turn-retry:WebSocket error`는 모델이 쓰는 문장이 아니다.
`rubato-stream.mjs`가 텍스트나 toolCall delta를 하나라도 본 뒤 전송 오류가 나면
같은 턴을 다시 보내지 말라는 뜻으로 붙이던 내부 표식이다.

의도는 맞았다. Cursor는 모델 응답 도중 서버가 로컬의 bash·write 같은 도구를
실행시킬 수 있고, 연결이 끊겼다고 같은 턴을 다시 보내면 그 도구가 두 번 실행될 수
있다. 문제는 이 경계를 “provider가 도구를 실행했는가”가 아니라 “화면에 무언가
나왔는가”로 잡은 데 있었다. 글만 쓰다가 끊긴 턴, 이전 toolResult를 읽고 답하던 턴,
아직 실행되지 않은 일반 toolCall까지 전부 터미널 오류가 됐다.

실제 로그에서도 8월 29일 이후 같은 표식이 여덟 번 나왔고, 수정 중인 세션도
파일을 읽고 다음 말을 만들다가 같은 오류로 한 번 멈췄다.

## 어디까지 따라가 봤나

오류는 아래 순서로 굳었다.

1. provider stream이 `WebSocket error`를 돌려준다.
2. `withRubatoStream`이 post-delta라는 이유로 `senpi:no-turn-retry:`를 붙인다.
3. Senpi의 `AgentSession._isRetryableError`가 이 접두사를 보고 재시도를 거부한다.
4. `agent_end.willRetry`가 `false`가 되고, child runner는 해당 턴을 실패로 정착시킨다.
5. task manager가 세션을 terminal record로 바꾸므로 부모가 새 메시지를 보내기 전까지
   다른 세션은 그대로 멈춘다.

접두사만 지우고 모든 턴을 다시 보내는 것도 답은 아니었다. provider가 이미 실행한
도구가 있으면 텍스트 중복보다 큰 부작용이 생긴다. 반대로 일반 toolCall은
`stopReason: "error"`인 동안 agent loop가 실행하지 않으며, 재시도 전에 실패한
assistant message도 active branch에서 빠진다. 이전 턴의 toolResult는 남기 때문에
같은 도구를 다시 실행하지 않고 현재 model call만 새로 보낼 수 있다.

## 결정

재시도 경계를 `kCursorExecResolved`로 잡았다.

Cursor exec-channel은 provider가 도구를 실행하기 전에 toolCall block에 이
module-local Symbol을 붙인다. stream을 읽는 동안 표식을 한 번이라도 보면 call state에
latch하고, terminal message가 다른 객체로 바뀌어 block을 잃더라도 fail-open하지 않게
했다.

- text·thinking delta: 제한 재시도
- 아직 실행되지 않은 일반 toolCall: 제한 재시도
- Cursor가 stream 안에서 실행한 tool: `senpi:no-turn-retry:` 유지
- 사용자가 직접 중단한 턴: 기존처럼 재시도 금지

실패한 toolCall을 성공한 `toolUse`로 바꾸지는 않는다. 잘린 인자가 빈 인자 도구로
실행되는 기존 위험도 그대로 막는다.

## 바꾼 자리

| 파일 | 변경 |
|---|---|
| `harness/rubato-pi/src/rubato-stream.mjs` | provider 실행 표식을 감지하고 latch한 뒤 그 경우에만 post-delta 재시도를 막는다. |
| `harness/rubato-pi/test/unit/rubato-stream.test.mjs` | text·thinking·일반 toolCall과 Cursor exec-channel을 나눠 실제 AgentSession 판정까지 검사한다. |

## 검증

```text
cd harness/rubato-pi
node --test test/unit/rubato-stream.test.mjs
34 tests, 34 pass, 0 fail
```

전체 검사도 돌렸지만 최신 `rubato/base` 자체가 이미 깨져 있었다. 변경분을 전부
stash한 원본에서도 같은 명령이 같은 자리에서 실패하는 것을 다시 확인했다.

```text
npm --prefix harness/rubato-pi test
exit 1 — role-prompt 생성물, 로컬 extension 경로, service-tier, TUI 기대값 실패

npm --prefix harness/rubato-pi run test:integration
exit 1 — task child/runtime와 surface memory 통합 검사 실패

bun run typecheck
exit 1 — packages/senpi-task/src/state/record.ts:24
         packages/senpi-task/src/team/member-extension/index.ts:155
```

이번 변경 파일을 적용했을 때와 stash한 `origin/rubato/base` 원본에서 세 명령이 모두
각각 exit 1이어서, 위 실패는 이 수정이 만든 회귀가 아니다.

원래 작업본에서는 일반 Rubato Opus로 독립 검토했다. P0~P2는 없었고, stream delta마다
완료된 block을 다시 훑던 부분과 일반 toolCall의 실제 재시도 판정 단정이 약하다는 P3를
반영했다.

## 남은 위험

실제 네트워크를 강제로 끊는 live fault injection은 하지 않았다. 테스트는 설치된
Senpi의 실제 `_isRetryableError`와 pi-ai의 실제 module-local Symbol을 사용한다.

앞으로 Cursor가 아닌 provider도 model stream 안에서 로컬 도구를 실행한다면 같은
실행 표식 계약을 채택해야 한다. 그 표식 없이 provider 내부 부작용이 생기면 Rubato가
안전한 재시도와 위험한 재실행을 구분할 방법이 없다.
