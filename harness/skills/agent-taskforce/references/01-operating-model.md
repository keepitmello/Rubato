# Operating model

*Lead.* How the team is governed once it exists.

## Lead

The lead owns:

- the execution mission and completion criteria
- the roster proposal, workstream boundaries, and resource allocation
- cross-workstream contracts and teammate replacement
- routing conflicts between an active frame and execution
- integration and completion decisions

The human operator owns the framing choice, lead-model choice, and approval of the roster. Do not spawn a new or materially changed teammate before that approval. Recreating the same approved teammate after session loss is recovery, not a new staffing decision.

The lead does not absorb every debugging detail. Look at task state, verified facts, and decision-grade evidence. When an owner is stuck, attach a relevant peer, redesign the boundary, or replace the owner rather than choosing commands one at a time.

Small integration edits may be done directly after convergence. If an edit becomes a new outcome or long debugging loop, assign an owner.

## Owners and verifiers from the lead's side

Their contracts are `teammate/workstream-owner.md` and `teammate/independent-verifier.md`.

- **An owner owns a bounded outcome, not a phase.** Investigation normally flows into implementation and local verification in the same context.
- **A verifier inspects state, not narrative.** Failures go directly to the responsible owner; challenges to the acceptance criterion go to the lead.

A resident verifier is optional. Add one when independent falsification is worth its cost. If a long run pulls the verifier deep into implementation discussion, its independence is gone and it cannot certify otherwise — use a fresh verifier for the final gate.

## Milestone fresh review

For long or high-risk runs, a fresh context re-examines the trajectory at phase and milestone gates. This is the team's main defense against the failure class no resident context can see: a criterion or instrument that is wrong the same way for everyone inside the run — every inside view confirms every other, and only an eye that inherited none of the run's premises asks whether the measuring itself is sound. Do not create the gate structure for short runs; but in any run long enough to have phase gates, the review is due at each gate: run it, or record at the gate why it was skipped. An unrecorded skip is indistinguishable from a forgotten one.

Give only the mission, authoritative artifacts, acceptance criteria, current results, and shared task state — never the lead's conversation narrative; the input spec is the contamination barrier. Ask: does a case exist that passes the current acceptance criterion and is still a failure — or genuinely succeeds yet fails it? Is any work continuing on a refuted premise? Is any stream stalled in a side path? Do the active frame's invariants still fit the evidence?

This is always a separate new session, never the resident verifier reused: a context cannot audit its own contamination, and asking it whether it is still clean asks exactly the question it cannot answer.

Findings return to the lead; frame-invariant conflicts return as `FRAME_CONFLICT` evidence.

## Intervention ladder

1. The owner updates reproduction, hypotheses, and alternatives.
2. A relevant peer or verifier adds evidence or challenge.
3. The lead splits, merges, replaces, or rules on a shared contract.
4. A true active-frame conflict goes to the human and framing process.

Do not push a problem to a later rung that an earlier one can solve.

## Communication policy

Routine status belongs on the runtime status surface. Durable artifacts hold intermediate numbers, raw results, and long investigations. Messages are for material events that change another stream's judgment or require action.

Good messages state the confirmed fact, impact, affected owner, and evidence path. Bad messages relay full transcripts, live play-by-play, or a peer question through the lead.

Watch the lead's own outbound tone: **evaluative sentences** — "this is the best find of the day", "exactly right" — change no one's next action but linger as framing. A lead's repeated phrasing hardens into a teammate's premise long after the data behind it is gone. Praise and the lead's own reasoning belong in team documents and retrospectives, not the control channel.

## Decision rights

| Decision | Default owner |
|---|---|
| whether to use framing | human operator |
| lead model | human operator |
| initial roster proposal | lead |
| initial teammate spawn | human approval |
| material restaffing or new teammate | lead proposes; human approves before spawn |
| implementation and debugging inside a workstream | owner |
| interface between two streams | affected owners; lead if unresolved |
| architecture, public contract, or high-blast-radius change | lead; human approval when needed |
| changing an active frame invariant | human + framing/reopen process |
| final integration and completion | lead, using the approved evidence path |

## Plan approval

Do not impose plan approval on every teammate. Use it for destructive migrations, authorization boundaries, public contracts, large irreversible rewrites, or changes that may exceed an active frame.

## File and resource ownership

Never write the same file concurrently. When boundaries converge on one central file, reduce writers: one owner writes while others review or gather evidence.

File separation does not separate process space, ports, CPU, memory, measurement capacity, or external quotas. Allocate shared resources in the mission when contention is material. Clean up only named identifiers you created, never by pattern kill.
