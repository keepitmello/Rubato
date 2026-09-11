---
name: work-intent
description: "Resolve and preserve the user's intended result: investigate available evidence first, recommend a direction, and combine remaining human decisions with intent/roster confirmation before staffing. Read for durable work, continuing owners or a referenced intent. Small local work stays inline; loading this skill does not start an interview or a team."
---

# Work intent

Bring the user a grounded recommendation they can accept or correct, not a form they
must fill. The lead gathers available information, judges viable directions and owns
the conversation. The human decides material goals, preferences and commitments that
evidence cannot settle. Keep that agreed intent stable while methods and sessions change.
This is not a product-framing exercise, an interview script or a team-creation command.

## Resolve before creating

Establish the current request in the user's terms. For small local work, retain it
in context without a file. Before continuing-owner assignments or work that needs
durable resumption, inspect the project's instructions and existing intent home.
Reuse the record for the same unresolved outcome, including after a session reset,
worktree change, failed verification or different team composition. A fresh run is
not a fresh intent. Read candidates; similar filenames alone do not establish sameness.

Prefer the project's existing system of record. An existing approved intent, issue
or specification can already express the requested change: link it and the relevant
sections rather than translating it into another authoritative document. Otherwise use
`intent/<stable-id>/intent.md` under the lead's canonical project root, with
[the template](templates/intent.md). Update the same record rather than making version,
final or new copies. Small work needs neither an intent file nor an approval ritual.

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
the project to eliminate every uncertainty. A focused, non-implementing discovery helper
may gather evidence under a draft and the existing permission/model/budget rules; this
is not permission to launch continuing owners or implement the unapproved proposal.

Recommend the best-supported direction for the stated goal and explain its practical
benefit. Present materially different alternatives only when the choice matters. A
recommendation is a proposal until accepted, not a newly discovered user requirement.
Implementation methods remain revisable; avoid freezing guessed file layouts in intent.

## Capture and accept together

Preserve the originating request or an exact retrievable reference, its problem,
proposed outcome, affected users/systems, constraints and material open decisions.
Separate facts, inferences and proposals. Use the user's language for the body; translate
technical mechanisms into their effect on the user. The fixed parser headings may stay
English. The actual approval message is not a dump of parser headings, IDs or paths.
Link existing frame/spec clauses instead of duplicating what they own. Roster and run
progress stay in the mission; brief discovery findings need no separate report.

For a taskforce, after discovery present **one combined proposal** covering the intended
result, recommended direction and why, preserved/excluded behavior, completion evidence,
remaining human choices if any, and the smallest role/model/effort roster with plain-language
responsibilities. Use [the message guide](templates/approval-message.md); omit inapplicable
parts. Avoid a questionnaire, a second intent-only approval, or technical-detail overload.
The user should be able to approve the direction and team in one short reply.

Wait for **explicit confirmation of both intent and roster before forming the team** in
Pi and Codex alike. A reply approving the concrete combined proposal covers both; a
generic earlier "implement it", silence, or approval of only one part does not. Keep a
new proposal in draft until accepted. An already active intent stays active when unchanged;
its acceptance alone does not approve a newly proposed roster. Cite the actual human
instruction/review, the proposal message, and the intent revision it covered. Store roster
acceptance with the existing mission, never as another intent record. After activation,
carry the newly returned reference; activation itself changes the file hash.

When the user accepts with a clear correction or chooses an offered alternative, apply
exactly that change and record their reply as its authority; do not demand a ceremonial
second yes. If the correction changes a still-unsettled material roster, commitment or
outcome, clarify only that delta before dependent work. Partial approval preserves what
was accepted; ask only for the missing decision, not the whole interview again.

Only interrupt before the combined proposal when one unavailable fact or human decision
blocks safe, meaningful discovery itself or prevents proposing any viable direction.
Otherwise batch remaining material choices into that proposal, with a recommendation and
its consequence. Outcome-blocking choices stay open until the human resolves them or
explicitly delegates a bounded choice. Local methods inside accepted scope stay autonomous.
For substantial non-team work, use the same evidence-first approach, without inventing a
roster; a precise current instruction can already authorize that exact bounded result.

Intent/roster confirmation preserves independent frame, model, budget, delivery and runtime
permissions. An active `FRAME_LOCK` remains authoritative for product-value invariants.
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
change and pause only dependent work. Present changed intent and any affected roster
together; unchanged approvals and same-owner corrections do not need a fresh ceremony.
Keep previous evidence attached to its original revision.

On resumption, handle the latest user direction, then reread intent and relevant
mission/board. Check status/revision before dependent execution; a compacted summary or
newest timestamp is not authority. Recover accepted proposal/roster references instead
of asking the user to repeat them. Investigate ordinary new factual gaps locally.

Fulfill only after the lead accepts evidence for the intended result and promised
delivery, not from idle agents or a completed board. Record a closure reference and
update existing permanent documentation as needed. Historical intent is not current-system
specification. Keep long evidence in the named run artifact area and fold useful facts
into existing owners. The helper never stages, commits, deletes history, or starts
another task automatically.
