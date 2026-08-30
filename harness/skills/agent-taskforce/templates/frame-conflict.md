# FRAME_CONFLICT

This document does not change the active frame. It is an evidence packet handed to framing's formal reopen decision.

```text
FRAME_CONFLICT
frame_ref: <path + frame_id/version>
invariant_at_risk: <the INVARIANTS entry in the active FRAME_LOCK>
observed_evidence: <test, behavior, source, artifact path>
why_solution_iteration_is_insufficient: <why VARIABLES or team-contract changes cannot resolve it>
affected_workstreams: <streams that must stop>
safe_work_that_may_continue: <frame-independent investigation, cleanup, scaffolding, or NONE>
recommended_next_step: <reject conflict / contract change / reopen review / reframing input>
decision_owner: <human>
```

The lead does not demand raw debugging transcripts. If judged a genuine conflict, follow the existing `framing/templates/reopen-request.md` and its state transitions.
