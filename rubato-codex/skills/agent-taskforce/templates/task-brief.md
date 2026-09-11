# Teammate task brief

**Intent reference (when durable):** same canonical workspace, intent path/URI,
ID and revision as the lead; managed records also carry the returned SHA-256.
Read before dependent work. Link the specific intent/spec clauses this outcome
serves; do not restate the whole intent. Preserve this reference for descendants
and existing board `metadata.intent_ref`; a missing source is a blocker to resolve,
not permission to invent one. For a focused subagent without durable intent, the
bounded user-authorized brief is sufficient.

**Outcome:** the result this teammate owns end to end.

**Why:** why the team mission needs this result.

**Write ownership / off-limits:** files this teammate writes; paths other sessions own. Binding — do not mix suggested reading into this list.

**Repository leads:** paths, call flows, causal hypotheses, method ideas worth checking. Provisional regardless of tags — the owner verifies against code, tests, and runtime, and may overrule.

**Authoritative context:** mission, frame/spec/ADR, relevant paths, facts not recoverable from the repository.

**Premises:** among the facts this brief rests on, tag the ones you have not verified yourself — `[inherited]` carried over from earlier records / `[assumed]` weakly grounded. Tags record provenance; they do not gate verification — repository-shape claims belong in Repository leads and are provisional either way. When handing down a discard/infeasible verdict, include the evidence behind it; if the basis is not an independent refutation, hand it down as provisional ("re-verification allowed"), not as settled.

**Done evidence:** the tests, runtime behavior, artifacts, source-backed findings, or environment state that will count as done — the specifics for *this* outcome.

**Approved delivery contract (if any):** what must be handed back (for example, a branch commit, patch, artifact, or report). Absence of a contract does not authorize a commit or external delivery.

**Dependencies and peers:** teammates to contact directly, inputs to receive, handoffs to deliver.

**Local authority:** what this teammate decides on their own.

**Escalate when:** a cross-workstream contract, scope, architecture, destructive action, or active frame conflict is involved.

**Budget:** the elapsed time, token spend, or scope growth at which this owner stops and reports even though nothing is blocked. Name a number. An owner holding only impossibility triggers keeps reading an oversized surface, because "much bigger than the brief assumed" is not any of them.

## Coordination

The role contract already carries the message policy. Name the teammate peers this owner may need to contact directly, and keep the shared task state current at meaningful checkpoints. Check incoming teammate messages before cross-workstream decisions, when blocked, before a handoff, and before declaring the workstream complete.

## Optional frame link — only when an active FRAME_LOCK exists

```text
frame_ref:
supported_hypothesis:
user_outcome_link:
acceptance_test:
```
