# Framing / Reframing bridge

*Lead, and any teammate returning a FRAME_CONFLICT.*

`framing` and `reframing` own the product-value frame. This file explains how a moving team respects that authority. The human operator decides whether this run uses framing; the signals below help the lead make a recommendation, not override that choice.

## Recommend framing when

- whose problem to solve and why are still open
- implementation is subordinate to a user outcome or comparative value
- several workers could amplify value drift
- a hard-to-reverse commitment is beginning

If the operator chooses framing, use its own workflow and lock states. If the operator skips framing, do not recreate its fields inside the team skill; execute against the named user directive, spec, or ADR.

## Use an active frame when

- a user-approved `FRAME_LOCK: ACTIVE` exists
- the team is implementing or verifying inside its permitted scope
- the mission links the frame path, ID, version, and expiry rather than paraphrasing it

## Use only a lightweight mission when

- the product-value question is closed or not applicable
- the task is a bug fix, refactor, migration, infrastructure change, tooling work, or settled specification

## Checks when an active frame is used

Confirm the frame is active and valid, approvals and permitted commitments cover the task, and no competing active lock exists. Do not start new frame-dependent work under expiry, `REOPEN_REQUESTED`, missing approval, or multiple active locks. Each linked implementation task carries the frame's outcome-link values; never invent them.

## Three grades of change

1. **Local implementation change** — owner decides inside the frame variables and existing team contracts.
2. **Team contract change** — affected owners align on evidence; lead decides the shared API, schema, architecture, or behavior while invariants hold.
3. **FRAME_CONFLICT** — evidence undermines an active invariant. Framing owns the reopen decision.

## Handling FRAME_CONFLICT

1. Stop only affected frame-dependent work and gather evidence.
2. The owner sends the invariant at risk, observed evidence, affected streams, and safe work that may continue using `templates/frame-conflict.md`.
3. The lead first checks whether local iteration or a team-contract change resolves it.
4. A genuine conflict goes to the human; the lead does not edit the active frame.
5. If reframing is requested, run it in a fresh context with the current frame, evidence, rejected candidates, and constraints — not the implementation narrative.

## Optional fresh alignment review

For high-risk integration or a long narrative-heavy run, a fresh session may compare the active frame, mission, current artifact, and verification evidence. It exits if no material conflict exists; it is not a standing teammate or implementation director.

## When authorities conflict

- Frame vs mission: the active frame wins; fix mission drift.
- Latest user directive vs active frame: raise a human reopen decision.
- Reframing candidate vs active frame: candidate remains input until approved.
- ADR vs frame: identify which assumption evidence undermines and escalate to its decision owner.
