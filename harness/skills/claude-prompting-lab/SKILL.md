---
name: claude-prompting-lab
description: "Claude 프롬프트·툴·스킬·하네스 설계와 평가."

---

# Claude Prompting Lab

Build the smallest model-aware prompt and harness that passes explicit evaluations. Treat prompt wording as one layer of a larger configuration: model, effort, context, tools, memory, orchestration, permissions, output contract, and graders all shape behavior.

Source snapshot: 2026-08-02. Before giving model-specific advice for a newer model or a changed API, refresh official Anthropic sources using `scripts/refresh_official_indexes.py` or consult the current official docs.

## Route the task

1. Identify the target surface: Claude API, Claude Code, Agent SDK, Managed Agents, Claude.ai/Cowork, Amazon Bedrock, Google Cloud, or another host.
2. Identify the exact model or model family. Do not silently transfer advice across model generations.
3. Classify the work: one-shot response, structured generation, tool agent, coding agent, research agent, long-running workflow, prompt migration, or skill authoring.
4. Define what success looks like before rewriting anything. Prefer observable outcomes over prose preferences.
5. Decide model, effort, context, tools, memory, orchestration, and security boundaries before polishing wording.
6. Load only the reference files that match the task.
7. Draft a minimal version, create representative evaluations, and add instructions only when an observed failure justifies them.

Read `references/00-routing.md` when the surface, model, or task class is unclear.

## Load references progressively

Always read `references/01-common-core.md` for prompt design or review.

Then read only what applies:

- Model-specific behavior or migration: `references/02-model-deltas.md`
- Thinking, effort, latency, or token control: `references/03-thinking-effort.md`
- Tools, JSON schemas, citations, or user-facing progress: `references/04-tools-and-outputs.md`
- Long context, memory, Claude Code, subagents, or long-running work: `references/05-context-memory-agents.md`
- J-space, persona, chain-of-thought, constitutions, or other Anthropic research: `references/06-research-translation.md`
- Production evaluation, regression diagnosis, or model upgrade: `references/07-evals-and-migration.md`
- Source discovery and freshness: `references/08-source-map.md` and `sources/`

## Required operating principles

- Start from the current model's default behavior. Do not accumulate every workaround written for older models.
- Prefer clear affirmative behavior over a list of prohibitions. State the desired action, boundary, and completion condition.
- Explain the purpose of important constraints. A short reason often generalizes better than many brittle edge-case rules.
- Use functional roles such as “senior code reviewer” or “financial analyst.” Avoid immersive identities, invented biographies, or theatrical personas unless the task genuinely requires roleplay.
- Use examples when they remove ambiguity in format, tone, decision policy, or tool selection. Use realistic and diverse examples; do not add examples as decoration.
- Structure complex prompts with explicit sections or XML tags. Keep stable instructions, variable data, examples, and output schemas distinguishable.
- For long-document work, place documents before the query, place the task near the end, preserve source metadata, and extract relevant evidence before synthesis.
- Give general reasoning guidance rather than forcing a hand-written chain of thought. Never ask for hidden or raw reasoning. Request concise rationales, assumptions, evidence, checks, and decision records instead.
- Treat tool definitions as prompt content. Describe what a tool does, when to use it, how to use it, what it returns, its side effects, and likely failures.
- Ground progress and completion claims in actual tool results or inspected artifacts. “Done” is an outcome, not a self-report.
- Treat memory and long-term notes as a maintained knowledge base. Correct, merge, or delete stale entries instead of endlessly appending.
- Keep system-level trusted instructions separate from user input, retrieved text, web content, and tool output. Never elevate untrusted content into a system message.
- Do not use prompt wording as the only security control. Enforce permissions, sandboxes, network egress, filesystem scope, and approval boundaries outside the model.
- Evaluate in the user's real language. A prompt that works in English is not automatically equivalent in Korean or another language.

## Build the prompt and harness

Use this order unless the task calls for something simpler:

1. Outcome and completion condition
2. Functional role and decision authority
3. Relevant context and rationale
4. Constraints and explicit boundaries
5. Available tools and tool policy
6. Workflow guidance at the right level of abstraction
7. Evidence and verification requirements
8. Output contract and communication style
9. Failure, escalation, and uncertainty behavior
10. Evaluation cases and release gate

Use `templates/prompt-brief.md` to collect the minimum specification. Use `templates/prompt-delivery.md` for the final deliverable.

## Model-selection and migration rule

Do not solve a model mismatch with prompt complexity. If the required task exceeds the chosen model or effort level, recommend a configuration change first. When moving to a newer model, baseline the new model with a reduced prompt, then re-add only the instructions supported by failures in the evaluation suite.

## Evaluation rule

For production prompts, produce or update an evaluation set. Include ordinary cases, ambiguous cases, tool failures, missing context, false premises, adversarial or injection-bearing content, long-session drift, completion honesty, and language-specific cases. Run multiple trials where variance matters. Grade the final environment state when possible, not only the final prose.

Use `tests/behavior-evals.yaml` as a starter and `references/07-evals-and-migration.md` for the full loop.

## Output contract

Adapt the depth to the request, but make these elements available:

- Diagnosis: the observed failure and the layer most likely causing it
- Configuration: model, effort, tools, context, memory, and orchestration choices
- Prompt: ready-to-use system/user/tool text, separated by role
- Harness changes: deterministic controls that should not live in the prompt
- Evaluation plan: cases, graders, trials, and pass criteria
- Migration notes: instructions to remove, retain, or test
- Source notes: official Anthropic material used and snapshot date when freshness matters

Do not bury the recommended prompt under a long literature review. Put the usable artifact first, then explain the important design choices.
