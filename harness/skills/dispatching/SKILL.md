---
name: dispatching
description: "다른 세션에 일을 넘기는 브리프를 쓸 때 — 구속과 힌트를 가르고, 예산과 반환 계약을 싣고, 나간 뒤를 지켜본다."
---

# Dispatching

Run this when you are about to hand work to another session — a teammate, a subagent, a freehand worker on any lane. It shapes the brief you are composing; it is not a template to fill.

## What binds, and what is a lead

The force of a sentence comes from its content kind and the source of its authority, never from its tone.

Binding — the things you are the canon of:

- The outcome and why it matters.
- Done evidence: what will count as done for this outcome.
- Write ownership and off-limits paths — these protect other sessions' work.
- The budget: the elapsed time, spend, or scope growth at which the worker returns even though nothing is blocked. Name a number, and say that returning at budget with the surface still open is a valid completion.
- Constraints that carry a named authority source: the user asked for it, a spec or active frame states it, an external contract or another session's ownership requires it. Name the source next to the constraint.

Provisional — everything you believe about how the code is shaped: file coordinates, call paths, causal guesses, method ideas, suggested files to inspect. Ship them when they help — verified knowledge from earlier runs saves the worker a cold read — but they travel as leads the worker verifies against code, tests, and runtime, and may overrule. Being able to quote the line does not upgrade a lead: a correctly quoted line can still be a wrong interpretation. Provisionality does not survive serialization unless your register carries it; a guess shipped as fact pins the search to the wrong spot.

A quality concern you invented yourself is not a constraint. State it as something observable to verify — a measurement, a behavior — because a mechanism prohibition written without reading the code can forbid the only fix.

Keep read scope apart from write scope. "Look at these files" is a lead; "do not write these files" is a fence. Do not mix them in one list.

Two boundary cases, drawn from a real incident:

- Invented constraint → observable: "Do not widen the cache invalidation" forbade the only fix. "Widen it if you must — measure the repaint delta and report it" keeps the same performance concern and lets the worker move.
- Lead vs fence: "`transcript_blocks.zig` is probably where entries are assembled — verify" is a lead the worker may overrule. "`runtime.zig` is held by another session today — do not write it" is a fence, and stays one even if the worker disagrees.

## The receiving end

A worker whose session loads a role contract already knows how to read this brief. A worker that loads none — a freehand lane, an ad-hoc helper — gets one line instead: start by reading Skill(dispatched). Where that skill cannot reach the worker's harness, carry the license inline: repo claims here are provisional — verify them; a conflict with a binding line returns with evidence and a recommendation; at budget, return what you covered; no finding is a valid result.

## While it is out

A stalled worker has a shape you can see from outside: budget draining while nothing new appears — no edit, no test, no narrowed hypothesis appropriate to the task — and the same surface being read again. That shape, not elapsed time alone, is the signal.

Cut in and ask. Asked directly, a worker usually knows exactly what blocked it, and the answer arrives in one exchange where another hour of silence would have produced nothing. Steering an existing session keeps the thread; spawning a replacement pays a cold read for the same brief.

## When it comes back empty

A dispatch that ends without the artifact its task type should produce — no edit or test for a build, no anchor or narrowed hypothesis for an investigation, no verdict for a review — is not finished, and not a reason to spawn the next worker. Recover the cause from the same session first: ask which premise or constraint blocked it, with evidence. Classify — infrastructure failure, oversized surface, brief conflict, misrouting — before anything is resent. An unchanged brief handed to a new worker carries the shared cause with it; a worker swap is not a frame change.
