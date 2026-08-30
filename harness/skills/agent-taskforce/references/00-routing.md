# Routing: single session, subagent, agent team

*Lead.* Whether to form a team at all.

"Agent team" below means Claude Code Agent Teams.

## A single session is better

- Work concentrates on one file or one evolving state.
- Each step depends tightly on the result of the previous step.
- Implementation and verification are short and clear.
- Spawning several workers would cost more in file conflicts and explanation than it saves.

## A focused subagent is better

- You want to isolate noisy investigation or log analysis from the main context.
- You only need the result back; workers don't need to talk to each other.
- One fresh review is enough.
- A short read-only review through one specific lens.

## An agent team is better

- One substantial bounded outcome benefits from an owner context separate from the lead, or two or more independent workstreams can make meaningful progress in parallel.
- Owners need to exchange interfaces, findings, and counter-arguments directly.
- The root cause is unclear and competing hypotheses need independent verification.
- Different layers need coordinating — frontend/backend/test, or research/strategy/verification.
- The main failure mode is a single lead absorbing every debugging narrative and judgment.

The more of these get a "yes," the better the fit:

1. Can the work be split into non-overlapping outcome units?
2. Is each outcome large enough to justify its own context?
3. Would direct worker-to-worker conversation reduce lead relay?
4. Can done evidence be defined independently for each?
5. Is the extra token and coordination cost reasonable against the value?

## A separate fresh session is better

- You need an independent reviewer who doesn't know the implementation path.
- You need to check alignment with the active frame, or re-examine the frame itself.
- You need judgment unswayed by a long-accumulated session narrative.

A fresh session is not a standing co-manager. It reads the canonical artifacts and current results, renders a milestone judgment, and exits.

This file decides *whether* to form a team. The human chooses framing and the lead model; `LEAD.md` then proposes the smallest roster and waits for approval before spawning.
