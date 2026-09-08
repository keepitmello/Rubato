# Tool guards on stock Pi 0.85.1

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

This slice uses only stock Pi's public extension surface. Its staged descriptor is
`harness/pi-runtime/features/tool-guards/feature.mjs#toolGuardsFeature`; runtime consumers import
`rubato-features/tool-guards/index.mjs`. There is no hidden Senpi runtime fallback.

## Implemented contract

| Capability | Current contract and source | Stock Pi binding | Selected closure |
| --- | --- | --- | --- |
| Load order | Senpi gives loop guard the first veto, ahead of hooks and permissions; tool-pair runs after terminal (`Senpi dist/core/extensions/builtin/index.js:53-78`). | `ExtensionRunner.emitToolCall` stops at the first blocking handler (`stock dist/core/extensions/runner.js:745-762`). | `loopGuardExtension` must remain before every other `tool_call` policy. The local factory list is loop -> apply-patch -> tool-pair; when hooks/permission/bash-timeout land, bootstrap must interleave them in the Senpi order rather than treating this list as globally complete. |
| Loop guard | Window 64; identical notice at 3 and 6; attempt 6 remains admitted, calls 7/8 block, call 9 system-aborts; near-identical threshold is five calls at 0.85; cycles are periods 2..6 repeated three times. Distinct read/task/poll targets are excluded (`loop-guard/policy.js:1-19`, `detectors.js:1-152`, `index.js:43-124`). | Public `tool_execution_start`, `tool_call`, `input`, lifecycle events, `sendMessage`, event bus and `ctx.abort` cover the contract. | Detector, exact reminders, escalation, wake/continuation events, recovery steering and resets are ported. A guarded fallback records a call in `tool_call` only when a programmatic executor did not emit `tool_execution_start`, so model and generic execution share one policy without double-counting. |
| Tool-pair guard | Anthropic tool-use/result adjacency and duplicate IDs, OpenAI Responses function/custom outputs, and Chat Completions tool messages are repaired immutably; interrupted calls receive `Tool output unavailable (interrupted before result)` (`tool-pair-guard/index.js:1-14` and its two sanitizer modules). | `before_provider_request` replacements chain in extension order (`runner.js:820-837`). | All three sanitizers are local, return the original payload by identity when balanced, and return `undefined` from the handler when no replacement is needed. `previous_response_id` output-only deltas remain untouched. |
| `apply_patch` admission and wire shape | Senpi replaces active `edit`/`write`, re-registers on model change and marks partial failure as a tool error (`gpt-apply-patch/extension.js:25-106`). Rubato's current transform makes only GPT on OpenAI/Azure/Codex Responses freeform and every other route JSON, with JSON as the safe initial variant (`harness/rubato-pi/src/transforms/core-tool-surface.mjs:37-53`). | Stock `ToolDefinition` exposes `prepareArguments`, `executionMode`, `execute`, and grammar `constrainedSampling` (`stock dist/core/extensions/types.d.ts:344-376`). | One public extension registers both variants, keeps one active editor, supports lazy activation, and maps freeform to `{type:"grammar", variants:{openai_lark}}`; xAI/Grok and non-GPT routes never receive a custom/freeform tool. |
| `apply_patch` execution | Current Senpi parses Codex Add/Delete/Update/Move sections, applies operations in order, tolerates documented whitespace/unicode fuzz, uses per-path mutation queues and atomic writes, retains earlier successful operations on later failure, and emits recovery guidance (`gpt-apply-patch/{parser,patch-replace,seek-sequence,apply,recovery}.js`). | The registered AgentTool supplies the real session cwd, signal and update callback. | The non-UI execution closure is ported: JSON/freeform normalization, parser, fuzzy matching, text and binary moves, sorted per-path queues, temp-file cleanup, progress, partial failure details/rewrite, and session-independent queue cleanup. Abort before any commit throws; after a commit it finishes and records that logical operation, then returns an `ABORT_ERR` partial result for the next unapplied operation. A move commits destination plus source removal before it is reported, so filesystem and `appliedFiles` cannot disagree. |

MIT attribution and the source license are retained in
`harness/pi-runtime/features/tool-guards/THIRD_PARTY_NOTICES.md`.

## Actual evidence

Run with inherited compile hooks removed:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=30000 harness/pi-runtime/features/tool-guards/tool-guards.test.mjs
```

The test stages a real stock 0.85.1 runtime and proves: all provider payload shapes; replacement chaining through the actual `ExtensionRunner`; six admitted identical calls followed by first-handler veto, hard stop and reset for both native and generic event shapes; actual registered `apply_patch` add/update execution, GPT/freeform versus Grok/JSON model switching, partial-error rewriting, invalid input rejection, pre-commit abort, progress-triggered post-commit abort, atomic move completion, filesystem/result agreement, zero leaked mutation queues, and zero temp artifacts. It does not call a paid model or use a live profile.

## Explicit remaining parity work

- Hooks, permission-system, and bash-timeout now live in the separate runtime-only
  `tool-policy` feature so root can interleave each factory at its correct global position. The implemented
  execution contract and remaining discovery/trust/UI edges are tracked in [tool-policy.md](./tool-policy.md).
- `apply_patch`'s execution semantics are present, but the Senpi-specific rich TUI streaming parser, per-file diff preview/render-state cache, and bounded persisted preview patch are not. Results currently carry operation/fuzz/recovery metadata and text progress, not that richer display. This is the remaining UI closure, not an execution fallback.
- Loop notices use ordinary custom-message rendering until the Senpi notice-card renderer is ported. Blocking, messages, wake/hold events and abort semantics are active; only the specialized visual treatment is missing.
