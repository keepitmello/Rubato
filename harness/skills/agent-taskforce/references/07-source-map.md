# Official source map

*Skill revision.* Not read during a run.

Read this when revising the skill, not when running a team. Source snapshot: 2026-08-05. For general Claude 5 prompting, the user's `claude-prompting-lab` is canonical. This file lists only what team and harness design rest on beyond it.

Before adopting any revision, check the candidate against `references/09-regression-scenarios.md`. Every scenario there is a promised behavior, most promoted from a real incident — a revision that silently drops one is itself the incident class that list exists to catch.

## Claude Code

- Agent Teams: https://code.claude.com/docs/en/agent-teams
  - independent context, direct messaging, shared tasks, team sizing, task sizing, plan approval, hooks, file conflicts, current limitations, display-mode constraints including the current Ghostty limitation.
- Best practices: https://code.claude.com/docs/en/best-practices
  - fresh adversarial review, completion evidence, context pollution, over-specified instruction avoidance.
- Agent Skills: https://code.claude.com/docs/en/skills
  - progressive disclosure and on-demand workflow instructions.
- Subagents: https://code.claude.com/docs/en/sub-agents
  - reusable agent definitions; custom subagent types can also be referenced when spawning Agent Team teammates, with their body appended as teammate instructions.

## fx

- Upstream: https://github.com/vercel-labs/fx — persistent subagents with per-child model, effort, permission mode, and state.
- Team Overlay: our fork `keepitmello/fx`, branch `feat/team-overlay`. Membership is derived from the canonical child tree rather than stored; peers message through `team.message` on the same queue the subagent path uses; a peer message aimed at the lead raises the existing attention notification instead of resuming the lead.
- Design records, rejected alternatives, and unverified findings: the private `Rubato-lab` repo under `case-studies/harness/`.

## Anthropic engineering

- How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
  - dynamic path-dependent work, 3-5 parallel workers, heuristics over rigid rules, artifact handoffs, high token cost, outcome-based evaluation.
- Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - finite attention budget, smallest high-signal context, right-altitude prompts.
- Harness design for long-running application development: https://www.anthropic.com/engineering/harness-design-long-running-apps
  - planner/generator/evaluator separation, structured handoffs, optional verification contracts, evaluator overhead boundary.
- Building a C compiler with a team of parallel Claudes: https://www.anthropic.com/engineering/building-c-compiler
  - high-quality tests, concise feedback, parallelizable task design, specialization limits, extreme cost example.
- Equipping agents for the real world with Agent Skills: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
  - skills as composable onboarding and progressive disclosure.
- Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - final-state and transcript graders, capability vs regression evals, repeated task banks.
- Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
  - simple composable patterns before complex frameworks.

## Local roster policy

Skill(model-guide) owns model selection from authorized resources, supported settings and relevant observations. Skill(dispatching) owns session continuity. `references/08-model-allocation.md` connects those choices to the team proposal without creating another approval gate. Model families are not permanent job titles; preserve the user's lead selection independently of execution allocation.


## Local prompt-design basis

This revision also follows the attached `claude-prompting-lab`: keep always-loaded instructions small, state outcomes and authority affirmatively, choose orchestration before polishing wording, use progressive disclosure, and add permanent rules only after observed failures.

## Accepted Pi revision, 2026-09-16

The operator approved revising the Pi system prompts, taskforce and related skills
after distinguishing user-facing leadership from execution. The lead's primary
work is the continuing conversation and framing with the user. Owners retain
whole outcomes and technical integration; verifiers retain independent evidence
and verdicts. Acceptance uses that evidence without a duplicate lead execution pass.

This is a local design decision, not a claim that a paper proved one universal
topology. Earlier discussion of Fable/Astra economics does not establish a local
subscription-cost coefficient or a guarantee that single-agent work always wins.
Use live-task evidence to evaluate those hypotheses.

Preserve historical scenario IDs in `09-regression-scenarios.md`; explicitly revise
only expectations this decision supersedes. Static prompt/assembly tests and the
live cases in `harness/prompts/evals/rail-choice.yaml` test different things.
The Codex operating edition is outside this revision. Do not regenerate it.
