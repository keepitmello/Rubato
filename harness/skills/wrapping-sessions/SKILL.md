---
name: wrapping-sessions
description: "세션 마무리 문서. 마무리, wrap."

---

# Wrapping Sessions

이 문서 하나로 새 세션이 온보딩할 수 있게 쓴다. 코드와 diff를 읽으면 알 수 있는 것 말고, **읽어도 알 수 없는 것**을 남긴다 — 왜 그 판단을 했는지, 어떤 경로로 거기 도달했는지, 무엇을 시도했다 버렸는지, 무엇이 아직 미해결인지.

한국어로 쓴다.

## Steps

1. `date +"%Y-%m-%d %H:%M"` 로 현재 시각.
2. Rubato 작업이면 `git rev-parse --show-superproject-working-tree`로 private Rubato-lab
   루트를 찾고, 그 아래 `case-studies/cycles/YYYY-MM/wkN/MM-DD/HHMM-topic-wrap.md`에 쓴다.
   값이 비어 있으면 public Rubato에 `cycles/`를 만들지 말고 Rubato-lab checkout 위치를
   먼저 확인한다. 다른 저장소의 작업이면 그 저장소 `cycles/`에 쓴다.
   주차 — 1\~7일: wk1 | 8\~14: wk2 | 15\~21: wk3 | 22\~28: wk4 | 29\~31: wk5.
3. 이번 세션의 파일과 wrap 파일을 각자 소유한 저장소에서 경로 지정으로 스테이징하고
   conventional commit으로 커밋한다. Rubato 작업에서는 public 변경과 private wrap이 서로
   다른 커밋이다. `-A`는 쓰지 않는다 — 다른 세션이 같은 repo를 만지고 있을 수 있다.

## Template

```markdown
---
date: YYYY-MM-DD
scope: [module1, tech1]
type: feature | fix | refactor | debug
---

## TL;DR
[뭘 했고 왜 했고 결과가 뭔지. 이번 세션의 가장 중요한 사실이 여기 있어야 한다]

## Keywords
`keyword1` `function_name` `couponSn=1273` `20260728013000`

## Context
[이 작업을 부른 상황. 직전 세션이 뭘 인계했는지, 어떤 증상을 봤는지]

## Investigation
[가설 → 검증 → 발견. 헛다리를 짚었으면 그것도]

## What Didn't Work
### ❌ [버린 접근]
- 시도: [무엇을, 어떤 근거로]
- 문제: [왜 틀렸는지]
- 교훈: [다음에 같은 갈림길에서 쓸 수 있는 형태로]

## Decision Rationale
[비교한 선택지, 이걸 고른 이유]

## Work Accomplished
### 1. [변경 묶음] (커밋 `abc1234`)
[무엇을 왜 그렇게 구현했는지, 핵심 로직/패턴]
- `path/file.ts:line`

## Verification
[실제로 돌린 명령과 결과. 안 돌린 건 안 돌렸다고]

## Architecture Impact
[영향 범위, 주의점, 다음에 이 근처를 건드릴 사람에게 남기는 말]

## Files Changed
| File | Change |
|------|--------|
| `path/file.ts` | [설명] |

## 미결
[이번에 못 고친 것. 다음 세션이 뭘 먼저 봐야 하는지]

## Commit
type(scope): summary

Co-Authored-By: <현재 런타임·저장소 정책이 요구하는 작성자>
(활성 에이전트 지침이나 저장소 정책에 명시된 trailer를 그대로 사용한다. 임의로 작성자를 만들지 않는다.)
```

TL;DR / Keywords / Context / Work Accomplished / Files Changed / Commit 은 항상. 나머지는 그 세션에 실제로 있었으면 넣는다. 세션이 실제로 그런 모양이면 `Full Journey Timeline`(Phase별 진행), `Checkpoint`, `Commit Scope Check` 같은 섹션을 더 만들어도 된다.

## 무엇이 실려야 하는가

판별 기준은 하나다. **diff를 읽으면 알 수 있는 것은 빼고, 이 문서에만 있는 것을 남긴다.** 무엇을 고쳤는지는 커밋이 말해준다. 왜 그 판단에 도달했는지, 왜 다른 길을 버렸는지는 여기 없으면 사라진다.

코드에 남지 않는 것들:

- **외부에서 받은 답** — provider 회신, 벤더 문서에 없던 사실, 담당자가 되물은 것. 요약하지 말고 원문 그대로 인용한다.
- **사용자가 뒤집은 판단** — 어떤 지적이었는지, 그 전에는 무엇을 전제하고 있었는지.
- **되돌린 것과 그 속도** — 무엇을 얼마 만에 되돌렸는지가 다음 판단의 재료다.
- **옳은 결론이 틀린 층위에 적용된 경우** — 직전 세션의 맞는 결정이 이번에 어떻게 오작동했는지.
- **추정과 사실의 구분** — 확인 못 한 건 `[추정]`으로 표시하고 왜 확인이 안 됐는지 적는다.
- **못 고친 것** — 발견했지만 손대지 못한 문제. 다음 세션의 시작점이 된다.

교훈은 이번 사건이 아니라 **다음 갈림길에서 쓸 수 있는 형태**로 쓴다. 특정 값이나 화면에 묶인 결론은 그 상황에서만 유효하고, 판단의 축으로 쓴 질문은 다음에도 쓸 수 있다.

분량 제한은 없다. 최근 wrap 평균이 167줄이고 783줄짜리도 있다. 세션이 실제로 그만큼 밀도가 있었으면 길어지는 게 맞고, 30분짜리 단순 수정이면 짧은 게 맞다.
