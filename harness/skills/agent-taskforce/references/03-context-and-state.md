# Context and durable state

*Lead, and any teammate whose context was compacted.*

## Separate the layers of authority

- User directives and approvals: current intent, framing choice, lead choice, and roster approval
- Active `FRAME_LOCK`: product value, users, and outcome invariants
- Spec/ADR/schema: technical contracts and structural decisions
- Accepted intent: this requested change and its human acceptance, referencing upstream frame/spec authority
- Mission: run-specific execution slice and pointers to the authorities above
- Shared task list: who is working on what
- Tests, runtime evidence, reports: whether results actually hold

Do not let the mission, task list or intent restate an existing authoritative frame/spec and compete for authority. Code describes actual behavior; an accepted intent describes desired change. A mismatch needs evidence and a decision, not automatic rewriting of the intent. Raise conflicts rather than silently choosing the sentence that looks newest.

## Resolve and retain the intent

Use the sibling `work-intent` lifecycle before continuing-owner work. Resolve the
project's existing authority first. For managed records, keep `intent_ref` with the
lead's canonical workspace and carry it through mission, briefs and task metadata.
A run/thread ID is not an intent ID. Keep the same record across related runs and
worktrees; unrelated outcomes may have distinct active records.

At resumption or a changed-direction handoff, check the current source, acceptance
and revision before dependent execution. Refresh stale references through the lead,
preserving the previous evidence's revision. A generated index is navigation only;
read the record, and use the helper's live listing instead of trusting a stale index.
The latest user direction still comes first. Draft/closed/superseded records are
not authorization to continue their old implementation.

## Keep the mission small

Use `templates/mission.md` for runs that need durable resumption — its sections are the list, and shared runtime resources is the one a remembered version drops. Do not put routine status or long logs in it. Record verdicts only with supporting evidence.

## Artifact handoff

Save long investigations, benchmarks, reproduction logs, and design analyses in the run's named artifact area, with one writer per artifact. Reuse the existing artifact for the same purpose; new versions belong in Git, not `final-v2` copies. Send recipients a short conclusion, the affected decision or workstream, the path or reproduction command, and remaining uncertainty. A reference sent to another session must be readable there: session-local notes and virtual note paths are not a shared artifact. Avoid copying the same content into several contexts.

## Context reset and resume

Do not rely on compaction alone. Make work resumable through the mission, tests, changed-files lists, and decision artifacts. When continuing work, recover the current request and actual state together with any accepted result — its input or revision and what the user actually said about it — and keep that evidence apart from the predecessor's method and causal story. Read what can change the next decision; small settled tasks need only their affected context, and new work does not need an invented baseline. If a teammate execution is lost, recover it at the same address (`team_replace_member`) with the canonical state rather than pretending to restore the old context; a user stop or exhausted budget is not a lost execution.

After your context was compacted, the **latest user message is still the primary task**. Answer or act on it before status recovery, memory saves, or team reconciliation. Do not open with a "context restored" status report unless the user asked for status. Reread canonical sources as needed, but that reread must not replace the current turn's answer.

At a real handoff or session end, leave:

- completed work with evidence
- accepted results, with the revision/input and the conditions of that acceptance
- remaining work
- current blocker
- recommended next action (a recommendation for the next owner to re-judge, not a fact)
- current failures and unverified claims

Record decisions and procedure outcomes when they change later authority, acceptance, responsibility or recovery — a fresh review run or waived, a verification contract created or waived, a reopen, a retraction and where it went. When a result is accepted or an interpretation changes, update the existing project entry so the next owner finds the actual result and the remaining question; keep deep history retrievable instead of copying it into every handoff. At a handoff, check the current entry and the affected references against material corrections, and widen into history only when a conflict warrants it. Routine progress needs no procedural diary.

## What to prune from context

Remove old tool output, refuted narratives, superseded documents, and duplicate explanations when they no longer affect upcoming choices. Preserve audit material in an artifact and keep only the link in active context.

## Recover the accepted proposal, not another interview

The existing mission links the proposal message, the intent revision shown, the exact
roster, and the human reply accepting both. After activation, carry the returned fresh
intent_ref. Partial acceptance never becomes full approval in a summary. On resumption,
reread those records before asking the user to repeat a decision. Gather new discoverable
facts locally and surface only material unresolved choices, with a recommendation. Keep
routine method changes and same-owner follow-ups inside the existing approval.
