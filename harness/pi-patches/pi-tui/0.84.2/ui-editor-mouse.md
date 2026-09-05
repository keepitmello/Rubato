# ui-editor-mouse.patch — composer select/drag/copy

## What

Ports Rubato `editor-mouse.mjs` onto stock Editor + `TuiAltScreen`:
`handleMouse` / `getMouseSelectedText` / `copyMouseSelection` on Editor,
`routeFocusedMouseEvent` on the alt screen. Marker comments
`rubato.editorMouse.injected` and `rubato.editorMouse.routingInjected` so
existing chrome no-ops on the patched files.

Must apply **after** `ui-editor-markers.patch` (both touch `editor.js`).
Anchors: class field `snappedFromCursorCol = null`, `handleInput` /
`layoutText`, `handleRightClickPaste`.

Stock already has `copySelection` and `flash` on `TuiAltScreen` (A6
fullscreen/raw restore is stock — not in this patch).

## Provenance

Rubato-authored mouse chrome, MIT-compatible, no new dependency.
`decodePrintableKey`, `visibleWidth`, `sliceByColumn`, `matchesKey` are
stock.

## Apply order

See `ui-editor-markers.md`. Overlaps `editor.js` with markers: mouse is
second.
