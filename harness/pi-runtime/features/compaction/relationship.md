# A9 compaction overlay vs context-window

Candidate default is history-notes (`RUBATO_CONTEXT_MODE` unset or `history-notes`).
`features/context-window` then disables stock auto compaction (`getCompactionSettings().enabled === false`)
and `context-notes` vetoes stock summaries on `session_before_compact`. Cuts go through
`applyCompaction` (revision/leaf, abort → stale). This overlay must not call `ctx.compact()`
or supply a competing `session_before_compact` result in that mode.

| Mode | Who cuts | Overlay |
|---|---|---|
| history-notes (default) | context-notes via `applyCompaction` | idle / openai-remote / circuit-breaker auto paths are dormant |
| summary (`RUBATO_CONTEXT_MODE=summary`) | stock auto (threshold/overflow) plus this overlay | idle after `agent_settled`; openai-remote may replace the summarizer via `session_before_compact`; circuit-breaker trips after 3 failures / 60s, manual bypass |

No double compaction: notes mode never starts this overlay; summary mode lets stock auto run first, then idle only if usage is still over the product threshold (default 0.9, per-model `settings.compaction.models`). Abort/stale for notes cuts stay with context-window.
