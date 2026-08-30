# REOPEN_REQUEST 양식

동결 해제 정당 사유는 `references/04-lock-and-reopen.md`의 신호 목록에 있는 것만. "구현이 귀찮다", "새 UI가 더 멋져 보인다"는 사유가 아니다.

```markdown
REOPEN_REQUEST
current_frame: <frame_id + version>
observed_evidence: <관측된 증거 — 원문·데이터 인용>
which_invariant_failed: <어느 불변식이 무너졌는가>
why_solution_iteration_is_insufficient: <구현 변경(가변 요소)으로는 왜 해결이 안 되는가>
candidate_new_frames: <새 후보 프레임, 3개 이하>
decision_owner: <사람>

--- 결정 기록 (REOPEN_REQUESTED 이후의 종결 전이는 이 블록만이 일으킨다) ---
decision: APPROVED | REJECTED
approved_by: <사람>
approved_at:
decision_note:
```

## 제출 후 상태 규칙

- 제출 즉시 프레임 status는 `REOPEN_REQUESTED`가 된다. 이 동안 **불변식에 의존하는 새 구현 착수는 중단**하고, 진행 중인 가변 요소 작업(UI·구현 방식)은 마무리해도 된다.
- **decision: APPROVED** (approved_by·approved_at 필수): 기존 버전을 SUPERSEDED로 바꾸고, 새 버전 DRAFT로 점검표를 다시 판정한다. 대체 프레임 없이 접기로 한 승인이면 SUPERSEDED 대신 RETIRED로 종료한다(`references/02`의 전이표 참조). 새 lock이 ACTIVE가 되기 전까지 구현 위임은 재개하지 않는다.
- **decision: REJECTED**: status를 LOCKED로 되돌린다. 기존 gate_verdict와 동결이 그대로 복원된다.
- 요청 제출이 일으킬 수 있는 전이는 `LOCKED → REOPEN_REQUESTED` 하나뿐이다. 그 이후의 종결 전이(SUPERSEDED·RETIRED 또는 LOCKED 복귀)를 결정 기록 없이 수행하는 세션은 프로토콜 위반이다. 이전 프레임이 SUPERSEDED가 되는 시점은 **동결 해제 승인 시**가 유일하다.
