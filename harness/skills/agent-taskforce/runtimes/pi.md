# Runtime — rubato-pi

*Lead and teammates.* The harness supplies execution; the skill supplies authority
and responsibility. These are the Pi edition's surfaces, not Codex role files.

| Concern | Surface |
|---|---|
| Lead | Current user-facing rubato-pi session |
| Continuing owner/verifier | `team_create` member after combined intent/roster approval |
| Roster change during the run | Lead-only `team_add_member` adds an owner/verifier to the same team under a new name; removal is `team_shutdown_request`, then `team_approve_shutdown` |
| Subagent | `Agent`, continued with `AgentSend` |
| Agent status/results | Completion pointer plus its result file; the notification is not work acceptance |
| Team communication | Direct peer `team_send` mailbox |
| Shared assignments/evidence | Team board/tasklist, including existing `metadata` |
| Lifecycle | Existing `team_*` shutdown request/response tools |
| Unavailable member recovery | Lead-only `team_replace_member`, keeping the same team/member address: for a failed/unavailable member, or a model change the user approved (`user_approval_ref`) |
| Local delegation | Any teammate can spawn `Agent` support within its authority |

`harness/prompts/build.sh` builds `.build/lead.pi.md`, `.build/teammate.pi.md`
and `.build/agent.pi.md`. Owners and verifiers share the neutral teammate file;
the runtime-assigned role identifies their different responsibility. Read the
matching taskforce role contract. `RUBATO_PI_ROLE=owner|verifier` takes priority;
a legacy member environment without an explicit role resolves to owner.
Verifiers retain write tools for authorized fixtures; that does not authorize
production repairs. Tool presence is not permission.

A custom `RUBATO_SYSTEM_PROMPT_FILE` can replace the built role prose. Runtime
identity still names the role; inspect the actual prompt path before claiming
a source-fragment edit is active. Newly created or resumed sessions must load the
intended local edition. Do not infer deployment from a source file alone.

Each `team_create` member declares `kind: owner|verifier` and an exact `model`
from the same live model catalog used by `Agent`, plus optional `effort`. The current
session is the lead and is never declared as a member. A one-off `Agent` takes an
exact `model` or named `preset`. Omit `effort` unless a supported manual override is
authorized; configured model defaults apply. Preserve restricted-model approval.
Report requested settings separately from actual model and route metadata.

A completed resident teammate is waiting, not broken; continue it with `team_send`.
For a failed/lost execution or a completed session that has been disposed/evicted,
use `team_replace_member` with the current task id and an approved exact model.
Do not create a separate team for its replacement: that splits peer addresses.
Carry the same intent, artifact paths, checked revisions and outstanding requests
in the English handoff. Unread mail and board ownership stay with the member;
consumed requests need the handoff, and old verdicts do not cover later edits.
Recovery does not authorize a model/cost change or reopening approved shutdown; a model change the user approved goes through the same tool with `user_approval_ref`.

When the approved roster grows, add the member to the existing team with
`team_add_member` and the same English brief a `team_create` member gets; a second
team splits peer addresses and the board. Peers can message the new name at once.
Tell the peers it must coordinate with and record its assignment on the board.
To remove a member, `team_shutdown_request` gives it one turn to persist its result
and handoff; `team_approve_shutdown` then stops it and takes it off the roster and
the completion wake. The board has no reassignment: first mark its open items
completed (`team_task_update` with `owner` set to that member) or deleted, and create
fresh items for whoever takes the work over; an open item still holds the batch. A
removed member's name and mail stay with it; add a successor under a new name. Names
are normalized to lowercase-hyphen form, and the result reports the actual name.

A team lead and an owner read the result artifact or board rather than replaying a
child's transcript; a completion carries its result file path. A teammate's normal
turn end does not wake the lead — one aggregate wake arrives when the run's assigned
board work is closed. The lead's own discovery subagent is distinct from a
continuing owner.

`worktreePath` provisions an actual worktree. It does not isolate ports, processes,
memory or quotas. Allocate shared resources when contention matters. The integration
owner coordinates technical combination and checks; the lead does not supply an
alternative session manager or become the technical integrator.

## Intent linkage and state

Carry the same `intent_ref` and canonical workspace through mission, briefs and
existing board metadata. Do not add unsupported arguments to `team_create` or
`Agent`. The work-intent check is an explicit script, not an automatic interceptor.
A provisioned worktree is not a new intent.

A session ending or returning on scale or a stop does not complete an unsatisfied board
outcome. Keep its evidence, remaining work and return reason in existing metadata.
Refresh references on accepted intent changes and tie prior evidence to the
revision actually checked.

Launcher: `harness/scripts/rubato-pi.sh`. Session state:
`~/.rubato-pi/agent`. Use the installed runtime's authentication and tool discovery;
do not launch a substitute runtime to fill an observation gap.
