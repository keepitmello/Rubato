---
name: model-guide
description: "Use when selecting an agent model, provider route or effort setting for delegated work, including implementation and independent verification."
---

# Model guide

Start from the default allocation and use a stronger model when the work looks
hard. Owner and verifier are responsibility boundaries, not model tiers: any
approved model can own a bounded result end to end or hold an independent judgment.

The user chooses the lead model, and it stays until the user changes it. Models for
owners, verifiers and helpers are a separate choice you make here.

## Choose a session before choosing a model

Read Skill(dispatching) first. An existing session holding the relevant code,
refuted hypotheses and current changes usually beats a fresh session of any model.
Choose a model only once a new session is justified.

## Pick the model

Explicit user choices come first: a selected model, approvals, allowed providers
and effort.

For a subagent or helper, use the default below without further deliberation.
If the work looks hard to you, use a stronger model instead; that call needs no
measurement or prior failure.

For a team, put the defaults in the combined intent/roster proposal and name a
stronger model where the work looks hard, with a one-line reason. The user knows
best how hard the work is; their correction to the roster decides.

If a chosen route is unavailable or out of quota, pick another approved one and
say which ran. A registered label is not proof that a route works. Acceptance
criteria stay the same whichever model runs.

## Default allocation

This records the user's experience so far. Update it here when new experience
changes it.

- Default for owners and helpers: **DeepSeek**. Default verifier: **Grok**.
- Stronger: **Opus**. **Fable or Astra** with explicit approval.
- Any approved model can own or verify.

Exact ids: DeepSeek V4.1 Flash `b-ai/deepseek-v4.1-flash`, Grok 4.7 via xAI
`xai/grok-4.7` or Cursor `cursor/grok-4.7`, Opus 5.5 `anthropic/claude-opus-5-5`,
Fable 5.1 `anthropic/claude-fable-5-1`, Astra `openai-codex/gpt-6-astra`. The
`Agent` schema lists the live catalog; resolve other routes there. A stale or
unavailable id fails closed.

A `-sub` id is the same model on the user's second account. It is a separate route
with its own availability, so record which route actually ran.

## Use the pool for real work

Spread independent work across the approved pool when that uses available
resources well; a model sitting idle is not a reason to hold back useful work.
Every helper, parallel task or verifier still has to earn its place by what it
contributes. Keep the chosen lead, the effective owners and the acceptance bar
as they are.

Tokens, API-equivalent dollars, elapsed time and subscription quota are different
measurements, and one route's pricing or plan treatment says nothing about
another's. When resource evidence matters, keep its route/account and date. Use
local evidence you already have; ordinary work does not wait for new telemetry.

## Settings and actual identity

Pass an exact `provider/model` or a named `preset` the live harness accepts. The
same display name on two routes may spend different resources.

Omit `effort` so the configured default applies. Keep explicit user settings;
override only for a supported, authorized reason; a role label or your reading of
difficulty is not one. Report the requested model and
effort separately from what the runtime confirms actually ran. If identity is not
reported, say so rather than provoking errors to find out.

An exactly specified model that is unavailable fails visibly. The harness resolves
a preset by its own configured policy; any result still needs its approval.

## Approval

Fable (including Fable 5.1) and Astra require explicit user approval naming the
outcome, model and effort before assignment, including verification. A readable
combined intent/roster approval satisfies that gate when it includes those
commitments. An approval covers its stated scope, not the whole pool.

Corrections, retries and re-verification by the same approved owner on the same
outcome keep that approval. A new outcome, a materially changed roster or a higher
restricted-model effort needs the relevant confirmation. DeepSeek, Grok and Opus
have no model-specific gate; team formation, write boundaries and delivery
permissions still apply, and a helper does not bypass any approval.

## Advice and independent verification

Advice is a bounded question whose answer can change the owner's next action; any
relevant approved model can give it. The owner keeps the outcome and integrates the
evidence. Judge advice by what it changed, not by a call count. If the adviser keeps
having to reconstruct and direct the whole outcome, weigh continuing, revising the
brief, making the adviser the owner or stopping that approach, handoff cost included.

Independent verification needs a fresh session reading the authoritative artifacts
and acceptance criteria, not the builder's reasoning or desired verdict. Any capable
approved model can verify, the builder's own family included; the actual builder
never certifies its own work as independent. Call it cross-family review only when
the actual model identities differ. Neither freshness nor a different family
guarantees correctness.

## Learn from results

When a result should change future allocation, record the actual model, effort and
route, the outcome and checked revision, the evidence, and any material help or
reassignment. Keep a completed turn, a valid budget return, an accepted outcome, a
measurement failure and user rework apart. A first assignment and inherited stalled
work are different samples; do not compare their success rates as model ability.
Fold what holds up into the default allocation above.
