# Prompt, rules, and todo migration slice

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

Status: a bounded additive slice is implemented and tested on freshly staged stock
Pi 0.85.1. This is not parity for the four Senpi builtin registrations. In
particular, the model-specific `prompt-preset` builtin remains pending and the
feature must not be promoted to full parity in the inventory.

## Source contract

The behavior reference is `@code-yeongyu/senpi` 2026.9.4-3 from the preserved
product checkout. Primary installed entry hashes are:

| Builtin entry | SHA-256 |
|---|---|
| `nested-agents-md/index.js` | `fbc7e246be3c7e012315782a13cc19b0e9b40311e8f92879d3b7ebfd6f2e100e` |
| `rules/index.js` | `6164351380890bbb76b5bc3cd7883a81fcc2b64bf9c7500e4a613ddeb6c8d7a0` |
| `prompt-preset/index.js` | `7e85d04208152168e63e1fab56b8471a22de5177732c5e55330aa8b2a9782a61` |
| `todotools/index.js` | `9e3568778105dcc736af23107e073779a68bca180a1a05a34224e965f9b0b4ff` |
| `todotools/tools/todo.js` | `a0a6ac0f1d201be10bc0360b37e79962398792458b28c270e5a68e590529b874` |

The implementation is owned under
`harness/pi-runtime/features/prompt-rules/`. Its descriptor is
`{ id: "prompt-rules", patches: [], files }`; all staged files live under
`rubato-features/prompt-rules/`. There is no stock-file adapter in this slice,
so no patch preimage applies. Stock version admission remains `0.85.1` through
the common stager. The only non-Node import is the standalone runtime's existing
direct `typebox@1.3.18` dependency.

`createPromptRulesExtensionFactories({ settingsManager, env })` is the root
assembly API. It consumes the canonical SettingsManager supplied by the stock
runtime factory callback and returns two named inline factories. It never
constructs another settings service, imports Senpi, or reads the original
checkout at runtime.

## Implemented behavior

- Stock Pi remains the owner of startup context discovery. A root `AGENTS.md`
  already present in `systemPromptOptions.contextFiles` is not duplicated by
  the rules block.
- A successful `read` below the session cwd walks from the root toward the
  target directory, selects one exact `AGENTS.md` per directory, enforces
  realpath containment, caps each file at 32 KiB and one read at 128 KiB, and
  injects each directory once per live session. `--no-nested-agents` disables
  this path.
- Static and dynamic rules cover the current project markers, project rule
  directories, project single files, and user-home rule locations. Static
  `alwaysApply` rules extend the system prompt. `read`, `edit`, and `write`
  results inject matching dynamic rules. `globs`, `paths`, `applyTo`, negative
  patterns, project/scope-relative paths, deterministic source priority,
  per-rule/result limits, `PI_RULES_DISABLED`, `PI_RULES_MAX_*`,
  `--pi-rules-disabled`, and `--pi-rules-mode` are wired. Dynamic content hashes
  prevent repeats while allowing a changed rule to reappear.
- Instruction caches reset on stock `session_start`, successful
  `session_compact`, and `session_shutdown`. A real stock reload tears down and
  recreates the extensions; the test changes a nested `AGENTS.md` and a glob
  rule, reloads, then observes both new bodies in the next provider context.
- The current singular `todo` tool supports phased `init`, `start`, `done`,
  `drop`, `append`, `rm`, and read-only `view`. It uses exact task/phase text,
  keeps at most one in-progress task, advances to the earliest open task, and
  persists the current snapshot as `senpi.todo-state` schema v2. Startup and
  tree navigation restore the newest branch snapshot. The reader also accepts
  legacy `todowrite` result details and maps unknown legacy statuses to pending.
  Its tool snippet/guidelines and task-management system-prompt block are active.

## Actual stock evidence

Run from `harness/pi-runtime` with Node options removed:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=45000 \
  features/prompt-rules/prompt-rules.test.mjs
```

Result on Node 26.5.0: **4 tests passed, 0 failed, 0 skipped**. Each test stages a
new runtime through `stagePiRuntime`, resolves it through `resolvePiRuntime`, and
imports the staged stock SDK. The behavior tests use a local in-process provider
stream, not a registration-only fake:

1. the first provider request consumes stock root context plus the static rule;
2. a real stock `read` tool result carries nested `AGENTS.md` and its matching
   TypeScript rule into the second provider request;
3. real extension flags remove optional rule/nested additions without removing
   stock root context or todo prompt behavior;
4. real `todo` calls append two `senpi.todo-state` snapshots, persist the stock
   session file, and restore the exact phase/task statuses after stock extension
   reload; `view` appends no state.

The closure test also checks every descriptor source exists, every added path is
inside the owned namespace, each staged JavaScript file passes `node --check`,
and the staged third-party notice contains the MIT terms.

## Deliberately still pending

- `prompt-preset`: all current model resolution rules and model-specific prompt
  builders, explicit user-system-prompt precedence, append preservation, header,
  and model-switch behavior. Stock 0.85.1 does not consume Senpi's
  model-select prompt return shape, so this needs a separate narrow adapter and
  rendered prompt corpus rather than a partial generic replacement.
- Rules: Senpi's activation custom-entry renderer, full diagnostics, exact
  picomatch edge-case parity, dynamic target stat fingerprints/LRU caches, and
  direct tests for every home/ancestor source. The common paths above are
  implemented; these edges are not claimed.
- Todo: fuzzy argument repair, `/todo` editor/import/export, native Cursor todo
  mirroring, sidebar widget, and custom TUI render/animation. The tool/state and
  provider-prompt lifecycle above are implemented; those UI/compatibility edges
  are not claimed.
- Root catalog/bootstrap wiring and candidate CLI composition remain root-owned.
  Until that wiring and the pending pieces are integrated and retested, the
  builtin inventory entries stay `pending-contract-and-parity`.

`THIRD_PARTY_NOTICES.md` records the MIT license and Senpi/pi-mono/oh-my-pi
attribution used by this derived slice. The installed Senpi package declares
MIT but omits its root license file; the full text is cross-checked against the
same-release Senpi codemode package, matching the repository's existing notice
practice.


## A9 note (2026-09-11)

`rubato-prompt-preset` is a separately toggleable factory. Stock 0.85.1 consumes
`before_agent_start.systemPrompt` and ignores Senpi `model_select` prompt returns, so
the factory uses the public start hook only (no Pi patch). A completed role prompt
passed as loader/`--system-prompt` `customPrompt` still outranks the preset body.
