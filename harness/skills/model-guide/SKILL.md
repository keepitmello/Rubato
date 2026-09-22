---
name: model-guide
description: "Use when selecting an agent model, provider route or effort setting for delegated work, including implementation and independent verification."
---

# Model guide

Choose the execution resource, not an intelligence-based job title. An owner holds
a bounded result end to end; a verifier holds a judgment independent of its production.
DeepSeek, Grok, Opus, Fable and Astra may fill either role when authorized and available.
No family is reserved for planning, long sessions, implementation or review.

The user chooses the lead. Keep that conversational counterpart unless the user
changes it. Execution allocation is a separate choice: use other approved models as
owners or bounded support without asking the user to rotate the lead manually.

## Choose a session before choosing a model

Read Skill(dispatching) first. An existing owner with relevant evidence, refuted
hypotheses and current changes is not interchangeable with a cold replacement.
Continue related work unless the reason for a fresh session outweighs that loss.

For a new assignment:

1. Respect explicit model selection, approvals, allowed providers, supported tools
   and effort. A registered label is not proof of a usable route.
2. Use relevant completed-work evidence and the user's reported experience where
   available. Name their scope; absence of evidence is not evidence of inability.
3. Consider current availability, competing assignments, quota headroom and user
   resource preferences. Distinguish observed headroom from an older user report.
4. Choose a candidate and explain the actual reason for it. When evidence does not
   distinguish candidates, use authorized resource availability and allocation
   preferences rather than inventing an aptitude story.

Unknown work is not necessarily difficult. A broad change is not a difficulty
measurement. Do not require a difficulty score, a cheapest-model trial, failed
lower-tier attempts or a special request for "highest quality" before using a
stronger model. Acceptance criteria stay the same for every selected model.

## Default allocation

The operator reports comparable performance from DeepSeek, Grok and Opus, with
DeepSeek the cheapest and fastest of the three (2026-09-22). This is the user's
working experience, not a benchmark or a measured price/quota claim.

- Default owner and bounded support: **DeepSeek**.
- When independent verification is useful: **Grok** by default.
- **DeepSeek, Grok and Opus can all own or verify.** These defaults reflect cost
  and speed preferences, not role restrictions or an intelligence ranking.
- For difficult topics, design or judgment, propose **Fable or Astra** when their
  contribution is worth it, with explicit approval. A failed DeepSeek attempt is
  not a prerequisite.

Exact ids: DeepSeek V4.1 Flash `b-ai/deepseek-v4.1-flash`, Grok 4.7 via xAI
`xai/grok-4.7` or Cursor `cursor/grok-4.7`, Fable 5.1 `anthropic/claude-fable-5-1`, Astra
`openai-codex/gpt-6-astra`. Resolve Opus and alternative provider routes from the
live catalog the `Agent` schema lists; a stale or unavailable id fails closed.

A `-sub` id (`anthropic/claude-opus-5-sub`, `anthropic/claude-fable-5-1-sub`,
`openai-codex/gpt-5.6-sol-sub`) is an id-clone of the same upstream model bound to
the second account slot, not a different model or effort. The picker labels it
`Opus 5 [sub]`. Rows appear only where a second account exists and only for the
curated pairs (Anthropic Fable/Opus, Codex Sol/Astra); a leftover credential slot
elsewhere does not create them. The plain id and its `-sub` copy are separate
routes and their availability is decided separately — one failing says nothing
about the other, so read the live catalog and record which route actually ran.

## Use the model pool without manufacturing work

Allocate new independent work across the approved pool when that uses available
resources well; do not leave a useful resource idle solely because it was called
a "lead model." Equally, do not create helpers, duplicate a task, replace an
effective owner or lower acceptance standards just to use every model.
Do not create a verifier merely to complete a pair. Utilization is considered
across useful work, not a quota of model names inside each team.

Token volume, API-equivalent dollars, elapsed time and subscription quota are
different measurements. In particular, neither an API cache discount nor an
operator report that Opus cache reads do not debit a plan establishes the other
models' live plan coefficients. Do not hard-code those as prices or infer free
compute. Preserve route/account and measurement date when resource evidence matters.
Prefer available local evidence; lack of telemetry does not require a new service,
calibration job or an interview before ordinary work.

## Roles, settings and permissions are separate

Use an exact `model` (`provider/model`) or a named `preset` accepted by the live
harness; never a category, task type, or `subagent_type`. Resolve the exact route
from the live catalog. Opus has a place in the pool; do not infer its ID from a
different runtime. The same display name on two routes may spend different resources.

Omit `effort` normally so the configured model default applies. Preserve explicit
user settings. Override only for a supported, authorized choice, not because of a
role label, guessed difficulty or a universal low/high recommendation. A preset
does not create another effort-precedence rule. Report requested settings separately
from actual runtime-confirmed model and effort.

Exactly specified unavailable models fail visibly rather than silently switching.
The harness resolves a named preset against its actual configured policy; do not
invent a fallback chain. Any resulting model still has to satisfy approval and
assignment requirements.

## Approval

Fable (including Fable 5.1) and Astra require explicit user approval naming the
outcome, model and effort before assignment, including verification. A readable combined intent/roster approval
can satisfy that gate when it includes those commitments. Existing approval is
for its stated scope, not an unlimited pool grant.

Corrections, retries and re-verification by the same approved owner on the same
outcome retain that approval. A new outcome, materially changed roster or higher
restricted-model effort requires the relevant confirmation. DeepSeek, Grok and Opus have
no additional model-specific gate, but team formation, write boundaries and
delivery permissions still apply. A helper is not an approval bypass.

## Advice and review

Advice is a bounded question whose answer can change the owner's next action.
It may come from any relevant approved model. Keep the owner; integrate the evidence,
not a command hierarchy. Repeated advice is not automatically waste or an automatic
transfer trigger. If the adviser repeatedly has to reconstruct and direct the whole
outcome, compare continuing, changing the brief, making it an owner or stopping that
approach, including handoff costs. Do not use a fixed call count.

Independent verification starts with a fresh context, authoritative artifacts and
acceptance criteria, without inheriting the builder's desired verdict or reasoning.
Any capable approved model, including the same family in a separate session, may
verify. Call this independent review; describe cross-family diversity only when
actual model identity supports it. Neither a different family nor freshness alone
guarantees correctness. Never let the actual builder certify its own work as
independent.

## Learn without adding a routing bureaucracy

Use existing result artifacts and measurement records when available. Distinguish
a completed turn, valid budget return, accepted outcome, measurement failure and
user rework. Record the actual model/effort/route, outcome and checked revision,
evidence, and material assistance or reassignment when this changes future allocation.
Do not invent self-grades or turn an unvalidated speed index into a quality rank.

Initial assignments and inherited stalled work are different samples. Do not compare
their raw success rates as model ability. Keep observations task- and runtime-specific.
No new router agent, universal score, forced tournament or learned selector is required.
