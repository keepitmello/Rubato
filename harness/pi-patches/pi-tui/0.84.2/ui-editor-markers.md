# ui-editor-markers.patch — paste registry + image markers

## What

Carries the Senpi paste-registry and image-marker editor APIs onto stock
`@earendil-works/pi-tui@0.84.2`. New files `dist/paste-markers.js` and
`dist/image-markers.js` (MIT fork-only). `dist/components/editor.js` keeps
the stock Editor class and gains `pasteMarkers` / `imageMarkers` plus
`getPasteState` / `setPasteState` / `insertImageMarker` /
`expandMatchingPaste`.

Upstream terminal/editor implementation is otherwise preserved.

## Provenance

- Stock: `@earendil-works/pi-tui@0.84.2`, MIT.
- Delta: `@code-yeongyu/senpi-tui@2026.9.4-3` MIT (`paste-markers.js`,
  `image-markers.js`, editor registry methods). `expandMatchingPaste` is the
  existing Rubato chrome from `harness/rubato-pi/src/paste-expand.mjs`
  (marker `rubato.pasteExpand.injected` so that chrome no-ops on the patched
  file).
- Production consumers: `paste-expand.mjs`, `editor-paste-transfer.js`,
  `busy-enter.mjs` (`setImageMarkerState` / `pendingImages`).

## Apply order (pi-tui 0.84.2)

1. `unicode-input.patch` (`dist/stdin-buffer.js` only — no overlap)
2. **this patch** (`paste-markers.js`, `image-markers.js`, `editor.js`)
3. `ui-editor-mouse.patch` (editor.js + tui-alt-screen.js)
4. `ui-capabilities.patch` (new tmux/capability files + index.js + terminal-image.js)

```
patch -p1 --fuzz=0 --batch --forward -i ui-editor-markers.patch
```

Lead owns `manifest.json` / applicator; do not add this id without a
postimage SHA.

## License

MIT-to-MIT. NOTICE addition is required at the isolated root
`THIRD-PARTY-NOTICES.md` (lead-owned).
