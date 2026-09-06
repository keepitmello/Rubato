# 설계 검토 요청: 실제 AgentSession에서 new_context 직후 전환

작성일 2026-09-06. 작업 노트 문맥 관리 2차 패킷 인수인계 §9.

## 문제 위치

`harness/rubato-pi/src/context-notes/controller.mjs` `turnEnd` → `roll` → `assertCheckpointFresh`.
실제 엔진은 `@code-yeongyu/senpi` AgentSession의 도구 루프.

## 재현

`RUBATO_TEST_CONTEXT_NOTES_ENGINE=1 node --test harness/rubato-pi/test/integration/context-notes-agent-session.test.mjs` 의 fact 3.

스크립트: `notes_write_file` → `new_context` → 다음 모델 호출에 텍스트.

## 기대

`new_context` 도구 묶음이 끝나면 요약 없이 창이 바뀌고, 그 다음 공급자 요청은 새 창 안내만 담는다. 패킷 단위 시험은 `turn_end`를 직접 보내 이 순서를 만든다.

## 실제

센피 에이전트 루프는 `new_context` 도구 결과 뒤에 모델을 한 번 더 호출한다. 그 응답이 텍스트면 노트 뒤 일반 작업으로 취급되어 전환이 거부된다 (`노트 저장 뒤 새 작업 결과가 생겼어요`). 공급자 요청 3번째에도 이전 사용자 원문이 남는다 (fact 2가 이 사실을 고정함).

## 실패 이유

패킷 규칙 6(노트 뒤 일반 작업이 있으면 그 노트로 자르지 않음)과 센피의 “도구 결과 후 반드시 모델 재호출”이 같은 턴에서 만난다. 단위 시험용 fake는 그 재호출을 만들지 않는다.

## 영향 범위

실제 AgentSession에서 도구만으로 창을 바꾸는 해피패스를 자동 검사하지 못한다. `/new-context` 수동 경로도 노트 뒤 텍스트 어시스턴트가 있으면 같은 검사를 받는다.

## 가능한 대안

1. `new_context` 직후 모델 재호출을 건너뛰고 `turn_end`를 내도록 엔진 루프를 바꾼다.
2. 전환 예약을 도구 결과가 나온 시점에 적용하고, 그 다음 모델 호출을 새 창으로 보낸다.
3. 관리 도구만 있는 어시스턴트 다음의 빈 텍스트 응답은 작업으로 보지 않는다.

1·2는 엔진 계약, 3은 패킷 규칙 6의 예외라 임의로 정하지 않는다.
