---
name: keep-simple
description: "가장 작은 올바른 수정. 과설계 금지."

---

# Keep Simple

Reduce ownership and moving parts without weakening correctness, safety, or required behavior.

## Decide in this order

1. Confirm the requested behavior and the smallest owner that should change.
2. Reuse an existing project pattern when it already owns the behavior correctly.
3. Use a standard library, platform, framework, or installed dependency when it cleanly fits.
4. Make a small direct local change.
5. Add an abstraction, dependency, cache, fallback, or configuration only when current evidence requires it.

Prefer deletion over addition when behavior remains correct. Prefer one clear path over options for imagined future needs.

## Avoid

- single-use factories, managers, registries, adapters, or configuration knobs;
- dependencies for behavior already available locally;
- speculative extension points and future scaffolding;
- duplicated decision logic or a second source of truth;
- fallback, retry, watchdog, cache-clear, or guard fixes that hide the failed primary path;
- broad rewrites when a local fix owns the behavior correctly.

Do not simplify away trust-boundary validation, security, data-loss protection, money/state invariants, accessibility, meaningful error handling, non-trivial tests, or explicit user requirements.

For bugs, identify why the primary path failed and verify that path after the change. Centralize repeated code only when it represents the same decision or contract under the same owner; superficial similarity is not enough.

Work and report normally. Mention omitted machinery only when it explains an important design choice or remaining ceiling.
