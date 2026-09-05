# Owned overlay — provenance

These files are **license-preserved source deltas** from the MIT-licensed Senpi
nested copy of `@earendil-works/pi-ai@2026.9.4-3` (declared name
`@earendil-works/pi-ai`, content-identical to `@code-yeongyu/senpi-ai@2026.9.4-3`
except `package.json` name). They are **not** present in stock
`@earendil-works/pi-ai@0.84.2`.

Upstream stock: `@earendil-works/pi-ai@0.84.2`, MIT, author Mario Zechner.
Fork source: `@code-yeongyu/senpi@2026.9.4-3` nested `node_modules/@earendil-works/pi-ai`, MIT.

Not a wholesale Senpi package rename. Copy these paths onto a patched stock
0.84.2 pi-ai tree after the unified diffs in this directory.

`dist/api/cursor-read-image.js` is Rubato-owned (same function as
`harness/rubato-pi/src/transforms/cursor-read-image.mjs`).

`dist/utils/empty-recovery-gate.js` is a MIT extract of
`getToolCallFormat` / `shouldRecoverTextToolCalls` from fork
`dist/tool-call-middleware/index.js` — not the middleware tree.

Cursor `dist/api/cursor-agent.js` and `dist/api/cursor-conversation-rotation.js`
have Rubato needles already baked (checkpoint pin, rotation `forget`, read-image).
