# A15 product TUI transform classification

Stock verified: `@earendil-works/pi-coding-agent@0.85.1` + nested `@earendil-works/pi-tui@0.85.1`.
Product: `harness/rubato-pi/src` plus Senpi `2026.9.4-3` fork (unicode/images substrate).
0906 UI manifest treated as stale lead only. No PTY started.

Owner decides what to port. This table is classification evidence, not an implementation list.

## Table

| name | product path | stock equivalent | classification | why | citation |
|---|---|---|---|---|---|
| unicode stdin decode (A1) | Senpi nested pi-tui stdin-buffer.js (StringDecoder); A15 extract features/tui-input/patches.mjs | pi-tui@0.85.1 dist/stdin-buffer.js — no StringDecoder | [must port: functional] | Hangul/emoji split across stdin chunks become U+FFFD; daily Korean typing depends on this | product senpi stdin-buffer.js:19,237; stock stdin-buffer.js:256 data.toString(); patches.mjs:11-19 |
| clipboard images (A3) | Senpi interactive-mode.js insertImageMarker+pendingImages; A15 features/tui-input/images.mjs | dist/modes/interactive/interactive-mode.js temp path | [must port: functional] | Stock pastes a pi-clipboard-*.png path, not ImageContent; screenshot paste would send a filename | senpi interactive-mode.js:398-427,3206-3208; stock interactive-mode.js:2312-2344; images.mjs:7-8,41-48 |
| select cancel ([G]) | features/tui-input/cancel.mjs (docs only) | tui.select.cancel = Esc+Ctrl-C, onCancel() no value | [stock already] | 0906 [G] is settled in 0.85.1: dismiss overlay, no selected value | cancel.mjs:1-3; keybindings.d.ts:178-180; select-list.js:124-127; docs/keybindings.md:85 |
| busy-enter | harness/rubato-pi/src/busy-enter.mjs | Enter-while-streaming is steer; follow-up is a separate binding | [must port: functional] | Daily Enter queues follow-up (Enter 한 번 더), not steer. Product-only | busy-enter.mjs:40-41,48-50; stock interactive-mode.js:2530-2535,673 |
| editor-mouse | harness/rubato-pi/src/editor-mouse.mjs | Editor click-to-cursor + alt-screen copyOnSelect | [stock already] | Stock already click-places cursor; drag/release copies at screen level. Product in-editor selection is a parallel model | editor-mouse.mjs:20,83-91; stock editor.js:483-540,502-505; tui-alt-screen.d.ts:23-24; tui-alt-screen.js:101 |
| collapsible-mouse | harness/rubato-pi/src/collapsible-mouse.mjs | Thinking/tools already wrap MouseRegion | [stock already] | OSC-8 hyperlink overlay is the old click path; 0.85.1 toggles thinking/tools by mouse already | collapsible-mouse.mjs:35-52,54-67; stock assistant-message.js:120-128; tool-execution.js:108-114 |
| paste-expand | harness/rubato-pi/src/paste-expand.mjs | Editor this.pastes + expandPasteMarkers on submit | [stock already] | Large paste markers and submit expansion are complete in stock. Product pasteMarkers registry is senpi-shaped and would not even match stock needles | paste-expand.mjs:4-18,66-75; stock editor.js:896-909,1047-1094,1137 |
| statusline | harness/rubato-pi/src/statusline.mjs | FooterComponent pwd/tokens/git/model | [decoration: skip] | Brand watermark, short labels, speed-index are chrome. Stock footer already shows model, tokens, branch | statusline.mjs:34-42,461-475; stock footer.js:44-47,102-105,153-154 |
| rubato-footer | harness/rubato-pi/src/rubato-footer.mjs | same FooterComponent assignment | [decoration: skip] | Load rewrite that swaps stock footer for statusline | rubato-footer.mjs:1-12,22-32 |
| interactive-control-surface | harness/rubato-pi/src/interactive-control-surface.mjs | absent (submitInput not in stock) | [decoration: skip] | Remote action dispatcher (A16). Local TUI user does not go through this | interactive-control-surface.mjs:54-66 |
| control-interactive-mode | harness/rubato-pi/src/transforms/control-interactive-mode.mjs | absent | [decoration: skip] | Injects createInteractiveControlSurface / remote UI-request bridge. A16, not local input | control-interactive-mode.mjs:8-11 |
| control-slash-commands | harness/rubato-pi/src/transforms/control-slash-commands.mjs | stock slash list without remoteMode | [decoration: skip] | Only tags remoteMode for A16. Local slash already works | control-slash-commands.mjs:38-49 |
| tui-chrome (cluster) | harness/rubato-pi/src/transforms/tui-chrome.mjs | n/a dispatcher | [decoration: skip] | Cluster applicator only; children classified below | tui-chrome.mjs:1-5,20-26 |
| interactive-mode-chrome | harness/rubato-pi/src/transforms/interactive-mode-chrome.mjs | stock interactive-mode.js has no tool-group/turn-work wiring | [must port: functional] | Wires grouping, turn-work, working-phase, abort-once. Hidden-slash filter is extra decoration inside the same file | interactive-mode-chrome.mjs:18-36 |
| tool-group-component | harness/rubato-pi/src/transforms/tool-group-component.mjs | absent | [must port: functional] | Daily tool collapse/group (skill/git vs todo). Stock lists each tool raw | tool-group-component.mjs:1-22 |
| turn-work-summary | harness/rubato-pi/src/transforms/turn-work-summary.mjs | absent | [must port: functional] | Per-turn thinking/tool summary the daily user reads after each turn | turn-work-summary.mjs:1-8 |
| working-phase | harness/rubato-pi/src/transforms/working-phase.mjs | WorkingStatusIndicator stays Working until idle | [must port: functional] | Distinguishes Thinking vs Working and clears the dock on agent_end (stock lingers through settle) | working-phase.mjs:1-6,22-36,44-48; stock interactive-mode.js:1657-1661 |
| assistant-message | harness/rubato-pi/src/transforms/assistant-message.mjs | stock AssistantMessageComponent + MouseRegion | [must port: functional] | Click-to-toggle thinking is stock; this file also owns turn-work collapse / per-run hide / progress hide the chrome needs | assistant-message.mjs:11-14,32-48; stock assistant-message.js:120-128 |
| assistant-descriptors | harness/rubato-pi/src/transforms/assistant-descriptors.mjs | absent (assistant-render-descriptors.js not in stock) | [must port: functional] | Per-run thinking hide, ellipsis filler skip, abort-once. Senpi-only module | assistant-descriptors.mjs:3-8,14-16 |
| assistant-phase | harness/rubato-pi/src/transforms/assistant-phase.mjs | absent | [must port: functional] | Classifies progress vs answer text for turn-work/descriptors | assistant-phase.mjs:1-6 |
| core-descriptors | harness/rubato-pi/src/transforms/core-descriptors.mjs | absent | [must port: functional] | Import rewrite so descriptors see Rubato phase helper | core-descriptors.mjs:1-4 |
| tool-execution | harness/rubato-pi/src/transforms/tool-execution.mjs | stock tool-execution.js + MouseRegion expand | [must port: functional] | Always-expand todo/task and collapsed first-line chrome. Click-expand itself is stock | tool-execution.mjs:11-12; stock tool-execution.js:108-114 |
| internal-actions | harness/rubato-pi/src/transforms/internal-actions.mjs | stock MouseRegion is the click primitive | [must port: functional] | OSC-8 action bus grouping/turn-work still call; can be rewritten onto MouseRegion but those components need a click owner | internal-actions.mjs:1-11,12-21 |
| transcript-cache | harness/rubato-pi/src/transforms/transcript-cache.mjs | absent (no ProgressiveTranscriptContainer) | [must port: functional] | Long /resume first-paint: stock paints every message before first frame | transcript-cache.mjs:3-5 |
| misc-tui-autocomplete | harness/rubato-pi/src/transforms/misc-tui-autocomplete.mjs | slash menu first-line only; no dollar-invocation module | [must port: functional] | Mid-line /skill: and $skill autocomplete. Stock isSlashMenuAllowed is cursorLine===0 | misc-tui-autocomplete.mjs:74-90,98-103; stock editor.js:1017,1831-1834 |
| misc-model-selector | harness/rubato-pi/src/transforms/misc-model-selector.mjs | stock components/model-selector.js alpha-by-provider | [must port: functional] | Daily model picker: Rubato provider grouping + Sol-first order + display labels | misc-model-selector.mjs:3-15 |
| misc-thinking-levels | transforms/misc-thinking-levels.mjs + src/thinking-levels.mjs | pi-ai dist/models.js getSupportedThinkingLevels includes off/minimal | [must port: functional] | Shift+Tab cycle must skip off/minimal for Rubato models | misc-thinking-levels.mjs:21-32; thinking-levels.mjs:1-11; stock models.js:551-562 |
| title-guard | harness/rubato-pi/src/title-guard.mjs | ProcessTerminal.setTitle always writes OSC 0 | [must port: functional] | Streaming tools re-emit the same title; tab flickers | title-guard.mjs:1-11,23-36; stock terminal.js:432-435 |
| core-session-list-page | transforms/core-session-list-page.mjs + src/session-list-page.mjs | SessionManager.listSessionsFromDir loads every jsonl | [must port: functional] | /resume picker pages newest-first (12). Stock reads all sessions before the list appears | session-list-page.mjs:1-8; core-session-list-page.mjs:1-4; stock session-manager.js:550 |
| boot-perf (cluster) | harness/rubato-pi/src/transforms/boot-perf.mjs | n/a dispatcher | [decoration: skip] | Defers unused imports for first paint. TUI still works without it | boot-perf.mjs:1-2,23-32 |
| boot-interactive-defer | harness/rubato-pi/src/transforms/boot-interactive-defer.mjs | stock static imports of interactive components | [decoration: skip] | Lazy-loads dialogs/components. Behavior unchanged, only boot graph | boot-interactive-defer.mjs:3-8 |
| boot-main-defer | harness/rubato-pi/src/transforms/boot-main-defer.mjs | stock main.js | [decoration: skip] | Defers CLI modules off first paint | boot-main-defer.mjs |
| boot-loader-defer | harness/rubato-pi/src/transforms/boot-loader-defer.mjs | stock extensions/loader.js | [decoration: skip] | Defers heavy extension bundles | boot-loader-defer.mjs |
| boot-catalog-slim | harness/rubato-pi/src/transforms/boot-catalog-slim.mjs | stock model-runtime/auth-storage | [decoration: skip] | Slim catalog at boot, not input/display | boot-catalog-slim.mjs |
| boot-agent-session-export | harness/rubato-pi/src/transforms/boot-agent-session-export.mjs | stock agent-session.js | [decoration: skip] | Defers export-html off boot | boot-agent-session-export.mjs |
| boot-chrome / splash | src/boot-chrome.mjs, boot-splash.mjs, boot-resonance.mjs, boot-worker.mjs | absent | [decoration: skip] | Branded alt-screen intro. Daily chat does not depend on it | boot-chrome.mjs:1-12; boot-splash.mjs:1-8 |
| misc-high-reasoning | harness/rubato-pi/src/transforms/misc-high-reasoning.mjs | absent (no high-reasoning-warning.js in stock 0.85.1) | [decoration: skip] | Forces shouldWarnHighReasoning false. Warning suppression, not input | misc-high-reasoning.mjs:8-16 |
| core-error-format | harness/rubato-pi/src/transforms/core-error-format.mjs | absent (senpi extension-error-format.js) | [decoration: skip] | English stall-error wording only; errors still render without it | core-error-format.mjs:3-14 |

