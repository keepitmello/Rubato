# Quality, verification, hooks, and lightweight regression checks

*Lead and verifier.* What counts as done without turning the harness into the work.

## Done is an environment state

Match evidence to the task.

- code: targeted tests, typecheck, runtime or browser behavior, inspected diff
- debugging: stable reproduction, isolated cause, fix, regression check
- research: source-backed findings, requested coverage, contradiction handling
- architecture/product: requirement coverage, tradeoffs, coherent decision artifact
- operations: observed state, logs, actual command results

When an active frame is used, also check the linked hypothesis, user outcome, and acceptance test.

## When to add a verifier

Use an independent verifier when a material failure could survive owner self-checks, when several streams must integrate, or when acceptance is ambiguous. Skip the resident verifier for clear low-risk work and let the owner produce reproducible evidence.

A verifier may find nothing; that is a valid result. Block material correctness, requirements, integration, security, operability, and completion honesty — not style preferences or implausible edge cases.

For high-risk or interpretation-heavy work, owner and verifier may agree on done evidence before implementation using `templates/verification-contract.md`. Do not create the contract for clear, small tasks.

## Measurement caution

A reported gate is a claim, not a result. Run it yourself before any action that makes a result canonical: a pointer bump, tag, merge, or release. A paraphrased "tests passed" loses direction in both senses — the same summary can under-report failures or call a red run green. Require briefs to quote the gate's own summary line verbatim, and read the count rather than the exit status: a tool that prints nothing on success has told you nothing.

When you hand failures back, separate what is an implementation defect from what is a stale expectation. An owner given an undifferentiated list can satisfy all of it by editing expectations, which paints a regression green.

Instrument validity and intermittent-failure sampling are the verifier's to enforce, and the rules live in `teammate/independent-verifier.md`. What the lead owes them is the distinction itself: a round whose measurement path broke is measurement-invalid, not a batch of target failures.

## Hooks

Do not enable generic hooks by default. Add a hook only for a deterministic failure observed repeatedly: a required test, forbidden path, destructive command, or mandatory artifact.

## Revising this skill

Do not build an elaborate scoring system before live use. Keep a few regression scenarios around the actual behaviors this skill promises, run real tasks, and promote only observed recurring failures into permanent rules or tests.
