# Quality and evidence

*Owners, verifiers and lead.* Acceptance criteria do not vary with the selected model.

## Evidence belongs to the claim and checked state

Match evidence to the task:

- Code: relevant tests, type checks, runtime/browser behavior and inspected diff.
- Debugging: valid reproduction, isolated cause, authorized fix and regression check.
- Research: source-backed findings, requested coverage and contradictions.
- Architecture/product: requirement coverage, trade-offs and a coherent decision.
- Operations: observed state, actual commands and logs.

Name the intent/criterion revision and artifact or code state checked. A later
relevant change may invalidate old evidence. With an active frame, cover the
linked hypothesis, user outcome and acceptance test.

## Assign local checks, integration and independent verification

The owner performs local checks. A named integration owner combines outputs and
checks their joint behavior. Use an independent verifier when a material failure
could survive those checks, when an integration claim needs independent evidence,
or acceptance itself is ambiguous. Do not duplicate an approved review in the lead
or spawn a reviewer for every reviewer.

A fresh capable session of the same model family can verify independently of
production. Family diversity is optional. A verifier involved in implementing the
change must not certify that change as independent. Finding no defect is valid.
Block material correctness, requirements, integration, security, operability or
completion honesty, not style preferences or invented implausible scenarios.

Where it prevents real rework, owner and verifier can agree a
`templates/verification-contract.md` before implementation. It operationalizes
accepted requirements; it cannot silently relax the user's criterion.

## Do not confuse a report with executed evidence

Before an authorized merge, release, pointer change or other consequential
acceptance, the responsible owner or verifier must establish that the required gate
actually ran on the state being accepted. Read its authoritative result, failures
and test counts when applicable, not merely the implementer's paraphrase or a
session-completed flag. A quiet successful process is not by itself evidence that
the expected cases were discovered and checked.

The lead requests missing evidence from that responsible party and reads what
matters to the user's decision. It does not repeat a full technical pass merely
because it communicates acceptance. A required missing/failed gate remains a gap;
neither the lead nor a summary may waive it without the proper authority.

When returning failures, distinguish implementation defects, stale expectations
and broken instruments. Do not allow a green result achieved merely by rewriting
expectations around a regression. Validate uncertain instruments with known-good
and known-bad controls. Follow the verifier contract for intermittent failures;
state assumptions about sampling rather than presenting repeated correlated runs
as independent proof.

## Different endings mean different things

A finished turn, valid budget return, accepted owner result, integrated result and
fulfilled mission are separate. At budget, return covered work and what remains.
Do not mark an unsatisfied outcome complete or label its model incapable. A broken
measurement path is measurement-invalid, not a target failure.

The lead discusses fulfillment against the current intent and agreed evidence.
After acceptance, new suggestions are follow-up work; reopen the result when
material evidence undermines the original acceptance, not for every new preference.

## Improve from actual work

Use existing artifacts to compare accepted outcomes, rework, assistance, waiting
and total resources across all participating sessions, including the lead.
Token counts, API-equivalent dollars and plan debit are not interchangeable.
Keep route, effort, runtime and initial-versus-inherited assignment distinct.
Do not learn a quality rank from session exit status or self-awarded scores.

Keep the regression scenarios and add actual recurrent failures. Static instruction
checks do not prove model behavior or cost savings. Live comparisons need the same
accepted outcome and relevant artifact state. Avoid an elaborate scoring service,
mandatory tournaments or generic hooks before evidence justifies them.
