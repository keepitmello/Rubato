# Context and durable state

*Lead, and any teammate whose context was compacted.*

## Separate the layers of authority

- User directives and approvals: current intent, framing choice, lead choice, and roster approval
- Active `FRAME_LOCK`: product value, users, and outcome invariants
- Spec/ADR/schema: technical contracts and structural decisions
- Mission: current execution snapshot and pointers to the authorities above
- Shared task list: who is working on what
- Tests, runtime evidence, reports: whether results actually hold

Do not let the mission or task list restate the frame or spec and compete for authority. Raise conflicts rather than silently choosing the sentence that looks newest.

## Keep the mission small

Use `templates/mission.md` for runs that need durable resumption — its sections are the list, and shared runtime resources is the one a remembered version drops. Do not put routine status or long logs in it. Record verdicts only with supporting evidence.

## Artifact handoff

Save long investigations, benchmarks, reproduction logs, and design analyses as artifacts. Send recipients a short conclusion, the affected decision or workstream, the path or reproduction command, and remaining uncertainty. Avoid copying the same content into several contexts.

## Context reset and resume

Do not rely on compaction alone. Make work resumable through the mission, tests, changed-files lists, and decision artifacts. If a teammate session is lost, spawn a fresh owner that reads the canonical state rather than pretending to recover the exact old context.

At a real handoff or session end, leave:

- completed work with evidence
- remaining work
- current blocker
- exact next action
- current failures and unverified claims

When material approval, restaffing, criterion change, or refutation affects later work, record it. Also record the skill's own procedure activations in the durable artifact, each as a dated line: milestone fresh review run or skipped (and why), verification contracts created or waived, post-completion reopens, retractions and where they were propagated. An unrecorded activation is invisible to every future session — including the one deciding whether a procedure needs to become mandatory. Beyond that, do not maintain a procedural diary for events that change no future decision.

Before closing a session, reread the handoff documents end to end against the retraction entries — retractions spread across several documents, and hand-tracking them is exactly where stale claims survive into the handoff.

## What to prune from context

Remove old tool output, refuted narratives, superseded documents, and duplicate explanations when they no longer affect upcoming choices. Preserve audit material in an artifact and keep only the link in active context.
