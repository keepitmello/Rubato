---
name: dispatched
description: "Contract for a session that works from a delegated brief, the first task or a follow-up task in the same session: what binds, what must be verified, what a map returns."
---

# Dispatched

Run this when you start from a brief someone handed you, and again when a follow-up brief arrives in the same session. It is the contract for reading that brief.

## Two kinds of sentences

The brief mixes two kinds of content, and the kind — not the tone, not a tag — decides its force.

Binding: the outcome and its done evidence, write ownership and off-limits paths, the budget, frozen items, and constraints with a named authority source — the user, a spec or frame, an external contract, another session's ownership. These hold regardless of what you infer, because another session may be holding the same repository.

Provisional: every claim about how the code is shaped — where things are, how a mechanism works, why it fails, which files matter. These are the sender's reading, not ground truth, however confidently written. Code, tests, and runtime evidence settle them.

## When the brief asks for a map

Inside the area you were given, decide for yourself: what to read, which explanations the evidence rules out, whether a reproduction can be trusted. Narrow the list as far as the evidence lets you, say why each dropped explanation is out, and if only one is left in your area, say so plainly. What you leave to the sender is the decision that needs more than your area: what the cause is overall, what to change, whether the scope should move. The sender sees other agents' findings and the whole request; you do not. Return your evidence and say where your area ended, so the sender can decide.

## A follow-up task in the same session

You already know this code; use that, do not start over. Follow the direction the sender chose. But the sender's beliefs about the code and the cause are still claims to check, like in any brief: the sender may be working from a wrong assumption, and you may hold the evidence that shows it. If the new direction clashes with what you found, report what you found instead of quietly going either way.

## What you do with a wrong lead

A merely wrong coordinate you can correct inside your outcome and write ownership is yours to fix: fix it, note it in your report, keep going. Do not escalate what you can settle.

Return instead of working around it when the conflict is real: a binding constraint and the code evidence cannot both hold, the only viable fix crosses write ownership or off-limits, or the outcome is unreachable without changing the requirements. Report the conflicting clause, the evidence, viable options, and your recommendation. That return is a completed dispatch, not a failure.

## Frozen items

A frozen item is something the user locked (a value, behavior, feel, layout or copy), listed with its source. If the task cannot be finished without changing one, stop and return with that conflict. Do not pick between the task and the freeze, and do not keep the old value in a comment while replacing what uses it.

When the brief listed frozen items, your return carries one line: `Frozen items touched: none`, `Frozen items touched: <which>, <why the task required it>`, or `Frozen items: list unavailable, <why>` when you could not read the list. That line is a self-report; where the repository has frozen checks, run them as the evidence.

## Visual or felt work

When the brief names the decision an artifact (a screen, a sound, a control feel) must support, hand back a working, judgment-ready candidate and fix the omissions you can inspect yourself; a first render is not an automatic stop. An explicit preview checkpoint or user stop still binds even with known gaps: report the gaps instead of polishing past it. Once a user preference becomes the deciding question, show the useful candidate promptly rather than polishing it unseen. Use evidence the observer can actually inspect. A static frame does not prove full-speed rhythm; if an observation channel is unavailable, report that limit, ask only for the missing observation, and keep going on the rest of your authorized work.

## Other valid endings

Reaching the budget with the surface still open: return what you covered, what remains, and the next cut you recommend.

Looked for something and it is not there: "not there," with what you checked and what that rules out, is the result. Do not manufacture a finding to justify the dispatch.

## Blocked has a shape

When you notice yourself rereading the same files with nothing new to show — no edit, no test, no narrowed hypothesis — you are blocked. Say you are blocked and why, instead of digging quieter. That report is worth more than another pass over the same surface.

## Preserve the intent reference

This section applies when the brief supplies `intent_ref`. Read that source before dependent execution.
Use the lead's canonical workspace, including from another worktree. Managed records
are checked with the sibling `work-intent` check against the supplied SHA-256 and
active status for implementation; external sources use their own version and acceptance mechanism.
An explicitly discovery-only brief may reference a draft: check its supplied hash without
`--active`, gather only the authorized facts/checks, and stop before implementation. A draft
reference alone does not grant this exception or any additional permission.
A missing, stale or superseded authority, or a draft used for implementation, returns
to the sender with the exact mismatch. Continue unaffected authorized work only. Subagents without durable intent
work from their bounded brief; they do not create an intent or team themselves.

The lead owns the shared intent. Preserve its reference in your result and any
subagent brief, and name the revision your evidence covers. At resumption or a
material follow-up reread it, rather than trusting the old summary. If requirements
must change, return evidence to the lead; keep local implementation choices local.
Resolve discoverable gaps with available evidence instead of forwarding a questionnaire.
Bring material human choices to the lead with what was checked, viable options and a
recommendation; the lead owns the combined user conversation. Never fill an unavailable
fact or preference with an unmarked guess.
