# Runtime — rubato-pi

*Lead and teammates.* The harness supplies execution; the skill supplies authority
and responsibility. These are the Pi edition's surfaces, not Codex role files.

| Concern | Surface |
|---|---|
| Lead | Current user-facing rubato-pi session |
| Continuing owner/verifier | `team_create` member after combined intent/roster approval |
| Bounded support | `Agent`, continued with `AgentSend` |
| Agent status/results | `AgentOutput`; completion notifications are not work acceptance |
| Team communication | Direct peer `team_send` mailbox |
| Shared assignments/evidence | Team board/tasklist, including existing `metadata` |
| Lifecycle | Existing `team_*` shutdown request/response tools |
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

Owners manage their own helpers and may use `AgentOutput` for them. A team lead
reads the result artifact or board rather than replaying an owner's transcript.
The lead's own bounded discovery helper is distinct from a continuing owner.
A read of taskforce may choose direct work instead of `team_create`.

`worktreePath` provisions an actual worktree. It does not isolate ports, processes,
memory or quotas. Allocate shared resources when contention matters. The integration
owner coordinates technical combination and checks; the lead does not supply an
alternative session manager or become the technical integrator.

## Intent linkage and state

Carry the same `intent_ref` and canonical workspace through mission, briefs and
existing board metadata. Do not add unsupported arguments to `team_create` or
`Agent`. The work-intent check is an explicit helper, not an automatic interceptor.
A provisioned worktree is not a new intent.

A session ending or returning at budget does not complete an unsatisfied board
outcome. Keep its evidence, remaining work and return reason in existing metadata.
Refresh references on accepted intent changes and tie prior evidence to the
revision actually checked.

Launcher: `harness/scripts/rubato-pi.sh`. Session state:
`~/.rubato-pi/agent`. Use the installed runtime's authentication and tool discovery;
do not launch a substitute runtime to fill an observation gap.
