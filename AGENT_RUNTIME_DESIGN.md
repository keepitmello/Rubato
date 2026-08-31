# Rubato Agent Runtime Design

Status: accepted for implementation

## Outcome

Rubato exposes a small agent-oriented tool surface that does not leak Senpi concepts. The
runtime accepts either an exact model or a named preset, applies the configured model effort
unless the caller explicitly overrides it, and can move from Senpi to Pi without changing the
LLM-facing contract.

## Naming

Child model sessions use Agent terminology throughout:

- `Agent` starts an agent.
- `AgentSend` sends a follow-up instruction.
- `AgentOutput` reads status and output.
- `AgentCancel` cancels an agent.
- Public and core identifiers use `agentId`, not `taskId`.

Team messaging remains `team_send` and is distinct from `AgentSend`. `team_send` delivers
durable team mailbox messages among the lead and members. Shutdown request and response stay on
the `team_*` surface (`team_shutdown_request`, `team_approve_shutdown`, `team_reject_shutdown`).

Team work-board items remain tasks because they represent work, not model sessions:

- `team_task_create`
- `team_task_list`
- `team_task_get`
- `team_task_update`

Other team lifecycle tools retain the `team_*` prefix.

## Public tool contract

`Agent` accepts exactly one target:

```ts
type AgentRequest = {
  prompt: string
  model?: string
  preset?: string
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  summary?: string
}
```

Rules:

1. Exactly one of `model` and `preset` is required.
2. `model` is a complete `provider/model` identifier from the live host registry.
3. `preset` resolves a named role, model, prompt, and tool policy.
4. `effort` is a manual override only. Callers normally omit it.
5. Spawns are asynchronous and return an `agentId`; completion arrives as an event.
6. Missing models fail before spawn with `model_unavailable`. Rubato does not silently route
   to another model.
7. The first version has no batch shape. Hosts may execute independent `Agent` calls in
   parallel.

The LLM-facing description must include:

> Start one child agent using exactly one of `model` or `preset`. Omit `effort` normally; the
> configured model default applies. Set `effort` only when an explicit manual override is
> required.

`AgentSend`, `AgentOutput`, and `AgentCancel` each accept an `agentId` and only the fields
needed for that operation. They stay separate rather than introducing an overloaded
`Agent(action=...)` union.

## Effort ownership

Effort belongs to model configuration, not to the main session, planner heuristics, categories,
or presets.

```text
effective effort = explicit request override ?? configured model default
```

Rubato's seeded defaults are:

| Model family | Default |
| --- | --- |
| Sol | `medium` |
| Opus | `high` |
| Grok | `high` |
| Fable | `high` |

The resolved snapshot records both `effort` and `effortSource`, whose values are
`model-default` or `manual-override`. Presets do not override effort. Legacy preset/category
reasoning values are migrated to model configuration rather than becoming another precedence
layer.

[Assumption] `google-antigravity/gemini-3.7-flash` starts at `medium` because Rubato is not
using `low` as a seeded default. This remains ordinary model configuration and can be changed
without altering Agent code.

## Presets

A preset owns:

- a functional role prompt;
- one exact model;
- tool and permission policy;
- optional execution and wall-clock limits.

A preset does not own:

- effort;
- fallback routing;
- Senpi or Pi types.

Calls cannot combine `preset` with a model override. A materially useful combination should be
a separate named preset instead of another precedence rule.

## Host-independent core

The public contract and lifecycle live in a Rubato-owned package that has no Senpi imports:

```ts
interface AgentHost {
  models(): ModelCatalog
  spawn(spec: ResolvedAgentSpec): Promise<AgentHandle>
}

interface AgentHandle {
  send(message: string): Promise<void>
  output(): Promise<AgentSnapshot>
  cancel(): Promise<void>
  subscribe(listener: AgentEventListener): Unsubscribe
}
```

The core owns:

- public request validation;
- exact-model and preset resolution;
- effort precedence;
- stable agent state and event types;
- structured errors.

The host adapter owns:

- model registry access and admission;
- session creation;
- in-process or process execution;
- continuation, output, cancellation, and disposal;
- host event translation;
- provider registration context;
- persistence and process transport.

## Host adapters

### Senpi adapter

`SenpiAgentHost` is transitional. It contains every use of Senpi session managers, agent
sessions, RPC commands, extension APIs, CLI arguments, and `SENPI_*` environment variables.
No new public contract depends on those types.

### Pi adapter

`PiAgentHost` implements the same contract with Pi APIs. Contract tests run unchanged against
both adapters. Once the Pi adapter passes the release gate, Rubato removes the Senpi adapter,
Senpi CLI spawning, Senpi tripwires, and the `senpi-task` package.

## Provider and Antigravity rules

Model admission uses the parent Rubato host's live registry after provider registration.

- In-process agents reuse the parent's registered providers.
- Process agents launch with the same Rubato profile and provider extensions.
- Child launch never shells out to an unconfigured bare `pi`.
- Exact provider/model identity is checked before execution.
- `google-antigravity/gemini-3.7-flash` must be visible in both parent and process-child
  admission checks.

This matters because the Rubato launcher currently exposes the Antigravity model while a bare
Pi invocation does not.

## Migration

1. Add host-independent Agent request, state, event, and error contracts.
2. Wrap the existing child runtime behind `SenpiAgentHost` without changing behavior.
3. Replace the child-session tool family atomically with `Agent`, `AgentSend`, `AgentOutput`,
   and `AgentCancel`; rename child-session identifiers to Agent terminology.
4. Replace `category` and `subagent_type` with the exact `model` or named `preset` target.
5. Remove planner effort inference and seed model-owned defaults.
6. Rename team board tools to `team_task_*`.
7. Verify Antigravity admission in parent, in-process child, and process child.
8. Implement `PiAgentHost` and run the shared contract suite.
9. Remove the Senpi adapter and dependencies after parity.

Legacy `task*` aliases do not live in Agent core. If an installed-session compatibility window
is required, aliases exist only at the Senpi adapter edge and have an explicit removal version.

## Release gate

The implementation is ready when:

1. `Agent` accepts exact model and preset targets independently.
2. Supplying both or neither target fails before spawn.
3. Omitted effort resolves to the configured model default.
4. Only explicit effort changes that default.
5. The standard seeded defaults are Sol medium and Opus/Grok/Fable high.
6. Missing models return `model_unavailable` without fallback.
7. Agent events and snapshots report `agentId`, actual model, effort, and effort source.
8. Send, output, cancellation, completion, and failure work through the host contract.
9. Antigravity Flash passes parent and child admission.
10. Senpi and Pi adapters pass the same contract tests during migration.
11. Team board tools use `team_task_*` and do not overlap with Agent lifecycle tools.
12. Korean and English behavior evaluations omit effort unless a manual override is explicit.

## Non-goals

- Preserving Senpi naming in new core APIs.
- Adding semantic model categories or automatic model selection.
- Hiding unavailable models behind fallback.
- Combining every lifecycle operation into one union-shaped tool.
- Renaming team work-board tasks to agents.
