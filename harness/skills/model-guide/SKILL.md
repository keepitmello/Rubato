---
name: model-guide
description: "Routing guide for Agent, teammate, and verifier models. Fable/Astra are ultra-expensive: explicit user approval is mandatory for every dispatch, including verification."
---

# Model Guide

Choose an Agent's model by the work's dominant bottleneck. Treat phase labels and permanent job titles as context around that choice. This guide has two layers: cognitive profiles that are durable across model generations, and an operational note pinned to a date that you replace when the catalog changes.

Evidence base: `/Users/wy/Github-repos/rubato-lab/research/2026-08-20-model-cognition-column.md` — use it while revising this skill; normal runs use the mapping below.

Whether to reuse an existing agent or start a new one is decided in Skill(dispatching), before this guide. Come here once you know you need a new agent and have to pick its model.

## 1. Cognitive profiles (durable)

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

Debugging is the case that tempts misrouting. The diagnosis is judgment, and judgment stays with the session that owns the outcome — lead and teammate alike. Default shape: a worker maps the terrain and gathers evidence, the owner reasons to the root cause, and execution of the settled fix routes by breadth as usual. Hand a debugging workstream to an Agent only when it is genuinely separable and runs parallel to other work; review it with the other model family.

## 2. Exact model or named preset

Choose the cognitive profile, then pass an exact `model` or named `preset` to `Agent`. Never pass a category, task type, or `subagent_type`.

Pass `effort` with the model:

- **Muse** — omit `effort`.
- **Grok** — pass `effort`. Default `high`; `xhigh` when the leg looks hard.
- **Fable 5.1, Sol, and Astra** — default `medium`; `high` when the work looks hard. The model and the effort both need approval.

Route in this order:

1. Determine the main session's current model family then, not the family it started with; it may have changed during the session.
2. Choose the cognitive profile and, for an independent verifier, a different model family from the artifact's producer.
3. Pass an exact `model` (`provider/model`) or named `preset`. The harness resolves a named `preset` against the live catalog, admits it, and carries the runtime fallback chain.
4. Use an exact `model` when provider/model identity itself is a requirement.

Say in one line which model or preset the agent runs on; report the resolved model when the runtime returns it.

**Owner seat** is Fable 5.1 or Sol, by bottleneck — Fable for framing and structure, Sol for hypothesis and proof. Both, and Astra, need the user's approval per dispatch.

**Grok may hold that seat** when the outcome is already framed and the work is clear: `xai/grok-4.6` or Cursor Fast (`cursor/cursor-grok-4.6-high-fast`) — use either. Grok is an action converger; it can own a bounded, already-framed technical outcome. If the bottleneck is judgment — diagnosis, framing, architecture, or what should be built — Grok as owner is itself a bottleneck. Ask for Fable or Sol; until approved, keep that judgment in the current session instead of spawning a Grok owner.

**Default worker** is Muse Spark or Grok 4.6 Fast: `opencode/muse-spark-1.3-contributor-free`, or the same Grok ids. Muse runs several times faster at slightly lower accuracy; prefer it as a worker, and use Grok when a leg needs the extra precision. Opus 5 has no slot.

**Fable (including Fable 5.1) and Astra are ultra-expensive and require the user's explicit approval for every dispatch, in every role — owner, worker, or independent verifier.** Before spawning, name the model, effort, and task and obtain approval. A clear owner seat may run on Grok without that approval; a judgment seat may not. A verifier role, routing default, fallback, or previous approval for a different task is NOT permission. Approval is scoped to the specified task and effort, not blanket permission for later spawns or new tasks in a resumed agent.

Sol as an owner or worker also requires the user's approval per dispatch.

Choose the profile at dispatch and predict the dominant bottleneck up front rather than planning to climb later. A stronger model existing is not by itself a reason for a new session; whether the next leg continues or starts fresh belongs to Skill(dispatching).

- **Fable 5.1** — problem framer and structurer. As an Agent: framing, human-outcome review, cross-stream architecture, contracts, and integration. `effort: medium` by default; `high` when the work looks hard, with the user's confirmation.
- **GPT-5.6 Sol** — hypothesis converger. Default **verifier**, and the supervisor when the owner is stuck. Give Sol ownership when the proof itself is the deliverable. `effort: medium` by default; `high` when the work looks hard, with the user's confirmation.
- **Astra** — same effort and approval rule as Fable and Sol: `medium` by default; `high` when the work looks hard, only after approval for that model and effort.
- **Grok 4.6 Fast** — action converger. Default **worker**, and the owner stand-in for already-clear work. Pass `xai/grok-4.6` or Cursor Fast (`cursor/cursor-grok-4.6-high-fast`). `effort: high` by default; `xhigh` when the leg looks hard.
- **Muse Spark 1.3** — action converger. Default **worker** only (`opencode/muse-spark-1.3-contributor-free`). Prefer it for speed; use Grok when the leg needs more precision. Omit `effort`.

Verifier defaults when an independent check is worth the cost:

- Claude-family main session → Sol verifier
- Codex-family main session → fresh Fable 5.1 verifier (`effort: medium`), **only after explicit approval for that dispatch**

Defaults, not mandatory pairings, and never exceptions to the approval rule. Do not automatically substitute Astra for a verifier. A clear low-risk task may use owner self-verification only.

## 3. Minimal shapes

- One bounded, already-clear technical outcome → one owner. Grok may hold that seat. That owner dispatches Muse or Grok Fast workers for settled execution.
- One material or judgment-heavy outcome → Fable or Sol owner after approval; if not approved, keep the judgment in the current session. Add a verifier when the outcome is material or ambiguous.
- Two genuinely independent outcomes → two owners; verifier only if integration risk warrants.
- Unclear root cause → the current owner diagnoses from a worker's map. A separable parallel debugging workstream is a judgment seat: ask for Sol, or Fable if the frame itself is wrong. Until approved, do not spawn a Grok owner for that seat.
- Product or UX uncertainty → framing before execution, then the chosen owners.

Build the smallest roster that gives each distinct bottleneck one clear owner.

## Scope

This skill owns model-to-work routing only. Team governance — roster approval, mission, contracts, completion — belongs to Skill(agent-taskforce). Brief-writing belongs to Skill(dispatching). Prompt structure and effort selection belong to claude-prompting-lab.
