# Runtime — fx

*Lead and teammates.* What the harness supplies. This skill still owns scope, responsibility, approved staffing, evidence, and completion.

| Concern | Where it lives |
|---|---|
| Lead | the current root fx session |
| Approved teammate | a direct persistent child of that root. There is no registration step — being one *is* membership |
| Spawn, configure, lifecycle | the `subagent` tool |
| Peer message | `team.message` |
| Roster and runtime status | `team.members` |
| Shared task list | none. The mission and each task brief carry what a teammate owns |
| Owner-local delegation | the same `subagent` tool, nested under that owner; nesting keeps it out of the team |
| Parallel spawn | `subagent.create` returns a handle without waiting, so several children can be in flight at once; wait with `inspect.wait`, never a sleep loop. Same rule for the lead seating teammates and an owner running helpers |

The role contract lives in `teammate/workstream-owner.md` and `teammate/independent-verifier.md`. fx teammates can read files, so point a new teammate at its contract path in the spawn prompt rather than pasting the contract in.

`team` is advertised only where `subagent` is — and both are advertised in a non-interactive
`fx ask` too. The ask path always builds a subagent host, so a headless teammate can spawn and
orchestrate its own children. Measured 2026-08-21: a teammate dispatched headless created a child
with `subagent.create`, waited on `inspect.wait`, and collected its result. An earlier note
here claimed the opposite and was wrong; the negative claim had already closed off
headless delegation as a direction before anyone tested it.

**Confirm where a model id actually lands before you staff it.** Ids that look alike can resolve to different accounts through the relay, and a catalog listing is not proof the model will come up — some listed ids fail outright. Send one real call to the id you plan to use and see it answer. An independent verifier that silently shares the owner's model is not independent.
