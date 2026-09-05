# ui-modules.patch — Senpi-only UI source artifacts

## What

Adds production-reachable Senpi-only interactive UI modules as **new
files** under `dist/modes/interactive/` onto stock
`@earendil-works/pi-coding-agent@0.84.2`. Does not modify existing stock
files. MIT-to-MIT copies from `@code-yeongyu/senpi@2026.9.4-3` plus
Rubato-authored `components/tool-group.js` and `internal-actions.js`.

Does **not** copy `grok/`, `tips/`, or `assets/` (uncovered this slice).

## Apply order (pi-coding-agent 0.84.2)

1. `reload-guard.patch`
2. `reload-ui.patch` (`interactive-mode.js` `handleReloadCommand` only)
3. **this patch** (new files only — no overlap with reload-ui)
4. `ui-interactive.patch` (`interactive-mode.js` UI wiring; AFTER reload-ui)

`memory-lifecycle.patch` (other worker) touches `agent-session.js` —
no overlap.

## Modules that import other-owner files (hooks for lead)

| Module | Missing stock import | Owner |
|---|---|---|
| `interactive-stderr-guard.js` | `../../core/sensitive-output.js` | session/core worker |
| `components/assistant-render-descriptors.js` | `../../provider-native-rendering.js` | provider worker |
| `tool-args-reveal.js` | `@earendil-works/pi-ai` | provider worker |

Those files are shipped so importers exist; they are not loaded by
`ui-interactive.patch` until the missing modules land.

## License

MIT-to-MIT. NOTICE addition required (lead-owned root notices).
