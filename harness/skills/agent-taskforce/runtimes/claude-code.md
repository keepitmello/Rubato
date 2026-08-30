# Runtime — Claude Code Agent Teams

*Lead and teammates.* What the harness supplies. This skill still owns scope, responsibility, approved staffing, evidence, and completion.

| Concern | Where it lives |
|---|---|
| Lead | this session |
| Approved teammate | an in-process teammate spawned from the `workstream-owner` or `independent-verifier` agent type |
| Spawn | the Agent tool, with the agent type carrying the role contract from the first token |
| Peer message | `SendMessage` addressed to the teammate's name |
| Roster and runtime status | `ListAgents` |
| Shared task list | supplied by the runtime |
| Owner-local delegation | the Agent tool under that owner — an ordinary subagent, not a teammate |
| Parallel spawn | several Agent calls in **one** message start at once; calls in separate messages run one behind another. Same rule for the lead seating teammates and an owner running helpers |

Address peers by name. The lead is not a relay.
