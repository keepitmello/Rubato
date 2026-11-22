---
name: work-intent
description: "Resolve and preserve the user's intended result: investigate available evidence first and recommend a direction. A request that already says what to make and how far stays inline."
---

# Work intent

Bring the user a grounded recommendation they can accept or correct, not a form they
must fill. The lead gathers available information, judges viable directions and owns
the conversation. The human decides material goals, preferences and commitments that
evidence cannot settle. Keep that agreed intent stable while methods and sessions change.
This is not a product-framing exercise, an interview script or a team-creation command.

## Resolve before creating

Establish the current request in the user's terms. For small local work, retain it
in context without a file. Before work that needs
durable resumption, inspect the project's instructions and existing intent home.
Reuse the record for the same unresolved outcome, including after a session reset,
worktree change, failed verification or different team composition. A fresh run is
not a fresh intent. Read candidates; similar filenames alone do not establish sameness.

A different outcome on the same systems still inherits from earlier intents, whatever
their status. Find them in the intent home or with `memory_search` (`msearch` from a shell). A user constraint or
correction recorded there that still holds goes into the new record's Constraints with
its source, so the next run inherits it from the record rather than from whoever
happens to remember it.

Prefer the project's existing system of record. An existing approved intent, issue
or specification can already express the requested change: link it and the relevant
sections rather than translating it into another authoritative document. Otherwise use
`intent/<stable-id>/intent.md` under the lead's canonical project root, with
[the template](templates/intent.md). Update the same record rather than making version,
final or new copies. A request that already says what to make and how far needs neither an intent file nor an approval ritual.

## Investigate, then recommend

Read [alignment](references/alignment.md) when preparing a substantial proposal or
resolving uncertainty. Start with what the current conversation and named authorities
already establish. Read relevant code, tests, configuration, documents and available
connected sources yourself; use current primary web sources when local evidence cannot
settle an external fact. Choose the useful sources, not a compulsory tour of every tool.
A repository question is not a reason to ask the user to explain their repository.

Separate missing facts you can discover, implementation decisions within your authority,
and material user choices. Discover the first, decide the second, and present a
recommendation for the third. Treat absent access as missing evidence, not proof of
absence. Ask for the smallest missing access/fact only if it prevents an honest proposal
and available alternatives cannot resolve it. Never fabricate a preference or a fact.

Bound discovery by the decision: stop when further information is unlikely to change
the direction, constraints, ownership or acceptance evidence. Do not exhaustively audit
the project to eliminate every uncertainty. A focused, non-implementing discovery subagent
may gather evidence under a draft and the existing permission/model/budget rules; this
is not permission to launch continuing owners or implement the unapproved proposal.

Recommend the best-supported direction for the stated goal and explain its practical
benefit. Present materially different alternatives only when the choice matters. A
recommendation is a proposal until accepted, not a newly discovered user requirement.
Implementation methods remain revisable; avoid freezing guessed file layouts in intent.

## Capture

Preserve the originating request or an exact retrievable reference, its problem,
proposed outcome, affected users/systems, constraints and material open decisions.
Separate facts, inferences and proposals. Write the record in English, the language
every role searches in; the user's own words (the originating request, quoted constraints
and corrections) stay verbatim in their language. Translate technical mechanisms into
their effect on the user. The approval message itself speaks the user's language and is
not a dump of parser headings, IDs or paths.
Link existing frame/spec clauses instead of duplicating what they own. Roster and run
progress stay in the mission; brief discovery findings need no separate report.

Keep a new proposal in draft until accepted. An already active intent stays active when unchanged.
After activation, carry the newly returned reference; activation itself changes the file hash.

When the user accepts with a clear correction or chooses an offered alternative, apply
exactly that change and record their reply as its authority; do not demand a ceremonial
second yes. If the correction changes a still-unsettled material commitment or
outcome, clarify only that delta before dependent work. Partial approval preserves what
was accepted; ask only for the missing decision, not the whole interview again.

Outcome-blocking choices stay open until the human resolves them or
explicitly delegates a bounded choice. Local methods inside accepted scope stay autonomous.
An active `FRAME_LOCK` remains authoritative for product-value invariants.
Reference it; use the existing human framing/reopen process for genuine conflicts. If
framing was skipped, do not rebuild a miniature interview or frame inside this skill.

## Carry one reference through the work

For managed records, [scripts/intent.mjs](scripts/intent.mjs) provides read-only listing,
revision-aware updates, acceptance checks and a derived index. Read
[operations](references/operations.md) before mutating records. Carry the returned
`intent_ref` (path, ID, revision and file SHA-256) with the canonical workspace in mission,
task briefs and board `metadata.intent_ref`. The board holds assignments, not a second
intent. The script checks records only when invoked; it does not intercept runtime tools
or authenticate approval. A prose policy is not proof that the runtime enforced it.

For an external/unmanaged authority, carry its real path/URL, immutable revision when
available, and human acceptance reference. Use its own version/approval mechanism, not
the managed parser or a new imported copy. Each recipient reads the authority before
dependent work and on handoff, changed direction or resumption; return evidence against
the revision read. Descendants reuse that reference. The lead maintains shared intent.
Arrange access or an explicitly versioned read-only snapshot for another worktree; that
snapshot is not a competing authority. Discovery-only briefs identify their draft status
and stop before implementation; they need not masquerade as approved execution.

Specs own required behavior; plans own implementation approach. Reuse them and update
in place; make separate files only when the work needs them. Their approval is not
supplied by intent acceptance. A mission holds execution slice, roster and acceptance
references, integration and resumption. Task status stays on the existing board.

## Change, resume and close

Methods may change inside approved scope without revising intent or asking again.
Material changes to outcome, constraints or acceptance criteria return intent to draft
with a reason; retain the ID for the same work. A genuinely different replacement gets
a new intent with an explicit supersession link. Send affected owners/reviewers the
change and pause only dependent work.
Unchanged approvals and same-owner corrections do not need a fresh ceremony.
Keep previous evidence attached to its original revision.

On resumption, handle the latest user direction, then reread intent and relevant
mission/board. Check status/revision before dependent execution; a compacted summary or
newest timestamp is not authority. Recover accepted proposal references instead
of asking the user to repeat them. Investigate ordinary new factual gaps locally.

Fulfill only after the lead accepts evidence for the intended result and promised
delivery, not from idle agents or a completed board. Record a closure reference and
update existing permanent documentation as needed. Historical intent is not current-system
specification. Keep long evidence in the named run artifact area and fold useful facts
into existing owners. The `intent.mjs` script never stages, commits, deletes history, or starts
another task automatically.
