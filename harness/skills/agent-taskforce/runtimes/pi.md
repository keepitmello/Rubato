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
| Parallel spawn | `task` / `team_create` with `run_in_background`; wait with `task_output`, never a sleep loop |

The system prompt is replaced, not appended: lead gets `~/.agents/rubato/.build/lead.md` plus Skill(dispatching), teammates get `teammate.md` plus Skill(dispatched). Runtime default prompts are dropped. Model calls go through the existing Rubato broker at `:8788` — do not use Senpi `/login` OAuth. `RUBATO_PI_ROLE=owner|verifier` wins; a member env without that role is treated as owner. Verifier writes are not blocked.

`worktreePath` is a real `git worktree add`, not `mkdir`. Done evidence and budget return live in task `metadata`.

**Confirm where a model id actually lands before you staff it.** A catalog listing is not a live model. An independent verifier that silently shares the owner's model is not independent.

Launcher: `harness/scripts/rubato-pi.sh` (`rubato` / `rubato-pi`). State: `~/.rubato-pi/agent`. A one-off `task` child needs no approval; show the user a role+model roster and wait for yes in chat before `team_create`. `/login` is the broker. TUI `Tip:` lines are off. `/changelog` is removed. `team_create` category is a model short name (`grok`/`sol`/`opus`).
