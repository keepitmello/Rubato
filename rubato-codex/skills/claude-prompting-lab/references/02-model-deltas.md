# Current model deltas

Apply the common core first. Add only the delta for the actual target model. Verify the current official docs when the model or API surface has changed since the source snapshot.

## Fable 5 and Mythos 5

Use for the hardest, longest, most ambiguous, and most autonomous work. Mythos 5 shares the same underlying capability and prompting patterns but has different access and safeguards.

### Prompting posture

- Give the complete objective, relevant context, authority boundaries, and completion checks up front.
- Expect longer uninterrupted work. Encourage action inside scope rather than repeated planning or permission-seeking.
- Use brief, high-leverage steering. The model follows instructions strongly, so do not enumerate every historical failure mode.
- Explain why an important constraint exists. Fable generalizes well from purpose and intent.
- Re-evaluate old skills, tools, and guardrails. Stronger capability can make earlier scaffolding redundant or counterproductive.
- Ground progress and completion in tool results. Do not let a long autonomous run rely on narrative confidence.

### Effort

Start from the current default and sweep effort on real evaluations. Use lower effort for routine work, high for difficult work, and xhigh or max only when the endpoint supports it and the task value justifies the added cost.

### Long runs and memory

- Persist durable state outside the context window.
- Save one reusable lesson per memory item when possible.
- Merge, update, or delete wrong notes instead of accumulating contradictory guidance.
- Use long-lived specialists for genuinely persistent subproblems.
- Use a fresh-context verifier near major milestones or before final delivery.

### Early stopping and “context anxiety”

Give a continuation rule and a durable progress artifact. Tell the model to finish the next concrete unit of work, update state, and continue while recoverable work remains. Avoid vague commands such as “work forever.”

### User-facing communication

Separate internal execution from user communication. A dedicated `send_to_user`-style tool or explicit progress channel can prevent status narration from contaminating the work loop. Report material findings, blockers, decisions, and completion—not every internal step.

### Reasoning output

Do not ask Fable to reproduce hidden reasoning. Its safeguards specifically cover attempts to extract summarized or protected reasoning. Request concise rationales, evidence, decisions, and verifiable artifacts.

## Opus 5

Use for difficult agentic coding, code review, enterprise work, and long-horizon tasks where quality and judgment matter.

### Prompting posture

- Give the full task specification and allow the model to complete the job end to end.
- State final-answer length explicitly. Effort does not reliably control user-visible verbosity.
- State the desired progress cadence. Opus 5 may narrate agentic work more than desired.
- Calibrate written deliverable length. It can produce longer reports and documents than prior Opus models.

### Remove legacy verification pressure

Opus 5 often verifies its own work without being told. Instructions such as “double-check everything repeatedly,” “keep reviewing until perfect,” or redundant verifier loops can cause over-verification, extra tool calls, latency, and scope expansion. Remove them first; add a narrow verification rule only when an evaluation shows a real gap.

### Scope and delegation

- Define the requested scope and explicit non-goals.
- Cap subagents or delegate only substantial, separable work.
- Avoid sending tiny tasks to subagents or asking multiple agents to repeat the same check without a measured reason.
- Do not require visible self-correction for harmless wording issues. Surface corrections that change the result or user decision.

### Thinking

Keep thinking enabled at low effort for lightweight tasks unless current docs and evaluations justify disabling it. With thinking disabled, Opus 5 can occasionally expose internal XML-like artifacts or tool-call markup in visible text.

### Review prompts

When code review should maximize recall, ask for all supported findings, then filter severity in a separate pass. A single instruction such as “only report high-severity issues” can suppress valid findings too early.

## Sonnet 5

Use for cost-sensitive coding, agents, and professional work where strong quality at Sonnet economics is desirable.

### Prompting posture

- State style and verbosity when the product requires consistency. Sonnet 5 otherwise scales response length with task complexity.
- Use positive examples of the desired density rather than only telling it not to over-explain.
- Give concrete product and frontend direction, or explicitly ask it to propose options before implementation.

### Effort and tool use

Start with high, then test lower settings for routine work and xhigh for the hardest coding or agentic cases. Higher effort can make tool use more agentic, so evaluate both output quality and the number of calls.

### Migration details

Do not carry forward legacy manual thinking-budget assumptions. Check current migration docs for adaptive thinking, accepted sampling fields, tokenizer changes, and output-token headroom. Treat API validation errors as configuration failures, not prompt failures.

## Product system prompts versus API prompts

Anthropic publishes snapshots of core system prompts used by claude.ai and mobile apps. They are useful evidence about product behavior and interaction conventions. They do not apply to the Claude API, and copying them wholesale into an API system prompt mixes product-specific assumptions with your application.

## Migration pattern across model generations

1. Freeze a representative evaluation set.
2. Run the new model with a minimal common-core prompt.
3. Compare outcome quality, tool use, latency, cost, verbosity, clarification rate, and completion honesty.
4. Classify each regression by layer.
5. Add the smallest model-specific delta that fixes a measured problem.
6. Delete obsolete instructions rather than rewriting them into new wording.
7. Re-run multilingual and long-session tests.
