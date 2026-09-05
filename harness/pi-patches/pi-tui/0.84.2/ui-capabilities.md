# ui-capabilities.patch — tmux/kitty capability overrides

## What

Adds fork-only files (MIT):

- `dist/terminal-capabilities.js` (`outerKittyGraphicsMode`)
- `dist/terminal-text.js` (`sanitizeTerminalLabel`)
- `dist/tmux-image-capability.js`, `tmux-image-probe.js`, `tmux-focus.js`, `mux.js`

Additive APIs on stock `dist/terminal-image.js` (does **not** replace
stock `detectCapabilities`): `setCapabilityOverrides`,
`wrapTmuxPassthrough`, re-export `outerKittyGraphicsMode`.

`dist/index.js` re-exports those plus `expandPasteMarkers`,
`ImageMarkerRegistry`, `getGraphemeSegmenter` (required by
`streaming-reveal-content.js`).

## Apply order

After `ui-editor-mouse.patch`. No overlap with `unicode-input.patch`.

## Public hooks returned to lead

`getGraphemeSegmenter` must stay exported from `@earendil-works/pi-tui`.
Interactive-mode imports `outerKittyGraphicsMode`,
`setCapabilityOverrides`, `sanitizeTerminalLabel` from that package
(see `ui-interactive.patch`).
