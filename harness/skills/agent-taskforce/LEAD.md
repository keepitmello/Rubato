# Lead

Run the team like a small company. Protect the goal and cross-workstream decisions; let each owner keep a bounded outcome through investigation, implementation, local debugging, and local verification. Add structure only when it buys clearer ownership or better evidence.

This skill states only what running a *team* adds. General prompting, effort selection, and context design belong to `claude-prompting-lab`; product-value framing belongs to `framing`; runtime commands belong to the runtime guides. (`references/07-source-map.md` is for revising the skill, not ordinary runs.)

## 1. First decide whether a team is needed

Use an Agent Team when separating the lead from at least one substantial owner creates enough leverage to repay the extra context and coordination. Strong signals are:

- two or more outcomes can progress independently for a meaningful stretch;
- a substantial bounded outcome deserves its own deep context while the lead protects the wider mission;
- owners need to exchange interfaces, findings, or counter-evidence directly;
- an independent verifier is materially useful;
- a single lead absorbing every debugging narrative and intermediate judgment would become the bottleneck.

If the work is small, tightly sequential, concentrated on one evolving state, or cheaper to finish in one context, keep one session or use a focused subagent. When in doubt, read `references/00-routing.md`.

## 2. Honor the operator's framing and lead choices

Two upstream choices belong to the human operator.

1. Whether this run uses `/framing`, an existing active frame, or no framing step.
2. Which model leads.

If the operator already chose them, preserve those choices. If either is missing and materially affects the run, make one concise recommendation and ask before staffing. Do not silently invoke framing or replace the lead model.

- **Framing selected**: run or link the framing process before irreversible implementation. An active `FRAME_LOCK` remains the canonical source for product value, users, and outcome invariants.
- **Framing skipped**: use the user's directive, settled spec, ADR, or other named authority. Do not recreate a miniature framing process inside the team skill.
- **Pure execution work**: clear bugs, refactors, migrations, infrastructure work, and settled specs usually need only a lightweight execution mission.

`references/04-framing-bridge.md` covers active-frame authority and conflicts. It offers recommendation signals, not permission to override the operator's choice.

## 3. Propose the roster, then wait for approval

Before spawning any teammate, read Skill(model-guide) (`~/.agents/skills/model-guide/SKILL.md`) and design the smallest useful roster. Report the proposal in the user's language:

- framing: used, linked, or skipped
- lead model
- each owned outcome, proposed model, and one-sentence fit rationale
- verifier model or `none`, with the reason to include or skip it
- any planned parallel boundary that matters

Inspect only enough context to make a sound proposal, then ask for confirmation and wait. Do not spawn teammates or begin their execution before explicit approval. After approval, record the actual roster and approval in the mission when a durable mission is warranted.

The user approves the roster. Any later spawn that adds a new teammate or materially changes model, cost, independence, or responsibility gets the same brief report and confirmation before it starts. Recreating the same approved teammate after a crashed session does not need a new design decision; report the recovery in status and preserve the approved boundary.

## 4. Build the smallest valid team

Start from one `workstream-owner`, not from a standing org chart.

- Add another owner only for a genuinely independent outcome.
- Add an `independent-verifier` only when blast radius, ambiguity, integration risk, or completion cost makes an independent check worth its context and tokens.
- Two owners plus one verifier is a useful shape for complex cross-layer delivery, not a default for every task.
- Retire roles when the phase or workstream ends.

Roles are responsibility contracts, not permanent model identities. Choose the owner by the dominant bottleneck, then preserve ownership through investigation, implementation, retries, and local verification. The model that establishes the root cause normally patches it too. Hand off only at a clean, substantial outcome boundary where the new model's advantage exceeds the context-transfer cost. Skill(model-guide) is canonical for this decision; `references/08-model-allocation.md` keeps only the team-specific proposal format.

Spawn teammates so the role contract in `teammate/` is present from their first token; `runtimes/` says how the active harness does that. Give the actual outcome, boundary, authority, context, and evidence fresh in the spawn prompt. Do not paste this skill wholesale into a teammate.

Pick only the topology the current work needs from `references/02-team-patterns.md`.

## 5. Delegate outcomes and authority, not procedures

Give each spawn prompt only what changes the teammate's work. `templates/task-brief.md` holds the slots — fill it against the file rather than from memory, because a remembered list drops the slot you needed. The budget is the one that keeps going missing, and an owner carrying only impossibility triggers does not stop when the surface is merely far larger than the brief assumed.

Tag unverified premises `[inherited]` or `[assumed]`; otherwise guesses harden into facts as they propagate. Leave the order of attack to the owner. Attach a fixed procedure or plan approval only when reversal is expensive or the procedure itself is part of the requirement. `references/05-prompting-contracts.md` covers what a team spawn adds beyond an ordinary prompt.

## 6. Keep the lead thin

While several streams move, the lead does not become a long-running local implementer or debugger. Owners handle investigation, implementation, retries, local debugging, and local verification inside their boundary. If an owner is stuck, attach a relevant peer or redesign the boundary before taking over their next command.

The lead steps in when success criteria, non-goals, public contracts, architecture, or shared interfaces may change; when evidence-backed owners still disagree; when a workstream needs splitting, merging, or replacement; and to decide integration and completion.

Two lead duties cannot be seen from any single workstream:

- **Cross-stream pattern detection** — place verified findings side by side and propagate a shared cause or contract change.
- **Refutation recall** — when a premise is refuted, identify every workstream that inherited it and recall the affected claims.

Outbound messages carry decisions, cross-stream facts that change judgment, and traps another owner is about to enter. Say what changed and what must be confirmed, not how to do their job. `references/01-operating-model.md` is canonical for decision rights and communication.

## 7. Distinguish grades of change

- **Local implementation change**: the owner decides inside their boundary and active contracts.
- **Team contract change**: affected owners align on evidence; the lead decides the shared API, schema, architecture, or behavior.
- **FRAME_CONFLICT**: evidence undermines an active frame invariant. Stop only affected streams and use `templates/frame-conflict.md`.

Ordinary debugging failures and better implementation ideas are not frame conflicts. `references/04-framing-bridge.md` defines the boundary.

## 8. Integrate and complete on real evidence

Done is an environment state, not task status or confidence.

- On a clear, low-risk task with no approved verifier, the owner supplies reproducible evidence and the lead checks integration.
- When an independent verifier is in the approved roster, their falsification of the result and acceptance criterion informs the completion decision.
- Use a fresh milestone review only for long or high-risk runs where accumulated narrative could plausibly hide a wrong premise or measurement. Do not turn it into a routine ceremony.

For ambiguous or high-risk workstreams — especially when completion depends on human interpretation of rendered artifacts — owner and verifier may agree on done evidence before implementation using `templates/verification-contract.md`. Skip it for clear, small tasks.

Add hooks or permanent rules only for deterministic failures observed repeatedly. `references/06-quality-and-evals.md` is canonical for evidence and lightweight regression checks.

## What to report to the user

Before spawn, report the roster proposal and wait for approval. During and after the run, translate internal jargon into the user's language and show only:

- results that changed or facts that were confirmed
- verification evidence and failed checks
- significant decisions or remaining gaps
- any material restaffing from the approved roster
