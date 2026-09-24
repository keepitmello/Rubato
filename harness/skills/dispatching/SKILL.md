---
name: dispatching
description: "Handing work to another session, or sending the next task to an existing one: decide continue-versus-fresh, separate binding from hints, carry budget and return contract, watch after dispatch. Read before every Agent spawn or AgentSend."
---

# Dispatching

Run this when you are about to hand work to another session (a teammate, a subagent, a freehand worker on any lane), and when you are about to send the next task to a session that already exists. It shapes the brief you are composing and the choice of who receives it; it is not a template to fill.

## Check the execution shape and carry its authority

A root lead considering continuing owners, independently ownable outcomes or
cross-owner coordination reads the runtime-correct `agent-taskforce` skill before
settling on a team or focused agent. This read may choose no team. A small isolated
subagent or an owner delegating within an accepted boundary needs no new team ceremony.

For work with durable intent, resolve it through `work-intent` before continuing-owner
assignments. Put the same `intent_ref` and canonical workspace in the brief and in
existing board `metadata` where supported. Link the relevant intent/spec clauses;
state only this owner's outcome and its contribution, not a duplicate overall mission.
Require the recipient to read the referenced source before dependent work and to name
its revision with returned evidence. Propagate that reference to subagents and replacement
sessions. A follow-up that materially changes the intent first goes through the lead's
acceptance/update path; an old brief must not silently override the new source.

## Discovery before the combined proposal

Before team staffing, the lead uses relevant repository/connected evidence and current
primary web sources to resolve discoverable facts. A bounded discovery subagent may receive
a draft intent with explicit discovery-only authority, read scope, permitted disposable
checks and a budget; it returns evidence and does not implement or become a continuing
owner. The receiver checks the draft's exact reference without requiring active status.
Do not relabel execution owners as subagents to bypass combined intent/roster confirmation.

When execution is approved, pass the accepted intent reference and boundaries. Owners
settle local factual/implementation gaps and already-delegated tradeoffs. If a choice
would materially sacrifice an established benefit or change agreed priorities beyond
that authority, return the evidence and recommendation before applying it broadly.
The lead decides within its authority and consolidates only the remaining human decision.
Related follow-ups reuse approval and context; material intent/roster/cost changes require
a delta confirmation. Carry directly relevant prior failures with their conditions as
source references, not technique bans or a requirement to reread the whole history.

## What binds, and what is a lead

The force of a sentence comes from its content kind and the source of its authority, never from its tone.

Binding: the things you are the canon of:

- The outcome and why it matters.
- Done evidence: what will count as done for this outcome.
- Write ownership and off-limits paths; these protect other sessions' work.
- The budget: the elapsed time, spend, or scope growth at which the worker returns even though nothing is blocked. Name a number, and say that returning at budget with the surface still open is a valid return, not proof that the outcome is satisfied.
- Constraints that carry a named authority source: the user asked for it, a spec or active frame states it, an external contract or another session's ownership requires it. Name the source next to the constraint.
- Frozen items: values, behaviors, feels, layouts, or copy the user has locked ("keep this", "do not touch", "freeze"). List each one in the brief with its source and date ("physics constants and the formula that uses them: frozen, user, 2026-08-14"). A frozen item that lives only in a document the worker was not told to read does not exist for that worker. If the task cannot be completed without changing a frozen item, the worker stops and returns with that conflict; it does not choose between the task and the freeze, and it does not satisfy the freeze by leaving the old value in a comment while replacing what uses it.

When feedback revises a choice inside existing authority — a method, a layout, a phrasing — do not just append the new requirement to the next brief. Replace the superseded interim rule and the check that was tied to it, so the brief and its done evidence do not still enforce what was dropped; keep the user conditions and required checks that remain valid, and record the adopted change with its reason beside the relevant binding item rather than in a second ledger. A worker already on the task receives the affected change and a reference to the current result. Test the distinction on the interim-versus-frozen line: an interim "all cards square" chosen by the owner leaves with the new portrait card and its square check; a user-frozen "keep the cards square" survives "make it prettier" until the user lifts it.

Provisional: owner-chosen methods, sequence, candidate counts and comparison setup, plus beliefs about how the code is shaped: file coordinates, call paths, causal guesses, method ideas, suggested files to inspect. Ship them when they help (verified knowledge from earlier runs saves the worker a cold read), but they travel as leads the worker verifies against code, tests, and runtime, and may overrule. Being able to quote the line does not upgrade a lead: a correctly quoted line can still be a wrong interpretation. Provisionality does not survive serialization unless your register carries it; a guess shipped as fact pins the search to the wrong spot.

Why frozen items need their own line: when a task and a rule conflict inside a worker, the task wins, because the task is what the worker is measured on. A rule arriving as background prose reads as a preference; the same rule arriving as a named fence with a stop instruction reads as a boundary.

A quality concern you invented yourself is not a constraint. State it as something observable to verify (a measurement, a behavior), because a mechanism prohibition written without reading the code can forbid the only fix. Preserve a baseline without freezing every alternative parameter. Keep coupled behavior together when the intended experience requires it; a one-variable comparison is a method, not default authority.

Keep read scope apart from write scope. "Look at these files" is a lead; "do not write these files" is a fence. Do not mix them in one list.

Two boundary cases, drawn from a real incident:

- Invented constraint → observable: "Do not widen the cache invalidation" forbade the only fix. "Widen it if you must; measure the repaint delta and report it" keeps the same performance concern and lets the worker move.
- Lead vs fence: "`transcript_blocks.zig` is probably where entries are assembled; verify" is a lead the worker may overrule. "`runtime.zig` is held by another session today; do not write it" is a fence, and stays one even if the worker disagrees.

