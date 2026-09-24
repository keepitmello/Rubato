---
name: dispatching
description: "Handing work to another session, or sending the next task to an existing one: decide continue-versus-fresh, separate binding from hints, carry budget and return contract, handle blocks and short returns. Read before every Agent spawn or AgentSend."
---

# Dispatching

Run this when you are about to hand work to another session (a teammate, a subagent, a freehand worker on any lane), and when you are about to send the next task to a session that already exists. It shapes the brief you are composing and the choice of who receives it; it is not a template to fill.

## Is a separate session worth it

Name what the separate session contributes and what stays with you. Weigh that against briefing, duplicate reading, result integration, waiting and shared-resource contention, not token volume alone; a cheaper model being available is not a saving by itself. Coupled judgment and implementation can stay in one strong session, and a bounded helper still reasons inside its assignment.

A focused subagent, or an owner delegating inside its accepted boundary, needs no team ceremony. A root lead weighing continuing owners, independent outcomes or a team reads Skill(agent-taskforce) first; that read may choose no team.

## What binds, and what is a lead

The force of a sentence comes from its content kind and the source of its authority, never from its tone.

Binding: the things you are the canon of:

- The outcome and why it matters.
- Done evidence: what will count as done for this outcome.
- Write ownership and off-limits paths; these protect other sessions' work.
- The budget: the elapsed time, spend, or scope growth at which the worker returns even though nothing is blocked. Name a number, and say that returning at budget with the surface still open is a valid return, not proof that the outcome is satisfied.
- Constraints that carry a named authority source: the user asked for it, a spec or active frame states it, an external contract or another session's ownership requires it. Name the source next to the constraint.
- Frozen items: values, behaviors, feels, layouts, or copy the user has locked ("keep this", "do not touch", "freeze"). List each one in the brief with its source and date ("physics constants and the formula that uses them: frozen, user, 2026-08-14"). A frozen item that lives only in a document the worker was not told to read does not exist for that worker. If the task cannot be completed without changing a frozen item, the worker stops and returns with that conflict; it does not choose between the task and the freeze, and it does not satisfy the freeze by leaving the old value in a comment while replacing what uses it.

When feedback revises a choice inside existing authority, record the adopted change and its reason beside the binding item it affects, and retire the superseded interim rule together with the check that enforced it. Do not append the new requirement on top of the old one or keep a second ledger.

Provisional: owner-chosen methods, sequence, candidate counts and comparison setup, plus beliefs about how the code is shaped: file coordinates, call paths, causal guesses, method ideas, suggested files to inspect. Ship them when they help (verified knowledge from earlier runs saves the worker a cold read), but they travel as leads the worker verifies against code, tests, and runtime, and may overrule. Being able to quote the line does not upgrade a lead: a correctly quoted line can still be a wrong interpretation. Provisionality does not survive serialization unless your register carries it; a guess shipped as fact pins the search to the wrong spot.

Why frozen items need their own line: when a task and a rule conflict inside a worker, the task wins, because the task is what the worker is measured on. A rule arriving as background prose reads as a preference; the same rule arriving as a named fence with a stop instruction reads as a boundary.

A quality concern you invented yourself is not a constraint. State it as something observable to verify (a measurement, a behavior), because a mechanism prohibition written without reading the code can forbid the only fix. Preserve a baseline without freezing every alternative parameter. Keep coupled behavior together when the intended experience requires it; a one-variable comparison is a method, not default authority.

Keep read scope apart from write scope. "Look at these files" is a lead; "do not write these files" is a fence. Do not mix them in one list.

Two boundary cases, drawn from a real incident:

- Invented constraint → observable: "Do not widen the cache invalidation" forbade the only fix. "Widen it if you must; measure the repaint delta and report it" keeps the same performance concern and lets the worker move.
- Lead vs fence: "`transcript_blocks.zig` is probably where entries are assembled; verify" is a lead the worker may overrule. "`runtime.zig` is held by another session today; do not write it" is a fence, and stays one even if the worker disagrees.

Some assignments carry one more line. For technical integration, name the accountable owner and the shared write surface. For independent verification, send authoritative artifacts, acceptance criteria and actual state, not the producer's reasoning or desired verdict. For discovery ahead of a decision, state discovery-only authority, read scope, permitted disposable checks and the budget. Carry directly relevant prior failures with their conditions as source references, not as technique bans or a demand to reread the whole history.

## Carry the intent reference

