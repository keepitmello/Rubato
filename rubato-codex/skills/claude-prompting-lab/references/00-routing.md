# Routing and intake

Use this file to decide which prompting layer actually needs work.

## 1. Identify the surface

### Claude API

You control the system prompt, messages, tools, thinking and effort settings, output schema, caching, and the agent loop. Product system prompts published for claude.ai do not automatically apply here.

### Claude Code

Behavior comes from the built-in harness plus project instructions, `CLAUDE.md`, rules, skills, subagents, hooks, permissions, MCP tools, model configuration, and the live repository state. Do not treat a `CLAUDE.md` rewrite as a substitute for hooks, tests, permissions, or sandboxing.

### Claude Agent SDK

The agent loop, system-prompt preset, custom tools, subagents, sessions, approvals, hooks, structured output, and persistence are all part of the effective prompt. Decide which Claude Code features to preserve before replacing the system prompt.

### Managed Agents

Agent definitions, attached skills, outcome rubrics, memory stores, session state, tools, and multi-agent orchestration are first-class configuration. Keep each agent's context and skills narrowly relevant.

### Claude.ai or Cowork

Published product system prompts and product tools affect behavior. Use them as descriptive evidence, not as an API prompt template.

### Bedrock, Google Cloud, or another host

Confirm which API fields, beta features, model IDs, thinking modes, and tool features the host supports. Separate model behavior from host-specific limitations.

## 2. Identify the task topology

- One-shot transformation: emphasize input boundaries and output schema.
- Open-ended analysis: define decision criteria, evidence policy, and uncertainty.
- Tool agent: optimize tool contracts, state transitions, and completion checks.
- Coding agent: provide repository state, tests, runtime verification, and scope boundaries.
- Research agent: plan breadth, source quality, evidence tracking, and synthesis.
- Long-running agent: externalize durable state, use incremental sessions, and verify from fresh context.
- Prompt migration: begin with a reduced current-model baseline and compare against the old prompt.
- Skill authoring: keep `SKILL.md` as a router and put detailed variants in references.

## 3. Identify the authority and risk level

Record what the model may read, write, execute, send, purchase, publish, or delete. Put irreversible permissions in the harness. Use prompts for judgment and intent; use deterministic controls for hard limits.

## 4. Identify the model and freshness state

Check the exact model ID and the documentation snapshot. Model-family advice is not enough when defaults differ across versions. Refresh official sources when:

- the model or API feature was released after 2026-08-02;
- the user says “latest,” “current,” or “today”;
- the model ID, thinking behavior, effort levels, or tool feature is uncertain;
- a prompt worked on one generation but regressed after migration.

## 5. Minimum intake

Infer missing values when the risk is low. Obtain or state these fields when they materially change the result:

- target surface and model;
- representative user input;
- expected output or final environment state;
- available tools and side effects;
- latency and cost budget;
- failure examples;
- language and tone;
- security and approval boundaries;
- evaluation cases or acceptance criteria.

## 6. Route to references

| Signal | Read |
|---|---|
| Fable 5, Mythos 5, Opus 5, Sonnet 5, migration | `02-model-deltas.md` |
| “thinking,” effort, token cost, latency, hidden reasoning | `03-thinking-effort.md` |
| tools, JSON, MCP, citations, progress updates | `04-tools-and-outputs.md` |
| long context, memory, Claude Code, subagents, multi-agent | `05-context-memory-agents.md` |
| J-space, persona, constitution, CoT research | `06-research-translation.md` |
| prompt regression, benchmark, release gate | `07-evals-and-migration.md` |
