---
name: keep-simple
description: "Smallest correct fix. No over-engineering."

---

# Keep Simple

Reduce ownership and moving parts without weakening correctness, safety, or required behavior.

## Decide in this order

1. Confirm the requested behavior and the smallest owner that should change.
2. Reuse an existing project pattern when it already owns the behavior correctly.
3. Use a standard library, platform, framework, or installed dependency when it cleanly fits.
4. Make a small direct local change.
5. Add an abstraction, dependency, cache, fallback, state machine, or configuration only when current evidence requires it.

Prefer deletion over addition when behavior remains correct. Prefer one clear path over options for imagined future needs. Represent a flow with ordinary control flow and the minimum state it needs; introduce a state machine only when distinct states, legal transitions, and transition invariants are real parts of the contract.

## Avoid

- single-use factories, managers, registries, adapters, or configuration knobs;
- dependencies for behavior already available locally;
- speculative extension points and future scaffolding;
- state machines for linear flows, a few independent flags, or transitions the product does not actually define;
- duplicated decision logic or a second source of truth;
- speculative or catch-all fallbacks that duplicate behavior, preserve a broken path, or turn errors into ambiguous success;
- fallback, retry, watchdog, cache-clear, or guard fixes that hide the failed primary path;
- broad rewrites when a local fix owns the behavior correctly.

Do not simplify away trust-boundary validation, security, data-loss protection, money/state invariants, accessibility, meaningful error handling, non-trivial tests, or explicit user requirements.

For bugs, identify why the primary path failed and verify that path after the change. Add a fallback only for a concrete, expected failure mode with a defined degraded behavior; keep failures explicit when no such contract exists. Centralize repeated code only when it represents the same decision or contract under the same owner; superficial similarity is not enough.

Work and report normally. Mention omitted machinery only when it explains an important design choice or remaining ceiling.