## Inspected, not TUI/input/display (dropped)

These look adjacent but are runtime/provider/compaction/remote. Not classified as daily TUI transforms:

- `core-compaction*`, `core-lane-policy`, `core-overflow`, `core-empty-recovery`, `core-retry-watchdog`, `core-stream-watchdog`, `core-speculative`, `core-routine-settings`, `core-service-tier`, `core-session-persist`, `core-session-resume-budget`, `core-agent-session`, `core-messages`, `core-tool-surface`, `core-tool-descriptions`, `core-context-notes`, `core-terminal-routing` — compaction/session/tools, not compositor input
- `cursor-*` — Cursor exec/vendor, not TUI
- `misc-anthropic-compaction`, `misc-astra-codex`, `misc-auth-storage`, `misc-claude-code-version`, `misc-codex-ws-cache-ttl`, `misc-google-input-guard`, `misc-pi-ai-lazy`, `misc-prompt-cache-ttl`, `misc-session-date`, `misc-adaptive-tool-turn-effort` — provider/API
- `control-codemode*`, `control-extensions` — control-plane, not daily TUI
- `request-run-tracker` — timeline tracker referenced by chrome hrefs, does not paint
- `remap-hidden-custom-turns` — LLM message remap
- `skills-section.mjs` — system-prompt skill listing, not the TUI
- Frozen (not edit targets, not TUI rows): `transforms/core-session.mjs`, `transforms/core-prompt-noise.mjs`, `prompt-noise.test.mjs`

