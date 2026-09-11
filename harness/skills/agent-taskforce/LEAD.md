# Lead

Run the team like a small company. Protect the goal and cross-workstream decisions; let each owner keep a bounded outcome through investigation, implementation, local debugging, and local verification. Add structure only when it buys clearer ownership or better evidence.

This skill covers choosing and running a *team*. General prompting, effort selection, and context design belong to `claude-prompting-lab`; product-value framing belongs to `product-framing`; runtime commands belong to the runtime guides. (`references/07-source-map.md` is for revising the skill, not ordinary runs.)

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

1. Whether this run uses `/product-framing`, an existing active frame, or no framing step.
2. Which model leads.

If the operator already chose them, preserve those choices. If either is missing and materially affects the run, investigate what can be established and include one recommendation in the combined intent/roster proposal before staffing. Do not silently invoke framing or replace the lead model.

- **Framing selected**: run or link the framing process before irreversible implementation. An active `FRAME_LOCK` remains the canonical source for product value, users, and outcome invariants.
- **Framing skipped**: use the user's directive, settled spec, ADR, or other named authority. Do not recreate a miniature framing process inside the team skill.
- **Pure execution work**: clear bugs, refactors, migrations, infrastructure work, and settled specs need no new product framing. Reuse their existing authority; keep durable intent and execution state only when continuity needs them.

`references/04-framing-bridge.md` covers active-frame authority and conflicts. It offers recommendation signals, not permission to override the operator's choice.

## Resolve intent before staffing

Read the sibling `work-intent` skill and its alignment guide. Reuse the authority for
this outcome; a new team or worktree is not a new intent. Inspect the relevant repository,
documents and available external sources to resolve discoverable gaps. Keep uncertain
findings provisional. Decide local methods yourself and recommend the best-supported
direction; material user choices belong in the combined proposal, not a rolling interview.
Stop discovery once enough is known to choose direction and ownership. A bounded discovery
helper may work under a draft within existing permissions; continuing owners may not.

Draft only when no existing source serves the purpose. Show the result, preserved behavior,
non-goals and completion evidence in the user's language together with the roster, then
wait for explicit confirmation of both intent and roster. Cite the actual human instruction
accepting that proposal, not a generic earlier request or silence. Refer to the proposal
and accepted intent revision in the existing mission; do not copy the roster into intent.
Follow `work-intent` for partial approval, accepted corrections and changed-scope decisions.

Keep frame/spec authority and local owner autonomy intact. Carry the exact `intent_ref`
and canonical workspace in briefs and task metadata. Run-specific staffing, approval
references and integration belong in mission. Intent acceptance does not replace any
independent model, frame, budget or delivery permission.

## 3. Confirm intent and roster together, then form the team

Read the active runtime adapter and Skill(model-guide), preserve the chosen lead and
framing, and design the smallest useful roster from the discovery evidence. Use the
sibling `work-intent/templates/approval-message.md` for a readable combined proposal.
Name each model and its responsibility, with supported effort when material, but translate
internal role names and mechanisms into their practical effect for this user.

Present one combined proposal and wait for explicit confirmation of both intent and roster
before spawning continuing owners. The confirmation may approve the named recommendation
and team together. Generic earlier requests, silence or approval of only one part do not
complete this gate. The same human reply can satisfy model/budget approval when those exact
commitments were clearly presented and are within that human's authority; it grants no
unpresented external action or delivery permission.

Keep approved owners through corrections and re-verification without asking again.
Recreating the same lost teammate with the same boundary/model/effort is recovery, not a
new proposal. Material restaffing, scope or cost changes get a concise delta proposal and
confirmation before affected work. Bounded discovery helpers and ordinary helpers inside
approved authority need no new team ceremony; they are not a workaround for this gate.

## 4. Build the smallest valid team

Start from one `workstream-owner`, not from a standing org chart.

- Add another owner only for a genuinely independent outcome.
- Add an `independent-verifier` only when blast radius, ambiguity, integration risk, or completion cost makes an independent check worth its context and tokens.
- Two owners plus one verifier is a useful shape for complex cross-layer delivery, not a default for every task.
- Retire roles when the phase or workstream ends.

Roles are responsibility contracts, not permanent model identities. Each owner keeps its bounded outcome end to end within the authorized task type; whether a follow-up task continues an existing session or starts fresh follows Skill(dispatching), and model choice follows the active runtime's policy above. `references/08-model-allocation.md` keeps only the team-specific proposal format.

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

Before spawn, present intent and roster in one readable proposal and obtain combined confirmation. During and after the run, translate internal jargon into the user's language and show only:

- results that changed or facts that were confirmed
- verification evidence and failed checks
- significant decisions or remaining gaps
- any material restaffing from the reported roster

## Accept against the intent

Before final acceptance, reread the current intent and any linked acceptance
criteria. Compare actual artifacts and delivery with that revision, not only board
completion. On a material intent change, pause affected work, record the decision
and refresh all affected owners' references; keep older evidence tied to its old
revision. Fulfill the intent only when accepted evidence supports it. Update existing
permanent documentation instead of creating another final summary. Keep historical
intent records separate from current-system documentation.