When the work has durable intent (Skill(work-intent)), put the same `intent_ref` and canonical workspace in the brief, and in board `metadata` where supported. Link the relevant clauses and state only this recipient's outcome, not a copy of the whole mission. Ask the recipient to read the source before dependent work and to name the revision its evidence covers; the same reference travels to its subagents and to replacement sessions. A follow-up that materially changes the intent goes through the lead's acceptance path first; an old brief never overrides the new source.

## The receiving end

A worker whose session loads a role contract already knows how to read this brief. A worker that loads none (a freehand lane, an ad-hoc subagent) gets one line instead: start by reading Skill(dispatched). Where that skill cannot reach the worker's harness, carry the license inline: repo claims here are provisional; verify them; a conflict with a binding line returns with evidence and a recommendation; at budget, return what you covered; no finding is a valid result.

The return contract has a fixed column when frozen items were listed, with three values: `Frozen items touched: none`, `Frozen items touched: <which>, <why the task required it>`, or `Frozen items: list unavailable, <why>` (the brief named a list the worker could not read, or the repository's frozen list could not be found). "Unavailable" is not "none"; a worker that could not read the list reports that, and does not report `none`. A return without this column when the brief listed frozen items is incomplete. This column makes the worker check the list before returning; it is a self-report, not evidence. Where the repository carries frozen checks, the checks are the evidence, and a self-report of `none` does not replace running them.

For visual or felt work (a screen, a sound, a control feel), name the decision the artifact must support and any explicit preview checkpoint. A preview assignment does not authorize product integration. What the receiver owes in return (a judgment-ready candidate, honest observation limits) is in Skill(dispatched).

## Reuse the agent or start a new one

Part of every dispatch is choosing who gets it. If an agent already worked on this same problem, send the next task to that agent: it has already read the files, and a new one would read them all again. This holds when the work moves from looking to building, from building to fixing a failed test, or when you changed your mind about the approach after seeing its report.

A fresh session needs a concrete reason: a genuinely different outcome, independent review, a persistently refuted premise the old session cannot release, unavailable continuation, or an explicit approved reassignment whose remaining benefit repays the handoff. A stronger model merely being available is not enough. For an actual reassignment, preserve artifacts, current modifications, refuted hypotheses, remaining checks and authority; do not transfer an unexplained failure and call it escalation. Once a new assignment is justified, Skill(model-guide) chooses its model. Keep related work with the current session whenever it remains the useful choice.

If `AgentSend` says the agent cannot be continued, first tell why. Evicted, crashed or expired is an execution failure: when the assignment still permits it, start a new one (or `team_replace_member` for a teammate) and pass along whatever the old one left behind (its report, files, evidence) as leads to verify; if nothing was left, say so in the brief. Cancelled by the user, an explicit stop or an exhausted budget is not permission to restart the same work under a new session — report the remaining gap instead of silently changing the owner.

## While it is out

Let the worker work. Completion, failure and permission notices arrive on their own; do not watch its transcript, logs or result file for progress. A worker that finds itself blocked says so (Skill(dispatched)), and a budget return comes back by itself. A declared long-running check or an expected dependency wait is not a stall.

When a worker reports it is stuck, ask what blocked progress and request the evidence you need to choose a response. Answer at the level of the brief (a decision, a boundary change, peer evidence) rather than picking its next debugging command.

## When it comes back short

Judge the return against its assignment. A judgment-ready preview completes a preview assignment; a screenshot of an absent promised behavior does not fulfill an implementation assignment. A review report or a first screenshot does not go to the user automatically; the lead decides what reaches the user. Budget, authority, observation limits and explicit checkpoints can all justify a valid return with work remaining; they are not proof that the requested outcome is done. Do not relabel an avoidable, inspectable loss as taste, or an optional improvement as a required repair.

When the required result is missing, recover the cause from the same session first: which premise, constraint or capability blocked it, with evidence. Tell apart a target defect, an invalid measurement, an environment or permission failure, a brief conflict, an oversized scope and a refuted approach. Budget exhaustion, a failed test or repeated advice is not proof of model incapability. From that cause choose in-scope repair, a revised approach, bounded peer evidence, a material decision, an explicit reassignment or a stop at the boundary; there is no retry count or cheapest-first ladder. Do not resend an unchanged brief to a new worker instead of diagnosing the shared cause.

A supported in-scope failure goes back to its implementation owner for correction and a recheck of the changed result; the sender does not take the fix over. An auxiliary tool failure grants no new installation or environment-rebuild authority; use an authorized existing route or return the concrete gap that blocks progress.
