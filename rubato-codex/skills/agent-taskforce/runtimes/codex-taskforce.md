# Shared taskforce board

Use the installed taskforce MCP when continuing owners need assignments,
dependencies or handoffs. Small local work and focused helpers stay board-free.
Use the advertised namespace; native plugins may prefix server/tool names.

## Scope

Every call requires `workspace` and `run_id`. The lead chooses one stable
absolute workspace identity and the original native root/thread ID or another
unique run ID. Carry both unchanged in every brief, including worktree owners.
The root may read `CODEX_THREAD_ID`; children use the lead's scope rather than
their own child thread ID. Resume the recorded scope after an interruption.

`actor` is the caller's native ID or canonical task name. It is cooperative
metadata, not authentication or permission to write another owner's files.

## Operations

- `task_create`: scope, `subject`, `description`; optional `blocked_by`,
  `outcome`, `write_ownership`, `budget`, `done_evidence`, `metadata`.
- `task_list`: scope; optional `status` and `owner` filters.
- `task_get`: scope and `task_id`; returns the task and audit events.
- `task_update`: scope, `task_id`, `actor`, and exactly one of `status` or
  `reassign_to`. Completing a task requires `evidence`. Reassignment requires
  `recovery_reason` and records the handoff.

Lead creates work, then spawns the native owner with board scope and item ID.
The owner claims it and advances `pending → claimed → in_progress → completed`.
Dependencies must be completed before claim. Treat ownership or dependency
errors as facts to resolve, never as permission to steal another task.

Send follow-ups to the same owner with native tools. Record local completion
evidence on the board and return it through native messages; the lead still
judges integration. The board sends no notifications and never marks work done
because its native agent became idle or completed a turn.

For recovery, inspect native state and artifacts first. The lead may explicitly
reassign genuinely unavailable ownership with its reason. This does not stop,
spawn or resume an agent. Do not use reassignment to bypass a dependency.

## Storage and diagnostics

State is outside the plugin/source tree, by default `~/.codex/taskforce` (or
`TASKFORCE_STATE_DIR`). Keep it when upgrading or uninstalling the integration.
Every MCP process uses the same SQLite database; writes are transactional.

The package's `taskforce/src/cli.js` uses the identical core for diagnostics.
Run it from the package checkout with a JSON scope. Tests must use an isolated
`TASKFORCE_STATE_DIR`, not the live board. Missing MCP tools in an old root mean
discovery may be stale, not that the board is empty; reconnect or use a fresh
root instead of launching a substitute worker runtime.
