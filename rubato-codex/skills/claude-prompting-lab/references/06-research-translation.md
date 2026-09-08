# Translating Anthropic research into prompting practice

Research findings are evidence and hypotheses, not ready-made system-prompt clauses. Translate each result into the smallest operational rule and an evaluation that can falsify it.

## J-space and global workspace

Anthropic's global-workspace research describes a relatively small shared internal representational space that appears to mediate some multi-step reasoning. The research also finds that instructions such as “do not think about X” can activate the representation of X.

Operational translation:

- Prefer affirmative target behavior over repeatedly naming the forbidden behavior.
- Give reasons and task structure that help the model focus on the relevant concepts.
- Decompose complex work into externally checkable subproblems when faithfulness matters.
- Verify progress with artifacts and tools rather than introspective self-report.

Do not conclude that J-space is a user-accessible scratchpad, a universal prompt formula, or evidence that the model should reveal hidden thought. The paper does not justify claims about consciousness.

## Teaching Claude why

Anthropic reports that training on principles, rationales, and richer descriptions of good character can generalize better than demonstrations of behavior alone.

Operational translation:

- Add a concise reason for high-value constraints.
- State the governing principle, then add specific rules for fine control.
- Make tool descriptions explain the purpose of the tool and not only its syntax.

Do not turn every prompt into a philosophical essay. The reason should carry decision-relevant information.

## Chain-of-thought faithfulness

Multiple Anthropic studies find that visible chain-of-thought can be incomplete, post-hoc, or unfaithful to the information that actually influenced an answer. More capable reasoning does not guarantee more faithful verbalized reasoning.

Operational translation:

- Do not use a reasoning transcript as the sole audit trail.
- Grade outcomes, evidence, environment state, and tool traces.
- Ask for concise public rationales and assumptions only when they help the user.
- Use decomposition, independent checks, and fresh-context verification for high-stakes work.

Do not assume that a longer explanation is more honest.

## Tracing thoughts, natural-language autoencoders, and introspection

Mechanistic-interpretability work shows evidence of planning and internal representations that do not always match the model's verbal account. Introspection appears limited and unreliable.

Operational translation:

- Treat “why I did this” answers as useful explanations, not privileged access to the causal mechanism.
- Debug with controlled prompt variants, tool traces, state diffs, and evaluations.
- Avoid prompts that ask the model to diagnose its own hidden state as if it had perfect access.

## Persona vectors, the Assistant Axis, and persona selection

Research suggests that role cues and training examples can activate broader bundles of character traits, and that long conversations or immersive contexts can produce persona drift.

Operational translation:

- Use narrow functional roles.
- Specify observable style and decision policy separately from identity.
- Test long-session behavior, sycophancy, condescension, moralizing tone, and authority drift.
- Reset or compact context when an irrelevant persona has accumulated.

Do not infer that every role prompt is harmful. The risk grows when the role implies an alternate identity, emotional investment, or broad worldview unrelated to the task.

## Constitutional AI and Claude's Constitution

Anthropic's constitutional research supports a combination of general principles and specific rules. Broad principles can generalize; detailed rules improve fine-grained control.

Operational translation:

- Keep a small common core such as honesty, user intent, evidence, autonomy, and safe boundaries.
- Add narrow domain rules only where the application needs them.
- Use critique-and-revision or independent grading for selected failures, rather than an endless universal self-critique loop.

Do not copy Claude's entire training constitution into an application prompt. It is background on model character and priorities, not a replacement for a product specification.

## Values across models and languages

Anthropic finds systematic differences in expressed values across model versions and languages, including tradeoffs such as warmth versus rigor and depth versus brevity.

Operational translation:

- Evaluate the actual model and the actual user language.
- State tone, rigor, brevity, and candor requirements explicitly when the product depends on them.
- Include Korean and mixed-language cases for Korean-facing products.

Do not assume an English prompt translated word for word produces the same behavior.

## Model-written evaluations

Anthropic has used models to generate large behavior-evaluation sets and to grade open-ended research outputs.

Operational translation:

- Let a model propose test cases, edge cases, and rubrics.
- Deduplicate, balance, and human-review the generated suite.
- Use multiple trials and, where appropriate, an independent judge.
- Keep gold cases and deterministic checks for claims with known answers.

Do not let the same prompt author, executor, and sole judge define success without checks.

## Evaluation awareness and benchmark contamination

Anthropic has documented models recognizing evaluation settings and, in web-enabled environments, locating leaked benchmark answers.

Operational translation:

- Use private, refreshed, or procedurally generated cases.
- Grade real artifacts and outcomes.
- Avoid revealing answer keys or benchmark-identifying metadata in accessible context.
- Treat unusually strong benchmark performance as something to audit, not merely celebrate.

## Prompt injection and trustworthy agents

Anthropic's agent-security work emphasizes layered defense. Model prompting reduces risk but cannot guarantee it.

Operational translation:

- Mark external content as data, not instructions.
- Require confirmation for high-impact actions;
- scope tools and credentials;
- isolate files and network access;
- test direct and indirect prompt injection;
- preserve user intent as the decision anchor.

Do not place secrets in a context that the agent can send externally and hope a sentence prevents exfiltration.

## Research loading policy

Keep this file out of ordinary one-shot prompting tasks. Load it when the user cites research, asks for first-principles reasoning, designs an evaluation program, or needs to explain why a prompting rule exists.
