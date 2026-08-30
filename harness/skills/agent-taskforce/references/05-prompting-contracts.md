# Team prompting contracts

*Lead.* What to put in a spawn prompt, and how to staff a role.

`claude-prompting-lab` is canonical for prompt structure, altitude, effort selection, and general model guidance. This file holds only what a *team* adds.

## What a team spawn prompt adds

Beyond role, objective, scope, verification, and output, a teammate needs:

- **Authority** — what they decide alone, what requires a peer, lead, or human, and the FRAME_CONFLICT boundary when an active frame exists.
- **Coordination** — named peers, interfaces, file ownership, dependencies, handoffs, and shared runtime resources.
- **A budget** — the effort or scope growth at which the owner returns even though nothing is blocked. Escalation triggers written only as impossibilities (needs a dependency, breaks compatibility, requires a rewrite) leave a tenacious owner no reason to stop when the surface is merely far larger than assumed.

A teammate never receives the lead's conversation history. Any fact that exists only there is lost unless it reaches the brief. Tag unverified premises `[inherited]` or `[assumed]`; see `templates/task-brief.md`.

Be precise about outcome, boundary, authority, and evidence. Leave the order of attack to the owner. A brief's sentences carry two forces, decided by content kind rather than tone or tags: outcome, done evidence, write ownership/off-limits, budget, and constraints with a named authority source bind; repository coordinates, call paths, and causal claims are provisional leads the owner verifies against code, tests, and runtime, and may overrule. A mechanism prohibition without an authority source is a lead-invented quality concern — state it as an observable instead. The `dispatching` and `dispatched` skills are canonical for the full composition and reading contracts. For repository content, give the path. For a short task, compress the same contract into a few lines.

## Staffing a role

A role requires a capability profile, not a permanent model name. The human chooses the lead model; the lead proposes workstream models and waits for approval. Skill(model-guide) contains the current soft roster and the bottleneck-based selection guide; `references/08-model-allocation.md` holds only the team proposal format.

| Role | What it must have |
|---|---|
| Lead | enough context and judgment to preserve the mission while evidence changes the plan |
| Workstream owner | the capability that matches the dominant bottleneck, plus stamina to carry the outcome end to end |
| Independent verifier | a fresh context and, when available, a different model from the owner it judges |
| Fresh reviewer | a separate session that inherited none of the run's narrative |

If the same model must review its own model family's work, call it a **fresh review**, not an independent verifier, and disclose that limitation in the roster proposal. Never let a model independently verify a workstream it personally implemented.

Model substitution is normal when quotas, outages, or runtime constraints intervene. Propose any material substitution and wait for user approval before spawning it; preserve the approved responsibility boundary and record what actually ran in the mission. Recreating the same approved teammate after session loss is recovery, not a new model decision.

Claude Code teammates inherit the lead's model unless the spawn prompt names one or `CLAUDE_CODE_SUBAGENT_MODEL` supplies one. Confirm and record the actual model.

**Confirm where a role's model actually lands before you trust it as independent.** A routing layer between the CLI and the provider can resolve the same model name somewhere else, and then a verifier that looks independent shares the owners' weights. Do not infer this from a catalog name — send one call and read the failure: quota and auth errors name the account you actually hit.

## Avoid the overgrown manager prompt

Do not stuff the lead or teammates with every edge case and if-else. The operating model already carries the division of labor. Add a new rule, agent type, hook, or checklist only after a real recurring failure shows that the lighter contract is insufficient.
