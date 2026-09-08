---
name: model-guide
description: "Choose owner, worker and verifier models from selected providers and native capabilities. Fable and Astra require explicit task-and-effort approval."
---

# Model guide

The user chooses the lead; never change it automatically. Roles describe
responsibility, not fixed models. Read `../dispatching/SKILL.md` to decide
continuation versus a new agent before selecting a model.

## Route by the hardest part

An owner retains judgment, diagnosis, implementation, correction and proof for
one outcome. Workers take bounded maps, evidence gathering and settled execution.
Do not delegate unresolved judgment to a cheap worker merely to fit a budget.

| Seat | Selected external providers available | Native Codex only |
|---|---|---|
| Owner | Fable for framing/structure; Sol for technical diagnosis/proof; Opus for broad judgment; Grok for already-framed outcomes | Sol |
| Exceptional owner | Astra for a particularly difficult outcome, after approval | Astra only if explicitly requested and approved outside the default pool |
| Worker | Available fast worker (for example Gemini Flash), or Grok for precise bounded execution | Terra for execution; Luna for simple maps/extraction |
| Verifier | A fresh capable context, preferably a different family from the producer | Fresh Sol context |

Terra and Luna never hold owner seats. Opus and Grok are permitted owners, not
mandatory replacements for Fable or Sol. Match the work, not a permanent job
title. Cognitive profiles are routing heuristics, not measured performance or
price claims: framing keeps the problem open, structure integrates work,
hypothesis convergence tests explanations, action convergence executes settled
steps. Keep diagnosis with the owner when the explanation is still uncertain.

## Two separate approval boundaries

- Before forming a team, present outcome/role/model/effort and obtain roster
  confirmation as required by `../agent-taskforce/LEAD.md`.
- Fable (every provider/version) and Astra require explicit approval naming the
  task and effort before assignment, including owner, worker and verifier seats.
  A roster approval satisfies this only if those details were included.
- Opus, Sol and Grok do not need an additional model-specific approval. Neither
  do ordinary Terra/Luna/fast workers inside the approved outcome and team scope.
- An approved owner's corrections, retries and verification of the same outcome
  continue under that approval. A new outcome or higher effort on a restricted
  model needs renewed approval. Another task's approval is not reusable.
- Default owner/verifier effort is medium when supported. Choose worker effort
  from actual supported values and task uncertainty, not a universal maximum.
  Preserve explicit effort, including Sol/medium, until the user changes it.

## Resolve locally, then check the native surface

Read `$CODEX_HOME/rubato-codex/providers.json` (default
`~/.codex/rubato-codex/providers.json`). Missing policy or an empty
`selectedProviders` means the native-only column. `availableProviders` is
discovery metadata, not authorization: external choices must belong to
`selectedProviders`. A malformed policy is a routing blocker, not permission to
enable every provider. This is an operating policy, not proxy access control;
the installer does not disable providers shared by other OpenCodex clients.

Use exact model IDs from the current native spawn tool. Intersect its choices
with selected providers and the locally discovered OpenCodex model catalog.
Registration, authentication and actual agent-call availability are different
checks. An app picker entry alone is insufficient. If a selected model cannot
be spawned, report that limitation; do not bypass native execution with another
runner or silently substitute a provider.

Native IDs such as `gpt-5.6-sol` do not use Rubato's `openai-codex/` prefix.
External IDs retain their actual provider prefix: `xai/grok-4.6` and
`cursor/grok-4.6` use different routes/accounts. Resolve Fable/Opus/Gemini against
the live catalog rather than assuming Rubato aliases or versions are identical.
Never infer a Fast endpoint from a model name or manufacture supported effort.

For explicit spawn overrides use a self-contained brief and a supported finite
history fork; full-history forks may reject overrides. Native follow-up may not
support changing model/effort; do not invent a parameter. Keep the owner unless
the user's change actually requires migration. Report requested settings
separately from runtime-confirmed model identity. A fresh GPT context is an
independent review, not cross-family verification.
