---
name: model-guide
description: "서브에이전트·팀원·검증자 모델을 고를 때 읽는 라우팅 가이드. 일회성 task Agent 하나를 띄울 때도, 팀 로스터를 짤 때도 — Agent 모델을 결정하는 모든 순간에 적용."
---

# Model Guide

Choose an Agent's model by the work's dominant bottleneck, not by phase labels or permanent job titles. This guide has two layers: cognitive profiles that are durable across model generations, and an operational note pinned to a date that you replace when the catalog changes.

Evidence base: `/Users/wy/Github-repos/rubato-lab/research/2026-08-20-model-cognition-column.md` — read it when revising this skill, not during a run.

## 1. Preserve outcome ownership

An owner keeps a bounded outcome through investigation, implementation, retries, and local verification.

- The model that proves a root cause normally patches it too.
- Do not hand work from an investigator to a builder merely because the phase changed from diagnosis to implementation.
- Hand off only when the remaining work is a clean, substantial outcome that can be specified without the original investigation context, and the new model's advantage outweighs rereading and translation cost.
- For large repetitive rollout after a difficult diagnosis, prefer delegation under the original owner. Transfer full ownership only when the rollout is genuinely independent.

## 2. Cognitive profiles (durable)

Frontier models are not one IQ ladder; they differ in which kind of uncertainty they handle well.

| Profile | Core loop | Strongest at | Characteristic failure |
|---|---|---|---|
| **Problem framer / human modeler** | keeps ambiguity open, models the person behind the request | UX, strategy, writing, co-defining what should be built | over-expansion, grand theories |
| **Structurer / integrator** | orients in unfamiliar environments, decomposes and integrates long work | architecture, workstream boundaries, final integration | technical elegance overriding human purpose |
| **Hypothesis converger** | problem → hypothesis → evidence → refutation → narrower hypothesis | root cause, invariants, algorithms, performance, verification | premature convergence on a wrong framing, then optimizing inside it |
| **Action converger** | goal → act → observe → fix → act → done | settled changes rolled across many files, tools, prototypes | weak at discovering goals or reframing the problem |

Route by asking: **what part is hardest to get right?**

| Dominant bottleneck | Owner profile |
|---|---|
| Understanding people, product value, or what should be built | problem framer — usually a framing step or human dialogue, not a standing teammate |
| Cross-stream architecture, contracts, integration | structurer — often the lead itself |
| Discovering and proving the correct technical change | the outcome's current owner — diagnosis is judgment, not a delegable phase (see the debugging note) |
| Executing a settled change across tools, files, runtime | action converger — a worker the owner dispatches |
| Falsifying a material implementation | fresh verifier with a *different* profile from the writer |

Two convergers are not interchangeable: a hypothesis converger compresses the answer space, an action converger compresses the action space. A patch built by an action converger is well checked by a hypothesis converger — their failure modes rarely overlap. Neither substitutes for a framer when the variables of the problem are themselves undecided.

Debugging is the case that tempts misrouting. The diagnosis is judgment, and judgment stays with the session that owns the outcome — lead and teammate alike. Default shape: a `grok` explorer maps the terrain and gathers evidence, the owner reasons to the root cause, and execution of the settled fix routes by breadth as usual. Hand a debugging workstream to an Agent only when it is genuinely separable and runs parallel to other work; review it with the other model family.

## 3. Current catalog mapping (operational — verify against the live catalog)

Pinned 2026-08-29. Names are replaceable mappings, not universal claims.

Resolve the model at spawn time, in this order:

1. Determine the main session's current model then, not the model it started with; it may have changed during the session.
2. Choose the cognitive profile and, for an independent verifier, a different model family from the artifact's producer.
3. Read the live catalog and copy the exact model id from it. Never reuse an id from memory or from an earlier lookup in the same session: catalog ids age faster than conversational context.
4. A catalog entry proves only that the model is listed. Send one real call and require a successful response before relying on it.
5. For a `task` agent using **Sol or Opus**, probe the equivalent `kiro/*` model first. This Kiro preference applies only to Sol and Opus. For **Grok**, prefer Cursor Fast over xAI. If the preferred route answers, use it to conserve other providers' quota; fall back only when it is unavailable or fails the probe.
6. For a `task` spawn, pass only `prompt` and `model: "<live-catalog-id>"` as the target. Do not add a category or subagent persona: those are preset compatibility paths, while an exact model already fully selects the Agent. Team rosters expose categories rather than model ids, so these provider preferences apply where the rail permits an exact model choice.

Say in one line which model the agent runs on.

**Default worker is Grok 4.6 Fast.** An owner dispatches it for settled execution across files and tools (`task`). Pick Sol or Opus as an Agent only when one of the exceptions below applies — not because the work looks important or has a diagnosis step.

- **Fable 5** — problem framer. Optional framing and human-outcome review before execution or at a rare alignment gate; do not create a standing Fable teammate by default.
- **Opus 5** — structurer. Default **lead** and default **owner**. Spawn as an Agent only when the dominant bottleneck is cross-stream architecture, contracts, or integration.
- **GPT-5.6 Sol** — hypothesis converger. Default **verifier**, and the supervisor when the owner is stuck. Give Sol ownership only when the proof itself is the deliverable.
- **Grok 4.6 Fast** — action converger. **Default worker** an owner dispatches. Prefer the Cursor Fast id from the live catalog (`cursor/cursor-grok-4.6` on rubato; picker label `grok-4.6-fast`). Fall back to xAI `xai/grok-4.6` only when Cursor Fast is missing or the probe fails. A `task` Agent.

Verifier defaults when an independent check is worth the cost:

- Claude-family main session → Sol verifier
- Codex-family main session → fresh Opus verifier

Defaults, not mandatory pairings. A clear low-risk task may use owner self-verification only.

## 4. Minimal shapes

- One bounded technical outcome → one owner. That owner dispatches Grok Fast workers for settled execution.
- One material or ambiguous outcome → owner + verifier.
- Two genuinely independent outcomes → two owners; verifier only if integration risk warrants.
- Unclear root cause → the owner diagnoses from a `grok` map; only a genuinely separable, parallel debugging workstream gets an Agent owner, and that owner is Opus.
- Product or UX uncertainty → framing before execution, then the chosen owners.

Do not build a four-model org chart just because all models are available.

## Scope

This skill owns model-to-work routing only. Team governance — roster approval, mission, contracts, completion — belongs to Skill(agent-taskforce). Brief-writing belongs to Skill(dispatching). Prompt structure and effort selection belong to claude-prompting-lab.
