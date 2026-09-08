# taskforce

`taskforce` is a cooperative shared work board for Codex native agent teams.
It persists board state and enforces workflow transitions. Codex remains the only
owner of agent creation, messages, follow-ups, waits, interruption, lifecycle,
and result delivery.

Node.js 24 or newer is required for the built-in SQLite API. The package is
verified with Node.js 26.5.0. Install its pinned dependencies from this directory
with `npm ci`.

The primary interface is a local stdio MCP server. Resolve the package directory
from the current Rubato checkout rather than storing one developer's home path:

```sh
node /path/to/rubato/rubato-codex/taskforce/src/mcp-server.js
```

Every MCP tool call requires:

- `workspace`: explicit stable workspace identity shared by every agent,
  including agents in worktrees.
- `run_id`: explicit board run identity, normally the native Codex root/thread ID.

The server needs no fixed workspace or run. State location precedence is
`TASKFORCE_STATE_DIR`, then `$CODEX_HOME/taskforce`, then
`~/.codex/taskforce`. Tests and diagnostics should use an isolated override.
The CLI may take `workspace` and `run_id` in its JSON input, or fill them from
`TASKFORCE_WORKSPACE` and `TASKFORCE_RUN_ID` for convenience.

The MCP server is named `taskforce` and exposes `task_create`, `task_list`,
`task_get`, and `task_update`. `task_update.actor` is a native Codex agent ID or
canonical task name, but it is caller-supplied cooperative metadata, not an
authenticated identity. Reassignment requires `reassign_to` and a visible
`recovery_reason`; completion requires `evidence`. Neither action touches Codex
agent state.

The diagnostic CLI invokes the identical board core:

```sh
node src/cli.js create '{"workspace":"/repo","run_id":"root-id","subject":"Review","description":"Review the patch","outcome":"A merge decision","write_ownership":"read-only","budget":"10m","done_evidence":"review result"}'
node src/cli.js update '{"workspace":"/repo","run_id":"root-id","task_id":"1","actor":"/root/reviewer","status":"claimed"}'
node src/cli.js list '{"workspace":"/repo","run_id":"root-id"}'
```

The board has no scheduler, daemon, model runner, message bus, or agent registry.
Agents sharing the state directory can also modify the SQLite file directly, so
the owner boundary is a workflow invariant rather than a security boundary.

For development, `npm run build` reproducibly generates the checked-in standalone
`dist/mcp-server.mjs`; `npm run check:dist` fails if it is stale. Runtime
installation needs only that bundle and Node.js, not `npm install` or
`node_modules`. Third-party terms are in `THIRD_PARTY_NOTICES.md`.
