# Common prompting core

These patterns apply across current Claude models unless a model delta overrides them.

## Solve the behavior problem before polishing prose

Describe the failure in observable terms. “The prompt is bad” is not actionable. Prefer statements such as:

- the model stops after analysis without making the requested edit;
- it reports success without running the test;
- it chooses the wrong tool when two schemas overlap;
- it gives a fluent answer despite missing source evidence;
- it becomes verbose after five tool calls;
- it follows retrieved instructions that conflict with the user's goal.

Map the failure to a layer: model or effort, task specification, context, tool contract, memory, orchestration, output schema, evaluator, or security boundary.

## State the outcome and completion condition

Tell the model what the finished state looks like. Include concrete checks where possible:

- a command exits successfully;
- a file exists and contains required fields;
- a browser path was exercised;
- cited claims are supported by the cited text;
- the database reflects the intended transaction;
- a rubric reaches a threshold;
- unresolved items are explicitly listed.

Do not substitute “be thorough” for a completion condition.

## Be clear, direct, and contextual

State the desired output, constraints, and degree of initiative. Add the reason behind important requirements so the model can generalize to unseen cases. A compact explanation of intent is usually stronger than a long blacklist of mistakes.

Weak:

> Do not be vague, do not hallucinate, do not skip steps, and do not be lazy.

Stronger:

> Use only the supplied sources for factual claims. When the sources do not support a claim, say what information is missing. This report will be audited against the citations.

## Prefer affirmative behavior

Write the action the model should take, not only what it should avoid.

- Replace “do not over-explain” with a target length and information order.
- Replace “do not guess” with a source policy and missing-information behavior.
- Replace “do not stop early” with a completion checklist and continuation rule.
- Replace “do not touch unrelated files” with an allowed scope and an escalation rule.

Negative constraints remain useful for hard boundaries, but they need a positive alternative.

## Use functional roles, not persona theater

A one-sentence role can focus expertise and tone:

> Act as a senior incident reviewer who distinguishes observed facts from hypotheses.

Avoid invented biographies, names, emotions, or alternate identities unless roleplay is the product. Role prompts can imply broader character traits than intended, especially over long conversations.

## Use examples when they carry signal

Examples are valuable for:

- exact output formats;
- ambiguous labels or taxonomies;
- tool-selection boundaries;
- tone and density;
- edge-case decisions;
- acceptable versus unacceptable evidence.

Use a small set of realistic, diverse examples. Three to five examples are a strong default when consistency matters. Wrap examples in explicit tags and make sure they do not accidentally teach unwanted verbosity, reasoning style, or factual assumptions.

## Structure complex prompts

Use explicit sections or XML tags to separate stable policy from variable data:

```xml
<role>...</role>
<objective>...</objective>
<context>...</context>
<constraints>...</constraints>
<tools>...</tools>
<workflow>...</workflow>
<completion_checks>...</completion_checks>
<output_format>...</output_format>
<input>...</input>
```

Do not add structure to a two-sentence task. Structure should reduce ambiguity, not decorate the prompt.

## Place long context deliberately

For large documents or many records:

1. Put source material before the final task.
2. Preserve source identifiers and metadata.
3. Put the query and output instructions near the end.
4. Ask for relevant evidence or quotations before synthesis when traceability matters.
5. Filter or retrieve relevant material instead of loading everything by default.

More tokens are not automatically more useful. Remove duplicate, stale, low-authority, and irrelevant context.

## Guide reasoning without scripting hidden thought

Prefer high-level guidance:

> Consider competing explanations, check the evidence against each, and verify the conclusion before answering.

Do not require a fabricated step-by-step transcript. Request user-visible artifacts that can be checked:

- assumptions;
- short rationale;
- evidence table;
- alternatives considered;
- decision criteria;
- test results;
- unresolved questions.

## Calibrate initiative

State whether the model should act, ask, or propose. Use explicit boundaries:

- act autonomously inside the allowed scope;
- ask before irreversible actions;
- continue through recoverable failures;
- stop and report when authorization or critical information is genuinely missing;
- do not ask for information that tools or the current context can resolve.

## Calibrate verbosity and communication

Specify audience, density, and progress cadence when they matter. Effort controls internal work and tool use more than final prose length. State output length separately.

Example:

> Give a two-paragraph executive answer first. Put implementation details under expandable headings. During work, send a progress update only after a material finding, a blocker, or completion of a major phase.

## Separate evidence from confidence

Require citations, tool outputs, tests, or inspected artifacts for claims that can be verified. Do not accept polished self-reports as evidence of completion.

## Base prompt skeleton

```xml
<role>
You are a [functional expert].
</role>

<objective>
Produce [observable result]. The work is complete when [checks].
</objective>

<context>
[Relevant domain, users, constraints, and why the result matters.]
</context>

<scope>
You may [allowed actions]. Ask before [irreversible or high-risk actions].
</scope>

<workflow>
Use the available evidence and tools. Choose your own detailed reasoning path.
[Only the few task-specific stages that truly matter.]
</workflow>

<verification>
Before finishing, verify [criteria] using [tests/tools/evidence]. Report unresolved failures honestly.
</verification>

<output_format>
[Exact structure, audience, length, schema, and citation policy.]
</output_format>

<input>
[Variable user data.]
</input>
```

For Opus 5, consult the model delta before adding explicit self-verification; redundant verification can cause excess work.

## Common anti-patterns

- A giant system prompt that mixes policy, examples, temporary state, and retrieved content
- Old model workarounds retained without a regression test
- Negative-only instructions that repeatedly activate the unwanted concept
- “Think step by step and reveal everything” as a universal quality switch
- A theatrical persona used in place of task criteria
- Tool descriptions that are only one vague sentence
- An agent instructed to “use every tool” rather than choose the smallest useful set
- Completion based on the model saying it is complete
- Memory that only appends and never corrects stale facts
- Security rules enforced only by natural-language instructions
