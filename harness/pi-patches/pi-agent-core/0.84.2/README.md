# pi-agent-core 0.84.2 empty recovery + local-work watchdog

Stock: `@earendil-works/pi-agent-core@0.84.2` MIT.

Does **not** copy fork `agent-loop.js`. Does **not** touch abort provenance,
removed-tool hints, `assistant-terminal-state.js`, or Cursor exec tool-result
splicing (session owner).

## Order

1. Copy `owned/dist/empty-assistant-recovery.js` (`sha256: null`)
2. `empty-assistant-recovery-export.patch` — `dist/stream-fn.js`
3. `empty-assistant-recovery-loop.patch` — wrap `streamFunction` at the stock call site
4. `stream-local-work-watchdog.patch` — start/idle bounds re-arm on `hasPendingLocalWork`

`agent-loop.js` pristine:
`43cc779ddaf90df41768d3d2d0f7d7ba8b8bce7bedc9dc6062ca8b4de84ae880`

Sequential postimage after (3)+(4):
`c265978d881b1ef2ff5f9b2ff186f79c2488d9996888cda276b42e50152eb314`

`stream-fn.js` hashes unchanged from export-only patch (see previous README).

Watchdog is inert unless `config.timeoutMs` / `config.streamStartTimeoutMs` are
positive finite numbers (stock default: no timers).
