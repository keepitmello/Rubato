# ui-interactive.patch — InteractiveMode UI wiring

## What

Surgical hunks on stock `dist/modes/interactive/interactive-mode.js`
**after** `reload-ui.patch`. Preserves stock InteractiveMode,
`setCustomEditorComponent`, `resetExtensionUI`, resume/cancel selectors.
Adds:

- paste transfer on editor swap (`transferEditorContent`)
- clipboard image attach via `insertImageMarker` + `pendingImages`
- `StreamingRevealController` on assistant `message_start` / `message_update`
- `ProgressiveTranscriptContainer` as `chatContainer` (resume first-paint)
- `attachToolComponent` / `ToolGroupComponent` grouping
- imports for shortcut overlay, tmux warning, working-status, capability APIs

Does **not** replace stock `handleReloadCommand` (reload-ui). Does **not**
touch RPC / session / extension runner.

## Apply order / overlapping anchors

reload-ui hunks: `handleReloadCommand` only.
This patch anchors:

- tui import line (adds `outerKittyGraphicsMode`, `setCapabilityOverrides`,
  `sanitizeTerminalLabel`)
- `this.chatContainer = new Container();`
- `handleClipboardPaste` image temp-file branch
- `setCustomEditorComponent` `currentText` / `setText` copies
- assistant `message_start` / `message_update` streaming
- `this.chatContainer.addChild(component)` in the tool-call loop
- method insert immediately before `setCustomEditorComponent(factory)`

If another worker inserts above `setCustomEditorComponent`, recut this
patch; do not widen fuzz. Lead rebases headers.

## Default / custom editor, cancel, resume

Stock `setCustomEditorComponent(undefined)` still restores
`defaultEditor`. This patch only wraps the text copy with
`transferEditorContent` so paste/image markers survive the swap.
`resetExtensionUI` still calls `setCustomEditorComponent(undefined)`.
`showExtensionSelector` still resolves `undefined` on abort
(cancel-without-value). Resume remains stock `showSessionSelector` /
`/resume`.

This hunk now also wires `startTurnWorkSummary` to `TurnWorkSummaryComponent`,
`subscribeImageMarkers` (snapshot/restore) on the default editor and on swap,
shortcut overlay show/hide on editor `onChange`, GrokChrome/`WorkingTipCache`
at construct, and `createInteractiveControlSurface` / `respondToUiRequest`.

## Remaining UI wiring

- Footer layout / rubato-footer chrome still live in
  `harness/rubato-pi/src/rubato-footer.mjs`
- Compaction-queue transfer call sites (module present, not imported here)
- Startup tip header (`appendStartupHeader` / `resolveStartupTipLine`) not
  inserted on stock changelog path this slice
- Theme JSON `grok-day.json` / `grok-night.json` (loaded by senpi theme.js,
  not by grok chrome JS) — provider/theme owner if stock theme.js is recut
