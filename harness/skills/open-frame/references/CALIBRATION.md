# Open Frame calibration

These examples show the same posture at different densities. They are not a workflow and do not need to appear in the response.

## A clear transformation

> “그렇게 준비해서 보내드리겠습니다”를 자연스러운 비즈니스 영어로 번역해줘.

Translate it directly. Another frame, user question, tool call, or agent would not improve the action.

## A user-owned purpose

> 사용률이 낮은 기능의 UX를 개선해줘.

Do not invent what “improve” means. If first use, repeated use, and success in a rare critical case would lead to different designs, ask one focused question that separates those outcomes. If the surrounding context already establishes the outcome, use it and proceed.

## An uncertainty owned by reality

> 첫 가격 봉이 과거 값으로 고정되는 버그가 또 생겼어. 초기값 조건문을 다시 고쳐줘.

The proposed fix is not yet evidence about the failure layer. Inspect the current state path, reproduction, logs, and transition boundaries. Let the smallest useful test or observation determine whether the work belongs in a condition, initialization contract, or state-ownership boundary.

## A solution that may be narrowing the problem

> 호텔 직원이 객실 주문을 처리하는 관리자 대시보드 기능을 전부 설계해줘.

Keep the dashboard request central, but leave room for the operating result: requests must be noticed, assigned, handed off, completed, and recovered when something goes wrong. A fresh context may reveal that some of this result belongs in alerts, automation, or operating rules rather than one screen. Bring that insight back into a concrete dashboard design instead of replacing the user's project with a different one.

## A human-centered question

> 사용자가 왜 이 화면에서 이탈하는지 분석해줘.

Reason from what users can actually see, know, expect, and do. Treat unobserved motives as hypotheses. Ask the user only for product goals or constraints that only they can supply; inspect behavior data, recordings, copy, and interaction paths for claims about actual use.

## When fresh context finds nothing new

A fresh view may conclude that the original framing is adequate. That is a useful result. Proceed without manufacturing a frame shift or explaining the meta-process to the user.
