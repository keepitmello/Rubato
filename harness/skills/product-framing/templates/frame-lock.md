# FRAME_LOCK 양식

> **`LOCKED` 프레임은 검증된 시장 진실이 아니라 다음 실험 동안 유지하는 임시 결정 경계다.** `LOCKED`·`PASS-BUILD`·E2 같은 토큰이 쌓여도 프레임이 사실이 되지는 않는다.

구현 워커의 진행 조건: 점검표 status가 `LOCKED`이고 `FRAME_LOCK: ACTIVE`이며 EXPIRES_AT이 지나지 않았을 것 — 하나라도 아니면(동결 해제 검토 중 포함) 새 작업을 시작하지 않는다. 불변식을 바꾸는 요청에는 `FRAME_CONFLICT`를 반환한다.

- **아래 INVARIANTS 6개 목록이 동결 항목의 정본이다.** 다른 문서가 다르게 말하면 이 목록이 이긴다.
- **가장 위험한 가정은 불변식이 아니다.** 실험을 통과할 때마다 다음 위험으로 바뀌는 것이 정상이므로, 하단 EXPERIMENT_CONTRACT에서 실험 회차로 관리한다. 가정 교체는 동결 해제가 아니다 — 프레임 불변식이 바뀔 때만 동결 해제다.
- 저장소당 `FRAME_LOCK: ACTIVE`는 **하나만** 둔다. 새 동결은 이전 프레임이 `SUPERSEDED` 상태일 때만 발행한다.
- EXPIRES_AT 경과 시: 새 위임 금지, 의무 리뷰로 재판정하기 전까지 만료 상태.
- 연습은 이 양식을 생략할 수 있다. 점검표 §6 실험 계약과 §7 상한이 대신하며, 코드 프로토타입은 최소한 가설·스코프 두 줄을 동결한다.

```text
FRAME_LOCK: ACTIVE | SUPERSEDED
FRAME_ID:
VERSION:
OWNER:
GATE_VERDICT: (PASS-PROBE | PASS-BUILD)
APPROVED_BY: (사람 — 이 기록 없이 ACTIVE 불가)
LOCKED_AT:
EXPIRES_AT: (실험 완료 또는 결정 기한)

INVARIANTS:
- 사용자:
- 트리거:
- 현재 대안:
- 약속한 아웃컴:
- 비교 가치:
- 도입 경로·생태계 연결 사슬: (주최사 의존만 해당 없으면 N/A)

VARIABLES:
- UI
- 기술 스택
- 화면 흐름
- 프로토타입 구현 방식

REOPEN_SIGNALS:
- (불변식 6개 중 하나를 무너뜨리는 증거만 — 실험 FAIL 자체는 동결 해제가 아니라 점검표 §6 기록 + 다음 실험 회차)

REJECTED_FRAMES:
- <frame-id>: <탈락 이유 한 줄>
```

## EXPERIMENT_CONTRACT — 실험 회차마다 갱신 (프레임 동결과 별개)

**실험 계약의 정본은 점검표 §6이다.** 실험 내용은 §6에서만 갱신하고, 동결 파일에는 포인터만 둔다.

```text
EXPERIMENT_CONTRACT
learning_cycle: <점검표 §6과 동일한 번호>
정본: 점검표 §6 참조
```

프레임은 그대로 두고 점검표 §6의 실험 회차만 올려 가정을 갈아끼운다. 가정 교체는 동결 해제가 아니다.

## 구현 작업용 아웃컴 연결

모든 구현 작업에 붙인다:

```text
task:
frame_id:
supported_hypothesis:
user_outcome_link:
acceptance_test:
```
