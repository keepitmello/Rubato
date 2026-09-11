# Runtime — rubato-pi

*Lead and teammates.* What this harness supplies. The skill still owns scope, responsibility, approved staffing, evidence, and completion.

| Concern | Where it lives |
|---|---|
| Lead | the current `rubato-pi` session |
| Teammate | a process member of a `team_create` run, spawned after combined intent/roster confirmation |
| Spawn, configure, lifecycle | `Agent`, `team_create`, `dag` |
| Peer message | `AgentSend` for spawned Agents; `team_send` for the team mailbox |
| Roster and runtime status | lead `team_*` tools including `team_send` and shutdown request/response; members get `team_send` plus board tools from the member extension |
| Shared task list | Rubato team tasklist on disk; board operations have one owner per process |
| Owner-local spawn | the member process registers Agent tools so it can run subagents under itself; those children are not teammates |
| Parallel spawn | `Agent` / `team_create`; completion notifications deliver terminal results, and `AgentOutput` reads an immediate midpoint snapshot |

The role build owns the whole system prompt. Lead gets `lead.md`; owners and verifiers get `teammate.md`; both prompts carry the shared brief-receiving and brief-writing contract. A plain `Agent` spawn gets `agent.md`, which carries the receive-and-return contract. Model calls authenticate through the existing Rubato broker at `:8788`, including `/login`. `RUBATO_PI_ROLE=owner|verifier` wins; a member env without that role is treated as owner. Verifiers retain write tools.

`worktreePath` provisions a real worktree with `git worktree add`. Done evidence and budget return live in board-task `metadata`.

Choose an exact `model` or named `preset` when you spawn a one-off `Agent`. Never pass a category, task type, or `subagent_type`. Omit `effort` unless you need a manual override. `team_create` takes the approved team specification and does not accept Agent `model`, `preset`, or `effort` parameters. Use the resolved model in Agent status to confirm that an independent verifier lands on a different family from the owner.

Launcher: `harness/scripts/rubato-pi.sh` (`rubato` / `rubato-pi`). State: `~/.rubato-pi/agent`. Teammates run independent slices as `Agent` subagents; follow `LEAD.md`'s combined intent/roster confirmation before `team_create`; discovery subagents remain bounded by existing model/budget permissions. `/login` uses the broker. The TUI keeps `Tip:` lines and `/changelog` outside this surface.

## Intent linkage

Resolve the intent before staffing and carry its reference and the lead's canonical
workspace in the mission and each owner brief. A provisioned worktree uses that same
source, not a newly invented local intent. Where a board operation accepts `metadata`,
carry `metadata.intent_ref`; do not add unsupported parameters to `team_create` or
`Agent`. The runtime still owns lifecycle, and the board still owns assignment state.
The `work-intent` check is an explicit helper call, not an automatic tool interceptor.
When the intent changes, notify affected owners and preserve evidence against the
revision actually checked; a new run does not require a new intent.
