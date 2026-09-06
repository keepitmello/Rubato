---
name: model-guide
description: "Routing guide for Agent, teammate, and verifier models. Fable/Astra are ultra-expensive: explicit user approval is mandatory for every dispatch, including verification."
---

# Model Guide

Choose an Agent's model by the work's dominant bottleneck. Treat phase labels and permanent job titles as context around that choice. This guide has two layers: cognitive profiles that are durable across model generations (§1), and an operational note pinned to a date that you replace when the catalog changes (§2).

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

## 2. Seats and models (operational, pinned 2026-09-06)

Every dispatch fills one of four seats. Pick the seat from the bottleneck (§1), then take the model, effort, and approval rule from this table. Always pass an exact `model` (`provider/model`) or a named `preset` to `Agent`; never a category, task type, or `subagent_type`.

| Seat | What it holds | Model (exact id) | Effort | Approval |
|---|---|---|---|---|
| **Owner** — judgment | framing, architecture, diagnosis, proof; the outcome's decisions | Fable 5.1 `anthropic/claude-fable-5-1` (framing, structure) · Sol `openai-codex/gpt-5.6-sol` (hypothesis, proof) · Astra `openai-codex/gpt-6-astra` | `medium`; `high` when hard | **per dispatch, model and effort both** |
| **Owner** — already-framed | a bounded technical outcome whose frame and goal are settled | Grok 4.6 `xai/grok-4.6` or Cursor Fast `cursor/cursor-grok-4.6-high-fast` | `high`; `xhigh` when hard | none |
| **Fast Model** — default worker | settled execution, maps, evidence gathering, prototypes; anything where turnaround matters more than the last few points of precision | Muse Spark `opencode/muse-spark-1.3-contributor-free` · Gemini 3.8 Flash `cursor/gemini-3.8-flash` | `high`; `xhigh` when hard | none |
| **Worker** — precise | a settled leg that needs Grok's extra precision or its large quota | same Grok ids as above | `high`; `xhigh` when hard | none |
| **Verifier** | falsifying a material artifact, from a *different* model family than its producer | Claude-family main session → Sol · Codex-family main session → Fable 5.1 | `medium` | same as the judgment owner row |

Opus 5 has no slot.

### Fast Model

Muse Spark and Gemini 3.8 Flash sit at roughly Grok's level of capability and run several times faster, so they are the first choice for a worker and are fine to run as an `Agent` on their own. Reach for Grok instead when a leg keeps tripping on precision, or when you want its quota rather than speed. All three are action convergers: they compress the action space, not the answer space, so none of them takes a judgment seat.

### Owner seat

The judgment owner is Fable 5.1 or Sol, by bottleneck — Fable for framing and structure, Sol for hypothesis and proof. Grok may hold the owner seat only when the outcome is already framed and the work is clear. If the bottleneck is judgment — diagnosis, framing, architecture, or what should be built — a Grok owner is itself the bottleneck: ask for Fable or Sol, and until that is approved keep the judgment in the current session rather than spawning a Grok owner.

- **Fable 5.1** — problem framer and structurer. As an Agent: framing, human-outcome review, cross-stream architecture, contracts, integration.
- **GPT-5.6 Sol** — hypothesis converger. Default verifier, the supervisor when the owner is stuck, and the owner when the proof itself is the deliverable.
- **Astra** — same effort and approval rule as Fable and Sol.

### Approval rule

**Fable (including Fable 5.1), Sol, and Astra require the user's explicit approval for every dispatch, in every role — owner, worker, or verifier.** Before spawning, name the model, effort, and task and obtain approval. A verifier role, a routing default, a fallback, or a previous approval for a different task is NOT permission; approval is scoped to the specified task and effort, not to later spawns or new tasks in a resumed agent. A clear owner seat may run on Grok without that approval; a judgment seat may not. The verifier pairings in the table are defaults, not mandatory pairings, and never exceptions to this rule. Do not substitute Astra for a verifier automatically. A clear low-risk task may use owner self-verification only.

### Routing order

1. Determine the main session's current model family now, not the family it started with; it may have changed during the session.
2. Choose the seat from the bottleneck; for an independent verifier, pick a different model family from the artifact's producer.
3. Pass the exact `model` and `effort` from the table, or a named `preset`. The harness resolves a preset against the live catalog, admits it, and carries the runtime fallback chain; use an exact `model` when provider/model identity is itself a requirement.
4. Say in one line which model or preset the agent runs on; report the resolved model when the runtime returns it.

Choose the seat at dispatch and predict the dominant bottleneck up front rather than planning to climb later. A stronger model existing is not by itself a reason for a new session; whether the next leg continues or starts fresh belongs to Skill(dispatching).

## 3. Minimal shapes

- One bounded, already-clear technical outcome → one owner. Grok may hold that seat. That owner dispatches Fast Model workers for settled execution.
- One material or judgment-heavy outcome → Fable or Sol owner after approval; if not approved, keep the judgment in the current session. Add a verifier when the outcome is material or ambiguous.
- Two genuinely independent outcomes → two owners; verifier only if integration risk warrants.
- Unclear root cause → the current owner diagnoses from a Fast Model worker's map. A separable parallel debugging workstream is a judgment seat: ask for Sol, or Fable if the frame itself is wrong. Until approved, do not spawn a Grok owner for that seat.
- Product or UX uncertainty → framing before execution, then the chosen owners.

Build the smallest roster that gives each distinct bottleneck one clear owner.

## Scope

This skill owns model-to-work routing only. Team governance — roster approval, mission, contracts, completion — belongs to Skill(agent-taskforce). Brief-writing belongs to Skill(dispatching). Prompt structure and effort selection belong to claude-prompting-lab.
