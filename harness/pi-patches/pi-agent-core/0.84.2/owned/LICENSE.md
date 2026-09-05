# Owned overlay — provenance

`dist/empty-assistant-recovery.js` is a license-preserved copy of the MIT
fork-only module from `@earendil-works/pi-agent-core@2026.9.4-3` (senpi nested),
with Rubato liveness needles already baked (`hasPendingLocalWork` while thinking
is buffered).

Stock `@earendil-works/pi-agent-core@0.84.2` does not ship this file.
`empty-assistant-recovery-export.patch` re-exports it from `dist/stream-fn.js`.

Session/agent-loop wrapping (`withEmptyAssistantRecovery(model, streamFn)`) is a
hook for the session owner — this overlay does not patch `agent-loop.js`.
