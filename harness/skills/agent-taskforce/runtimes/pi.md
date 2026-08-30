# Runtime — rubato-pi

*Lead and teammates.* What this harness supplies. The skill still owns scope, responsibility, approved staffing, evidence, and completion.

| Concern | Where it lives |
|---|---|
| Lead | the current `rubato-pi` session |
| Approved teammate | a process member of a `team_create` run, after the lead showed the roster and the user said yes |
| Spawn, configure, lifecycle | `task`, `team_create`, `dag` |
| Peer message | `task_send` |
| Roster and runtime status | lead `team_*` tools; members also get board `task_list` / `task_get` / `task_update` from the rubato-pi adapter |
| Shared task list | Rubato team tasklist on disk, with member claim/update in the adapter |
| Owner-local delegation | the member process re-registers the task engine so it can spawn its own non-member helpers |
| Parallel spawn | `task` / `team_create` with `run_in_background`; completion notifications deliver terminal results, and `task_output` reads an immediate midpoint snapshot |

The role build owns the whole system prompt. Lead gets `lead.md`; owners and verifiers get `teammate.md`; both prompts carry the shared brief-receiving and brief-writing contract. A plain `task` Agent gets `agent.md`, which carries the receive-and-return contract. Model calls authenticate through the existing Rubato broker at `:8788`, including `/login`. `RUBATO_PI_ROLE=owner|verifier` wins; a member env without that role is treated as owner. Verifiers retain write tools.

`worktreePath` provisions a real worktree with `git worktree add`. Done evidence and budget return live in task `metadata`.

Choose a semantic category when you staff a role. The harness resolves its live provider, admission, and fallback chain; use the resolved model in task status to confirm that an independent verifier lands on a different family from the owner.

Launcher: `harness/scripts/rubato-pi.sh` (`rubato` / `rubato-pi`). State: `~/.rubato-pi/agent`. One-off `task` Agents are available at the owner's discretion; show the user a role+category roster and wait for yes in chat before `team_create`. `/login` uses the broker. The TUI keeps `Tip:` lines and `/changelog` outside this surface. `task` and `team_create` categories are model short names (`grok`/`sol`/`opus`).
