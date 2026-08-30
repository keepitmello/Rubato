# Model allocation for the lead

*Lead.* **Canonical routing guidance lives in Skill(model-guide)** (`~/.agents/skills/model-guide/SKILL.md`) — cognitive profiles, bottleneck routing, ownership preservation, verifier pairings, and the current catalog mapping. Read it there; this file keeps only what is team-specific.

The human operator chooses whether framing is used and which model is lead. You choose the smallest execution roster from model-guide's routing, explain it briefly, and wait for approval before spawning.

## What to show the user before spawn

Keep the proposal short.

```text
팀 배치안
- 프레이밍: 사용 / 기존 프레임 연결 / 생략
- Lead: <model> — <why this lead fits>
- Owner: <outcome> → <model> — <dominant bottleneck>
- Owner: <outcome> → <model> — <dominant bottleneck>   # only if needed
- Verifier: <model or none> — <why included or skipped>

이 배치로 띄울까?
```

Wait for explicit confirmation. After approval, spawn only the approved teammates and record the actual roster if a mission artifact is being used.
