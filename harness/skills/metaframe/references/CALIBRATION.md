# metaframe calibration

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

## A valid critique whose literal patch blunts the argument

> 외부 검수가 "인용한 판결은 원고 귀책이 있어도 기수행 부분 보수를 인정한 사건이라, '귀책이 있으므로 0원'이라고 단정하면 공격받는다"고 짚었어.

The factual point is right, but patching the sentence with defensive caveats ("반드시 0원은 아니더라도…") weakens the settled strategy. Separate the factual gap from the reviewer's risk-averse remedy: reframe the sentence around what the record actually proves ("원고가 실제로 처리한 사무를 증명하지 못했으므로 비율 보수도 0원") so the citation is exact and the claim stays sharp. By contrast, a wrong case number or date in the same review is a factual defect—fix it directly without reframing.

## A valid edge-case review that invites defensive padding

> 코드 리뷰에서 "호출부 세 곳 중 한 곳은 빈 상태 객체가 넘어올 수 있다"고 지적했어.

Pasting null/empty guards and fallback defaults across every downstream helper hides the defect and muddies the code. Check whether the boundary or type contract can make the invalid state unrepresentable so the gap closes structurally. If the issue is a genuine single-point boundary bug (e.g., an external API returning null), fix that boundary directly rather than redesigning the module.

## A valid scope critique on a resume or business offer

> 이력서/제안서 리뷰에서 "전체 플랫폼을 혼자 만든 건 아니잖아" 혹은 "엔터프라이즈 예외 케이스가 빠졌다"고 지적했어.

Watering down the bullet into "일부 지원" or piling disclaimers onto the offer satisfies the reviewer by erasing the value. Reframe around the exact high-leverage decision, mechanism or target scope actually owned so the statement is both strictly accurate and unmistakably strong.
