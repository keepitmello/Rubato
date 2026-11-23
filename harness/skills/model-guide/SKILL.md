---
name: model-guide
description: "Use when selecting an agent model, provider route or effort setting for delegated work, including implementation and independent verification."
---

# Model guide

Choose from the default allocation. Owner and verifier are responsibility
boundaries, not model tiers: any approved model can own a bounded result end to
end or hold an independent judgment.

The user chooses the lead model, and it stays until the user changes it. Models for
owners, verifiers and subagents are a separate choice you make here.

## Choose a session before choosing a model

Read Skill(dispatching) first. An existing session holding the relevant code,
refuted hypotheses and current changes usually beats a fresh session of any model.
Choose a model only once a new session is justified.

## Pick the model

Explicit user choices come first: a selected model, approvals, allowed providers
and effort.

For a subagent, pick from the default allocation below and spawn it; reading
usage is the only check the choice needs.

For a team, put each member's model in the combined intent/roster proposal with a
one-line reason; the user's correction to the roster decides.

If a chosen route is unavailable or out of quota, choose another from the list
below and say which ran. A registered label is not proof that a route works.
Acceptance criteria stay the same whichever model runs.

## Default allocation

This is the product rule, drawn from the user's experience so far. Update it here
when new experience changes it.

Subscription quota runs out before it resets, so every assignment spends a share
that other work then lacks. Choose the provider first, then the model by role.

**Provider.** Read `rubato auth usage --json` and go where the most quota is left
for the time until reset. An account with any window at 100% is out until that
window's `resetsAt`. A Codex account's `resetCredits` is how many more times its
weekly window can be refilled; count each as one more week. A row's `modelSuffix`
is the suffix its model ids carry (`-sub` reads `anthropic/claude-opus-5-5-sub`).
An account that cannot be read is not proof of room.

**Model by role.**

| Role | Claude | Codex |
|---|---|---|
| Owner | Opus | Astra |
| Subagent | Sonnet | Sol |
| Reviewer | Opus, for work Codex built | Astra, for work Claude built |

An owner holds the outcome and the judgement after it, so it runs on the top line.
A subagent returns one bounded piece, so it runs one line down; give it Opus or
Astra when the piece carries a judgement the owner would otherwise have to redo.
An owner can run subagents from both providers at once. A reviewer comes from the
other provider than the builder; when that provider is out, a fresh session from
the builder's provider reviews.

- **Fable**: with explicit approval.
- **Gemini** (`agy/*`) and **Grok**: when the user names them. Local `agy` runs one
  single `Agent` call at a time; never use it in teams, parallel fan-outs or
  automated loops, where team members are rejected.

The `Agent` catalog lists only models from providers this user has signed in to,
and it is the source of exact ids. A family missing from it is one this user does
not have, not a failure: choose among the rest, falling back to the lead's own
model, and say which one ran.

A model registered on several accounts appears once per account, such as Opus 5.5
and Opus 5.5 [sub]; spread work across them by the same usage reading.

## Use the pool for real work

Spread independent work across the approved pool when that uses available
resources well; a model sitting idle is not a reason to hold back useful work.
Every subagent, parallel task or verifier still has to earn its place by what it
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

Fable requires explicit user approval naming the outcome, model and effort before
assignment. A readable combined intent/roster approval satisfies that gate when it
includes those commitments. An approval covers its stated scope, not the whole pool.

Corrections, retries and re-verification by the same approved owner on the same
outcome keep that approval. A new outcome, a materially changed roster or a higher
restricted-model effort needs the relevant confirmation. Other models have no
model-specific gate; team formation, write boundaries and delivery
permissions still apply, and a subagent does not bypass any approval.

## Advice and independent verification

Advice is a bounded question whose answer can change the owner's next action; any
relevant approved model can give it. The owner keeps the outcome and integrates the
evidence. Judge advice by what it changed, not by a call count. If the adviser keeps
having to reconstruct and direct the whole outcome, weigh continuing, revising the
brief, making the adviser the owner or stopping that approach, handoff cost included.

Independent verification needs a fresh session reading the authoritative artifacts
and acceptance criteria, not the builder's reasoning or desired verdict. The reviewer
is chosen in the default allocation above. The actual builder
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
