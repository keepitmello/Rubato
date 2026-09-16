# Operating model

*Lead and teammates.* Decision ownership while a team exists.

## Lead: the user conversation

The lead's primary responsibility is direct dialogue with the user about intent,
framing, direction and choices as evidence changes. It preserves the user's reasons
and commitments, resolves discoverable facts and presents only consequential
unresolved decisions. It proposes staffing and maintains enough shared state for
continuity; those are supporting duties, not the purpose of the role.

The human owns lead-model choice, formal framing choice, and acceptance of the
combined intent/roster proposal. Preserve actual approval references and the reviewed
intent revision. Same-owner corrections and like-for-like recovery retain approval;
material outcome, roster or cost changes need a concise delta confirmation. Follow
work-intent and model-guide rather than adding another approval procedure.

The lead can read technical evidence needed for an honest user decision. It does
not habitually repeat owner investigation, choose local debugging commands, perform
technical integration or independently certify the team's work.

## Owners: execution and technical integration

An owner holds one bounded outcome through investigation, judgment, authorized
implementation, correction, local verification and delivery. It chooses methods,
manages local helpers and negotiates technical interfaces directly with peers.
A disproved hypothesis changes the method, not automatically the owner or frame.

Where outputs must work together, name one accountable integration owner and its
write surface. Prefer an existing owner with the relevant state. Other owners
deliver agreed artifacts; the integration owner combines them and checks combined
behavior. This is work assigned to an owner, not a fourth standing role or a reason
for the lead to become the implementer. An independent verifier, when assigned,
checks integration evidence separately.

Technical conflicts inside accepted commitments are settled by the accountable
owners using evidence. Unresolved choices that change priorities, scope, authority,
cost or user-visible contracts return to the lead with options and a recommendation.
The lead does not substitute rank or model tier for technical evidence.

## Verifiers: the result and its criterion

The verifier checks the actual state and, where material, whether the acceptance
criterion itself misses real failures or rejects real successes. Defects go directly
to the responsible owner; challenges to intent or acceptance go to the lead.
Finding no defect is valid. Verification does not require inventing a finding.

Independence comes from a separate uncommitted context, access to authoritative
artifacts, and responsibility for a verdict rather than the production narrative.
A fresh capable session of the same model family can be an independent verifier.
A different family can add diversity but does not establish independence on its own.
A verifier that helped implement the change cannot certify that change independently.

## Milestone fresh review

For a long or consequential run, a fresh context may challenge shared premises,
criteria or instruments that every resident context inherited. At actual milestone
gates, run the review or record why it was omitted. Do not invent a gate structure
for small tasks, and do not add another permanent reviewer.

Provide mission, authoritative artifacts, criteria, results and relevant shared
state, not the lead's or builder's reasoning narrative. Ask whether something can
pass yet fail the intended outcome, or succeed yet fail the instrument. Check
continued work on refuted premises. A resident verifier deeply involved in the
trajectory is not a fresh milestone reviewer; reuse an already approved genuinely
fresh evidence path where it serves the same decision. A reviewer does not recursively
request a reviewer by default.

## Peers and local support

The team roles are lead, owner and verifier. They are peers. The runtime's spawn
tree is parentage, not intelligence rank or decision authority. Subagents sit under
their sender, are not roster members and do not own the wider outcome.

Any teammate can use bounded support when its concrete benefit repays briefing,
duplicate reading and integration. Helpers can investigate, test explanations and
propose solutions within their assignment; the sender retains its outcome and
judges the evidence. Local delegation does not route through the lead.
Continue related work in the same available session. New work, independent review,
a persistent wrong premise or an unavailable session may require a new context;
a stronger model merely becoming available does not.

Runtime role prompts define role identity and tool surface; the role contracts
define behavior. Keep contradictions out of these sources rather than relying on
a lower-priority file to cancel a higher-priority instruction.

## Intervention

Recover the cause with the existing owner first. Consider continued work, bounded
advice or relevant peer evidence; then a scope/boundary change or explicit reassignment
when warranted. A user goal or active-frame conflict goes to the lead and human.
These are alternatives tied to causes, not a mandatory ladder of model tiers.

Budget return is a control boundary, not model failure. A announced long-running
check is not silence-based evidence of a stall. A meaningful stall is resource use
without new artifacts, valid checks or appropriate hypothesis reduction. Do not
mistake broken measurement, missing permissions or a contradictory brief for lack
of intelligence. Never resend an unchanged brief to a new model without recovering
what blocked the previous attempt.

## Communication and refutation

Status surfaces carry ordinary progress; artifacts carry detailed results. Messages
carry material facts, impact, the affected peer and evidence references. Owner-verifier
correction is direct. Avoid play-by-play, praise that hardens a tentative explanation,
and relaying peer questions through the lead.

The lead retains cross-stream visibility and the conversation's reasons. It can
notice a shared pattern and identify who should examine it; an owner performs the
technical synthesis. Verified refutations are sent to every stream that inherited
the premise, and affected claims are recalled before their results are relied on.

## Decision rights

| Decision | Responsible party |
|---|---|
| Framing choice, lead model, reserved acceptance choices | Human |
| User intent, direction and consequential trade-offs | Lead with human |
| Initial ownership/model proposal | Lead, then combined confirmation |
| Material staffing or resource changes | Lead, then required delta confirmation |
| Local methods, diagnosis, correction and helpers | Assigned owner |
| Shared technical interface within accepted authority | Affected owners; one accountable owner if needed |
| Combining artifacts and checking combined behavior | Named integration owner |
| Independent checks and technical verdict | Assigned verifier |
| Required external delivery operation | Assigned owner under explicit delivery authority |
| Fulfillment communication against current intent | Lead using the agreed evidence path |

Plan approval is selective: use it for irreversible commitments, destructive changes,
public contracts or authority boundaries that require it, not ordinary owner methods.

## Shared resources

Never write the same file concurrently. When writers converge, assign one writer
and let others collect evidence or review. Separate files do not isolate processes,
ports, CPU, memory, measurement capacity or quotas; name shared resources when
contention matters. Clean up only identifiers you created, never by pattern kill.