## Stale 0906 leads vs 0.85.1

| lead | 0906 claim | 0.85.1 result |
|---|---|---|
| A1 unicode | stock lacks StringDecoder | still true — must port |
| A3 images | stock has no editor image markers | still true — clipboard is a temp path — must port |
| A2 paste | stock partial; registry N | stock paste is complete (pastes+expandPasteMarkers) — skip port |
| A5 mouse | N in both cores | stock now has editor click-to-cursor, copyOnSelect, MouseRegion on thinking/tools — skip those product overlays |
| [G] cancel | contract decision, no port either side | stock Esc+Ctrl-C, onCancel() with no value — stock already |

## Counts

| classification | rows |
|---|---|
| [must port: functional] | 19 |
| [stock already] | 4 |
| [decoration: skip] | 15 |
| **table total** | **38** |

Plus the dropped non-TUI files above (not in the table).

## [must port: functional] list

1. unicode stdin decode (A1)
2. clipboard images (A3)
3. busy-enter
4. interactive-mode-chrome
5. tool-group-component
6. turn-work-summary
7. working-phase
8. assistant-message
9. assistant-descriptors
10. assistant-phase
11. core-descriptors
12. tool-execution
13. internal-actions
14. transcript-cache
15. misc-tui-autocomplete
16. misc-model-selector
17. misc-thinking-levels
18. title-guard
19. core-session-list-page

## Frozen items touched

None. Did not read-as-edit or write `core-session.mjs`, `core-prompt-noise.mjs`, or `prompt-noise.test.mjs`.

