# Model allocation for the lead

*Lead.* Use Skill(model-guide) (`~/.agents/skills/model-guide/SKILL.md`) for cognitive profiles, bottleneck routing, verifier pairings, and catalog mapping. Session continuity (continue an existing session or start fresh) lives in Skill(dispatching). This file keeps only the team proposal format.

The human operator chooses whether framing is used and which model is lead. Choose the smallest execution roster from the active runtime's policy and report it before spawning. The operator can veto it; wait only for restricted-model, cost, or explicit team-approval decisions as defined in `LEAD.md`.

## What to show the user before spawn

Keep the proposal short.

```text
팀 배치안
- 프레이밍: 사용 / 기존 프레임 연결 / 생략
- Lead: <model> — <why this lead fits>
- Owner: <outcome> → <model> — <dominant bottleneck>
- Owner: <outcome> → <model> — <dominant bottleneck>   # only if needed
- Verifier: <model or none> — <why included or skipped>

이 배치로 진행할게요.
```

If explicit confirmation is required, ask for it instead of announcing a start. Otherwise form the reported team in the same turn. Record the actual roster if a mission artifact is being used.
