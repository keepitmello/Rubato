# Context, memory, Claude Code, and long-running agents

## Optimize signal, not context size

The context window is a finite working set. Include the smallest set of high-authority tokens that lets the model choose the right action. More context can reduce performance through distraction, contradiction, stale state, and “context rot.”

Prioritize:

1. Current objective and completion state
2. Authoritative instructions and constraints
3. Relevant repository or domain state
4. Recent tool results required for the next decision
5. Durable memory that is both applicable and current
6. Examples only when they disambiguate behavior

## Long-document pattern

- Put documents first and the final task near the end.
- Tag documents and preserve source metadata.
- Retrieve or extract relevant passages before synthesis.
- Keep quoted evidence distinct from instructions.
- Remove duplicate versions and clearly mark superseded material.

## Context editing and compaction

Use compaction to continue long sessions, but do not rely on a prose summary as the only state. Keep durable artifacts such as:

- a task ledger with done, next, blocked, and evidence fields;
- architecture or decision records;
- test status;
- a changed-files list;
- current assumptions and invalidated assumptions;
- links or IDs for source material.

Clear old tool results when they no longer affect future choices. Preserve the minimum information needed to reproduce or verify decisions.

## Memory hygiene

Write memory as reusable knowledge, not a transcript.

- Store one lesson or fact per item where practical.
- Include scope and provenance.
- Update or delete entries that became false.
- Merge duplicates.
- Separate stable facts from temporary task state.
- Do not treat the mere presence of a value as proof that it is fresh.
- Attach timestamps or validity conditions when staleness matters.

## Claude Code instructions

`CLAUDE.md`, rules, and auto memory provide context; they are not deterministic enforcement. Keep project instructions concise, specific, and current. As a working target, keep the always-loaded file under roughly 200 lines and move detailed workflows into skills or referenced files.

Use hooks, tests, permissions, and sandboxing for behavior that must be enforced. Use `/context`, configuration diagnostics, or equivalent tooling to confirm what actually loaded.

## Skills

Keep `SKILL.md` as a routing and workflow layer. Put model variants, frameworks, schemas, and long references in separate files. The description is the primary trigger: state both what the skill does and the situations in which it should activate.

A large skill should use progressive disclosure:

1. Name and description for discovery
2. Concise `SKILL.md` for routing and core workflow
3. References loaded only for the current variant
4. Scripts and templates for deterministic work

## Subagents

Use subagents to isolate context, specialize, or run independent work in parallel. Give each one a clear outcome, relevant tools, and a narrow context. Return compressed findings and evidence to the coordinator.

Do not delegate tiny tasks that cost more context than they save. Do not have several agents repeat the same check unless diversity or independent verification is the goal.

## Multi-agent fit

Multi-agent systems work best for breadth-first research, independent workstreams, or tasks too large for one context. They are a poor fit when every step depends tightly on a shared evolving state. Measure the token cost: Anthropic reports that multi-agent research can use far more tokens than ordinary chat.

Use a one-level coordinator where possible. Pin model and prompt versions for reproducibility.

## Long-running harness

Use an initializer plus incremental workers:

### Initializer

- inspect the environment;
- create the durable task ledger;
- establish tests and verification commands;
- identify scope and risks;
- make the first small verified change.

### Incremental worker

- read the durable state;
- choose the next bounded unit of work;
- implement and verify it;
- update the state honestly;
- leave the environment ready for the next session.

### Fresh verifier

At major milestones, start from a clean context with the specification and current artifacts. Verify outcomes independently instead of trusting accumulated narrative.

## Completion and resumption

Every session should leave a visible state:

- completed work and evidence;
- remaining work;
- current blocker;
- exact next action;
- commands or paths needed to resume;
- known failures or unverified claims.

## Security and containment

Do not depend on a vigilant model or repeated permission prompts alone. Bound the blast radius with sandboxes, filesystem isolation, network allowlists, read-only credentials, and scoped tools. External content can carry prompt injection even through an otherwise legitimate connector.