## The receiving end

A worker whose session loads a role contract already knows how to read this brief. A worker that loads none (a freehand lane, an ad-hoc subagent) gets one line instead: start by reading Skill(dispatched). Where that skill cannot reach the worker's harness, carry the license inline: repo claims here are provisional; verify them; a conflict with a binding line returns with evidence and a recommendation; at budget, return what you covered; no finding is a valid result.

The return contract has a fixed column when frozen items were listed, with three values: `Frozen items touched: none`, `Frozen items touched: <which>, <why the task required it>`, or `Frozen items: list unavailable, <why>` (the brief named a list the worker could not read, or the repository's frozen list could not be found). "Unavailable" is not "none"; a worker that could not read the list reports that, and does not report `none`. A return without this column when the brief listed frozen items is incomplete. This column makes the worker check the list before returning; it is a self-report, not evidence. Where the repository carries frozen checks, the checks are the evidence, and a self-report of `none` does not replace running them.

For visual or felt work (a screen, a sound, a control feel), name the decision the
artifact must support and any explicit preview checkpoint in the brief. A first render
is not an automatic stop. Within the accepted scope, the owner prepares a functioning,
judgment-ready candidate and corrects inspectable omissions before returning it.
An explicit first-preview checkpoint or user stop still binds, even if the candidate
has known gaps; report those gaps rather than polishing past that boundary. Once a
meaningful user preference is needed, show the useful candidate promptly instead of
polishing unseen. A preview assignment does not authorize product integration.

Use evidence the observer can actually inspect. Static frames do not prove full-speed
rhythm. If an observation channel is unavailable, report that limit and request only
the remaining observation; do not make a new tool a prerequisite for unrelated progress.
Do not relabel an avoidable, inspectable loss as taste, or an optional improvement as a
required repair. On receipt, return a supported in-scope failure to its implementation
owner for correction and recheck of the changed result through the agreed evidence path.
A reviewer does not repair production code it will independently judge. A review report
or a first screenshot is not automatic user handoff. The lead handles acceptance and
material choices without duplicating the owner's technical checks.

## Reuse the agent or start a new one

Part of every dispatch is choosing who gets it. If an agent already worked on this same problem, send the next task to that agent: it has already read the files, and a new one would read them all again. This holds when the work moves from looking to building, from building to fixing a failed test, or when you changed your mind about the approach after seeing its report.

A fresh session needs a concrete reason: a genuinely different outcome, independent review, a persistently refuted premise the old session cannot release, unavailable continuation, or an explicit approved reassignment whose remaining benefit repays the handoff. A stronger model merely being available is not enough. For an actual reassignment, preserve artifacts, current modifications, refuted hypotheses, remaining checks and authority; do not transfer an unexplained failure and call it escalation. Once a new assignment is justified, Skill(model-guide) chooses its model. Keep related work with the current session whenever it remains the useful choice.

If `AgentSend` says the agent cannot be continued, first tell why. Evicted, crashed or expired is an execution failure: when the assignment still permits it, start a new one (or `team_replace_member` for a teammate) and pass along whatever the old one left behind (its report, files, evidence) as leads to verify; if nothing was left, say so in the brief. Cancelled by the user, an explicit stop or an exhausted budget is not permission to restart the same work under a new session — report the remaining gap instead of silently changing the owner.

## While it is out

A stalled worker has a shape you can see from outside: budget draining while nothing new appears (no edit, no test, no narrowed hypothesis appropriate to the task) and the same surface being read again. That shape, not elapsed time alone, is the signal.

Ask the current owner what blocked progress and request the evidence needed to choose a response. A declared long-running check or expected dependency wait is not a stall merely because no message arrived. Owners manage local corrections, helpers and integration; the lead addresses intent, commitments and responsibility changes rather than selecting the next debugging command.

Budget exhaustion, a failed test or repeated advice is not proof of model incapability. Distinguish target defects, invalid measurements, environment/permission failures, brief conflicts, oversized scope and a refuted approach. Continue, obtain bounded peer evidence, revise an authorized method or explicitly reassign according to that cause. Do not impose a retry count or cheapest-first failure ladder.

## When it comes back empty

Judge the return against its assignment. A judgment-ready preview completes a preview
assignment; a screenshot of an absent promised behavior does not fulfill an implementation
assignment. Budget, authority, observation limits and explicit checkpoints can all justify
a valid return with work remaining. They are not proof that the requested outcome is done.

Recover the cause from the same session first when the required result is missing.
Ask which premise, constraint or capability blocked it, with evidence; use that cause to
choose in-scope repair, a revised approach, a material decision or a stop at the boundary.
Do not resend an unchanged brief to a new worker instead of diagnosing the shared cause.
An auxiliary tool failure grants no new installation or environment-rebuild authority;
use an authorized existing route or return the concrete gap that blocks progress.

## Account for the extra context before delegating

The sending owner chooses local support; the lead does not relay those assignments.
Name what the separate session contributes and what work stays with the sender.
Consider briefing, duplicate reading, result integration, waiting and shared resource
contention as well as token volume. Do not fabricate savings from the mere presence
of a cheaper model. Coupled judgment and implementation can remain in one strong
session; bounded helpers still reason inside their assignment.

For a technical integration assignment, name the accountable owner and shared write
surface. For independent verification, send authoritative artifacts, acceptance
criteria and actual state rather than the producer's reasoning or desired verdict.
Use an existing approved verifier when it covers the claim. A verifier does not need
a further verifier automatically, and the lead's fulfillment decision does not
require redoing the owner's implementation or the verifier's checks.
