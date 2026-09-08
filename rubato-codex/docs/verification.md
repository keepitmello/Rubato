# Verification — 2026-09-08

## Reproducible package checks

On macOS with Node 26.5 and native Codex CLI 0.153.4:

```sh
RUBATO_CODEX_NATIVE_E2E=1 npm test
```

- Package/install/provider/skill checks: 34 passed, no skips.
- Taskforce board, concurrent CLI, real SDK MCP and standalone bundle: 11 passed.
- Skills, native roles and standalone MCP bundle freshness: passed.
- Native isolated plugin install/refresh/uninstall: passed; board data preserved.
- Model-guide frontmatter validation and independent policy review: passed.

## Local installation evidence

- Refreshed plugin, three model-free native roles and managed global lead block.
- Selected providers: anthropic, cursor, xai. Selection is a routing policy,
  not a restriction on other clients of the shared OpenCodex proxy.
- Native prompt inspection discovered 27 top-level skills plus Outpost's nested
  `chatgpt-work-outpost` skill; no duplicate unprefixed bundled skills remained.
- Duplicate global skills are disabled through managed configuration.
  Three old Codex orchestration symlinks were subsequently archived outside
  skill discovery; shared skill directories and their receiving contracts remain.
- Existing lead model, reasoning effort, service tier and permissions were
  unchanged. No proxy or active app-server was restarted.
- One native Codex exec smoke using `xai/grok-4.6` returned the requested marker.
  This proves that routed execution path, not every provider or child-agent path.

## Remaining runtime boundaries

The Rubato/shared taskforce no longer carries Codex adapters or a Codex role
generator. Its taskforce and dispatching changes were mirrored from the live
canonical shared skills into `harness/skills`; the Rubato model-guide was not
changed. Codex taskforce support documents are now independently owned instead
of overwritten by common-skill regeneration. A temporary-fixture regression
checks that rebuilding cannot overwrite their entrypoints or operating-model
references. Rubato's five existing skill-installer tests also pass.

- OpenCodex 2.43 allows five native subagent candidates. The saved roster was
  read back correctly; already-running app-server catalogs can remain stale.
  A newly installed policy cannot change a currently exposed tool schema.
- The local default roster uses Sol, Cursor Fable, Cursor Opus, xAI Grok and
  Cursor Gemini Flash. Astra requires approval and a candidate slot change;
  this does not change the user-selected lead.
- Anthropic direct was registered, but the first browser OAuth attempt failed.
  The public status did not disclose the underlying cause. No success or
  account identity is inferred, and Rubato's existing setup-token was preserved.
- Live browser/Aside/Outpost workflows and all external model child calls were
  not exercised by the package tests. Bundling resources does not authenticate
  or install their external services.
