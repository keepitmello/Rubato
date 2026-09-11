# Thinking, effort, budgets, and visible reasoning

## Choose effort before rewriting the prompt

Effort is a primary control for internal reasoning, tool activity, token use, latency, and cost. Prompt steering should refine behavior after an effort sweep, not compensate for an underpowered setting.

A practical starting matrix:

| Work | Starting effort | Escalate when |
|---|---:|---|
| Formatting, extraction, deterministic transformation | low | errors or ambiguous inputs appear |
| Routine implementation, ordinary analysis, short tool workflows | medium | debugging or cross-file reasoning is required |
| Complex coding, difficult analysis, multi-step tools | high | the task remains unsolved or unusually ambiguous |
| Highest-value long-horizon or frontier work | xhigh/max where supported | only after evaluations show value |

Always test on the actual workload. Lower effort can reduce tool calls as well as thinking, which may improve efficiency or cause incomplete work.

## Current-family thinking behavior

Current Claude 5-family models use adaptive thinking and effort rather than the older universal pattern of manually assigning `budget_tokens`. Defaults and the ability to disable thinking differ by model. Check the current migration guide and model page before emitting API code.

When a tool loop returns thinking blocks, preserve them exactly as required by the API. Do not edit or fabricate protected thinking content.

## Do not request hidden chain of thought

Visible reasoning is not a reliable transcript of the model's internal causal process, and current models do not expose raw hidden reasoning. Asking for it can trigger refusals or produce plausible but unfaithful explanations.

Ask for inspectable work products instead:

- a concise rationale;
- assumptions and missing inputs;
- evidence used for each conclusion;
- alternatives and decision criteria;
- a plan or checklist;
- tests performed and their results;
- unresolved risks.

## Give general reasoning guidance

Prefer:

> Analyze the competing explanations, test each against the available evidence, and verify the conclusion before finalizing.

Over:

> First think A, then B, then C, then write exactly 20 hidden steps.

The model may discover a better reasoning route than a human-authored procedure. Prescribe steps only when the domain process itself must be followed, audited, or reproduced.

## Self-checking

A narrow final check against explicit criteria helps many models. Opus 5 is the notable exception: it often self-verifies without prompting, and inherited verification instructions can cause excessive work. Apply the model delta.

## Task budgets and hard limits

- Effort controls how hard the model works.
- A task budget is an advisory budget for the full agentic loop where supported.
- `max_tokens` remains a hard output ceiling.
- Tool-call, wall-clock, financial, and permission limits belong in the harness.

Do not confuse a soft budget with a security or spending guarantee.

## When a dedicated think tool is still relevant

Anthropic's older “think tool” guidance has been superseded for most cases by improved thinking support. Retain a dedicated structured deliberation tool only when evaluations show value in a policy-heavy, sequential tool workflow and the tool creates a durable, inspectable decision record. Do not add it by habit.

## Public progress versus private reasoning

Progress updates should report externally meaningful state:

- what was inspected;
- what changed;
- what passed or failed;
- what blocks the next step;
- what remains.

They should not expose or pretend to expose private reasoning. Set a cadence so the model neither goes silent for long periods nor narrates every micro-step.
