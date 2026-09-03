---
name: model-guide
description: "Routing guide for choosing Agent, teammate, and verifier models. Applies whenever an Agent model is decided, one-off or full roster."
---

# Model Guide

Choose an Agent's model by the work's dominant bottleneck. Treat phase labels and permanent job titles as context around that choice. This guide has two layers: cognitive profiles that are durable across model generations, and an operational note pinned to a date that you replace when the catalog changes.

Evidence base: `/Users/wy/Github-repos/rubato-lab/research/2026-08-20-model-cognition-column.md` — use it while revising this skill; normal runs use the mapping below.

## 1. Preserve outcome ownership

An owner keeps a bounded outcome through investigation, implementation, retries, and local verification.

- The model that proves a root cause normally patches it too.
- Keep the same owner from diagnosis through implementation when the outcome remains the same.
- Hand off only when the remaining work is a clean, substantial outcome that can be specified without the original investigation context, and the new model's advantage outweighs rereading and translation cost.
- For large repetitive rollout after a difficult diagnosis, prefer delegation under the original owner. Transfer full ownership only when the rollout is genuinely independent.

## 2. Cognitive profiles (durable)

Frontier models specialize in different kinds of uncertainty.

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
| Cross-stream architecture, contracts, integration | structurer — usually the lead itself (the lead is whatever main session the user opened; this guide does not pick it) |
| Discovering and proving the correct technical change | the outcome's current owner — diagnosis is judgment, not a delegable phase (see the debugging note) |
| Executing a settled change across tools, files, runtime | action converger — a worker the owner dispatches |
| Falsifying a material implementation | fresh verifier with a *different* profile from the writer |

Two convergers are not interchangeable: a hypothesis converger compresses the answer space, an action converger compresses the action space. A patch built by an action converger is well checked by a hypothesis converger — their failure modes rarely overlap. Neither substitutes for a framer when the variables of the problem are themselves undecided.

Debugging is the case that tempts misrouting. The diagnosis is judgment, and judgment stays with the session that owns the outcome — lead and teammate alike. Default shape: a `grok` explorer maps the terrain and gathers evidence, the owner reasons to the root cause, and execution of the settled fix routes by breadth as usual. Hand a debugging workstream to an Agent only when it is genuinely separable and runs parallel to other work; review it with the other model family.

## 3. Exact model or named preset

Choose the cognitive profile, then pass an exact `model` or named `preset` to `Agent`. Never pass a category, task type, or `subagent_type`. Omit `effort` for Grok. Always pass `effort` for Fable 5.1 and Sol: Fable as a worker runs `low`; Sol runs `medium`; anything higher only after the user confirms it for that dispatch.

Route in this order:

1. Determine the main session's current model family then, not the family it started with; it may have changed during the session.
2. Choose the cognitive profile and, for an independent verifier, a different model family from the artifact's producer.
3. Pass an exact `model` (`provider/model`) or named `preset`. The harness resolves a named `preset` against the live catalog, admits it, and carries the runtime fallback chain.
4. Use an exact `model` when provider/model identity itself is a requirement.

Say in one line which model or preset the agent runs on; report the resolved model when the runtime returns it.

**Default owner and default worker is Grok 4.6 Fast**, for every workstream including diagnosis and integration. When xAI direct is out of credits, use `cursor/cursor-grok-4.6`. Opus 5 has no slot.

**Fable 5.1 and Sol as owners or workers require the user's approval per dispatch.** Ask, naming the workstream; until approved it runs on Grok. A verifier (independent review) needs no approval.

The choice is made once, at dispatch. An owner that hits a bottleneck mid-work is not swapped for a stronger model; it reports, and the lead decides the next leg. So predict the bottleneck up front rather than planning to climb later.

- **Fable 5.1** — problem framer and structurer. As an Agent: framing, human-outcome review, cross-stream architecture, contracts, and integration. `effort: low` as a worker; higher with the user's confirmation.
- **GPT-5.6 Sol** — hypothesis converger. Default **verifier**, and the supervisor when the owner is stuck. Give Sol ownership only when the proof itself is the deliverable. `effort: medium` by default; `high` with the user's confirmation.
- **Grok 4.6 Fast** — action converger. Default **owner** and default **worker**, passed as an exact Grok model or the matching named preset.

Verifier defaults when an independent check is worth the cost:

- Claude-family main session → Sol verifier
- Codex-family main session → fresh Fable 5.1 verifier (`effort: medium`)

Defaults, not mandatory pairings. A clear low-risk task may use owner self-verification only.

## 4. Minimal shapes

- One bounded technical outcome → one owner. That owner dispatches Grok Fast workers for settled execution.
- One material or ambiguous outcome → owner + verifier.
- Two genuinely independent outcomes → two owners; verifier only if integration risk warrants.
- Unclear root cause → the owner diagnoses from a `grok` map; only a genuinely separable, parallel debugging workstream gets an Agent owner. That owner is Grok.
- Product or UX uncertainty → framing before execution, then the chosen owners.

Build the smallest roster that gives each distinct bottleneck one clear owner.

## Scope

This skill owns model-to-work routing only. Team governance — roster approval, mission, contracts, completion — belongs to Skill(agent-taskforce). Brief-writing belongs to Skill(dispatching). Prompt structure and effort selection belong to claude-prompting-lab.
