# Teammate task brief

**Outcome:** the result this teammate owns end to end.

**Why:** why the team mission needs this result.

**Write ownership / off-limits:** files this teammate writes; paths other sessions own. Binding — do not mix suggested reading into this list.

**Repository leads:** paths, call flows, causal hypotheses, method ideas worth checking. Provisional regardless of tags — the owner verifies against code, tests, and runtime, and may overrule.

**Authoritative context:** mission, frame/spec/ADR, relevant paths, facts not recoverable from the repository.

**Premises:** among the facts this brief rests on, tag the ones you have not verified yourself — `[inherited]` carried over from earlier records / `[assumed]` weakly grounded. Tags record provenance; they do not gate verification — repository-shape claims belong in Repository leads and are provisional either way. When handing down a discard/infeasible verdict, include the evidence behind it; if the basis is not an independent refutation, hand it down as provisional ("re-verification allowed"), not as settled.

**Done evidence:** the tests, runtime behavior, artifacts, source-backed findings, or environment state that will count as done — the specifics for *this* outcome. The general rules (commit on your branch, raw rows in a durable path) are already in the role contract; do not restate them here.

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
