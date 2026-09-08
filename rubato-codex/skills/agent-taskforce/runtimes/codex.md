# Codex native runtime

Codex owns agent creation, lifecycle, messages, follow-ups, waits and results.
The taskforce MCP is only a shared work board. Do not create a second session
registry, scheduler, daemon or model runner.

## Roles

- A continuing owner uses `agent_type: "taskforce_owner"` when advertised.
- An independent verifier uses `agent_type: "taskforce_verifier"`.
- A focused map/check uses `agent_type: "taskforce_helper"`; no team roster or
  board item is needed unless the actual assignment requires shared work state.

These installed native roles contain their role contract and `dispatched` as
developer instructions. Send the task-specific brief, not a second copy of that
contract. Inherited lead conversation is background, not the worker's authority.
For cold review, use no inherited turns and supply artifacts, constraints and
acceptance criteria without the builder's reasoning or desired verdict.

Check the actual schema before passing `agent_type`. A root created before role
registration can retain an older schema. If the field or role is missing,
include the matching canonical role body in the brief and say that automatic
role loading was unavailable in that session. Never invent a tool argument.
Use a fresh root after installing or changing the roles.

## Native operations

| Intent | Native operation when advertised |
|---|---|
| New independent assignment | `spawn_agent` |
| Follow-up or correction, including an idle owner | `followup_task` |
| A fact for an active peer, not a new assignment | `send_message` |
| Inspect the current team | `list_agents` |
| Await mailbox updates or completion | `wait_agent` |
| Interrupt when necessary | `interrupt_agent` |

The schema exposed in this run overrides these names and examples. Collaboration
tools are direct calls, not nested functions.exec tools. Keep the user informed
while waiting. A mailbox update or idle status is not an accepted result.

Read the sibling `dispatching` skill before assignments or follow-ups. Reuse an
owner for the same outcome. If it is genuinely unavailable, recover its evidence
before starting a replacement. A refuted premise must be recalled from all
affected owners; an idle owner who must act needs a follow-up, not just a message.

Standalone Codex app tasks are a different surface. Create one only when the
user requests a new task, not as a substitute for native delegation.

## Models and evidence

Read [GPT allocation](../references/model-allocation.md). Roles have no fixed
Sol or other model setting. The lead chooses among supported GPT models per
assignment, without changing its own model or importing Rubato's unready catalog.

Native agents share the checkout unless the runtime states otherwise. Assign
non-overlapping writes. Preserve user changes, and stage only owned files when
the user actually requested delivery.

Read [the board contract](codex-taskforce.md) when shared tasks are needed.
Use native messages and durable artifacts for results. Measure actual timestamps
and distinguish requested settings from values emitted by the runtime. Do not
invent model identity, speed, token cost or cross-family independence.
