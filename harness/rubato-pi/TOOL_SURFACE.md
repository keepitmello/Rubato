# Small default tool surface

Rubato starts with `read`, `bash`, `apply_patch`, `todo`, and `tool_search`.
Other capabilities stay registered and are found through `tool_search`; once
activated, they are called directly. This is not a return to eval-only routing.
Explicit SDK base-tool overrides retain their own contract.

## Ownership and preserved behavior

- `src/tool-surface-policy.mjs` sets default exposure, not execution. Schemas,
  argument validation, permission hooks and execution remain with the engine.
- `src/transforms/core-tool-surface.mjs` connects the policy to registry
  construction and keeps `edit`/`write` off the model-facing surface. Their
  backends remain available to the native Cursor exec bridge.
- `apply_patch` creates, edits, renames and deletes files on every model family.
  Only GPT models on supported Responses APIs use freeform grammar transport.
  Other models, including xAI Responses, use the existing JSON variant.
  xAI rejects the `custom` tool type, so API name alone is not sufficient.
- MCP uses its own search feeder, including proxy/resource tools. Server
  filtering and execution remain intact, but eager/direct and placeholder-stub
  exposure no longer populate the initial model tool list. Discovered tools
  survive catalog refresh; withdrawn registrations cannot be rediscovered
  through a duplicate extension catalog.
- Terminal companions do not activate eagerly. Notes and media tools retain
  their mode/model admission gates and become searchable only when admitted.
  Explicitly entering workflows such as scheduled loops can still activate the
  tools those workflows need.
- Tool-search activation markers retain the engine's registration ownership
  checks on resume. No new registry, search engine or configuration file is added.

## Short descriptions, full search text

`src/tool-description-slim.mjs` rewrites selected model-facing descriptions at
the engine's definition wrapper. Original catalog descriptions and parameter
schemas stay intact, so search does not lose vocabulary and call shapes do not
change. Unknown tool names are unchanged.

Eval stays with its dynamic template in `src/codemode/prompt/eval-prompt.ts`;
the wrapper does not replace it with a static description. Host, available
languages/helpers, Python event-loop rules, optional spawn helpers and detached
cell handling remain conditional and accurate.

`src/system-prompt.mjs` now names one editing tool and explains discovery.
The duplicate editing/memory/todo instructions and verbose terminal tutorial
were reduced; patch verification is no longer contradicted by a “do not
re-read” tool guideline.

## Measurement limits

A same-session sample of 53 named tool JSON schemas, counted separately with
`o200k_base`, measured 12,283 tokens before the change. Selecting the five core
tools and applying the short descriptions gives 910 tokens in that same
representation. With all 53 still selected, description changes alone give
10,518 tokens (this comparison does not include the separate eval-template
reduction). Extra shared tool guidance fell from 250 to 86 tokens.

These are **not full provider-request counts**: the tool-schema introspection
sample omits freeform grammar and provider wrappers, and the estimate excludes
skills, role prompts, messages and images. It is not evidence of task accuracy,
latency or billing improvement. First-use discovery adds a tool round; once
activated, definitions remain in the session rather than being evicted each turn.

## Verification

Run from `harness/rubato-pi`:

```sh
node --import ./src/no-changelog-register.mjs --test --test-concurrency=1 \
  test/unit/tool-surface.test.mjs \
  test/unit/tool-description-slim.test.mjs \
  test/unit/terminal-routing-prompt.test.mjs \
  test/unit/system-prompt.test.mjs \
  test/unit/eval-prompt.test.mjs \
  test/unit/eval-only-direct-tools.test.mjs \
  test/unit/tool-context-integration.test.mjs \
  test/unit/context-notes-dual-mode.test.mjs \
  test/unit/context-notes-extension.test.mjs \
  test/unit/installed-engine-transforms.test.mjs \
  test/unit/prompt-drift.test.mjs \
  test/unit/adapter-contract.test.mjs
```

Tests use the installed, transformed engine without paid model requests:
registry/search activation, direct execution and permission denial, refresh and
history restoration, MCP admission/withdrawal, notes/media gates, patch file
operations and model switches, dynamic eval contracts, and transform drift.

The changes load in new engine processes; the current session's advertised
schemas are not rewritten retroactively. Installed package files and global
profile configuration are not edited.

Final local run: 74 passed, 0 failed, exit code 0. Nine changed JavaScript
source files also passed `node --check`. Node emitted the existing DEP0205
loader deprecation warning.

LSP diagnostics were unavailable (daemon unreachable after two attempts).
Independent review did not complete: the first xAI attempt exposed the
freeform-transport bug now covered by the model-switch test; the retry reached
code inspection but failed in the credential store (`openSync is not defined`).
That credential-store failure is outside this change. No full task-quality or
latency benchmark, full-suite build, or completed independent review is claimed.
