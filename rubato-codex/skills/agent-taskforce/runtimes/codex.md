# Codex native runtime

Codex owns agent creation, lifecycle, messages, follow-ups, waits and results.
The taskforce MCP is only a shared work board. Do not create a second session
registry, scheduler, daemon or model runner.

## Roles

- A continuing owner uses `agent_type: "taskforce_owner"` when advertised.
- An independent verifier uses `agent_type: "taskforce_verifier"`.
- A subagent, under the lead or a teammate, uses `agent_type: "taskforce_helper"`
  when advertised; no team roster or board item is needed unless the assignment
  requires shared work state.

These installed native roles contain their role contract and `dispatched` as
developer instructions. Send the task-specific brief, not a second copy of that
contract. Seats, parentage and spawn surface follow the base instructions' Role
selection section; this adapter only maps them to native operations. Spawn owners with
`fork_turns: "none"` unless a short, named history slice is required; spawn a verifier
with `fork_turns: "none"` always. A child still loads the base instructions and the
applicable AGENTS.md on its own; `developer_instructions` replaces only the parent's
configured developer instructions. See `references/codex-role-toml.md` for what a role
file can and cannot set.
The installer replaces the configurable base instructions with Rubato's
Codex-adapted working agreement. That base is shared and explicitly scopes its
lead section to the main/root session; each native role supplies its distinct
owner, verifier or subagent instructions. A delegated teammate does not follow the
root-only lead section. Runtime tool definitions and environment instructions
remain provided by Codex, not replaced with Pi's tool declarations.
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
| New teammate or subagent | `spawn_agent` — lead seats owners/verifiers; any teammate seats subagents the same way |
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

Read [model allocation](../references/model-allocation.md) and its model-guide.
Roles have no fixed model. The lead chooses from native tool-supported models
and the selected-provider policy in `providers.json`, without changing its own
model. Preserve exact provider identity; never import Rubato aliases blindly.

Native agents share the checkout unless the runtime states otherwise. Assign
non-overlapping writes. Preserve user changes, and stage only owned files when
the user actually requested delivery.

Read [the board contract](codex-taskforce.md) when shared tasks are needed.
Use native messages and durable artifacts for results. Measure actual timestamps
and distinguish requested settings from values emitted by the runtime. Do not
invent model identity, speed, token cost or cross-family independence.
