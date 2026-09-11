# A9 compaction overlay vs context-window

Mode is resolved at `session_start` (product `adoptContextMode`: user-explicit
`RUBATO_CONTEXT_MODE` wins, else recorded mode / notes-window entries, else Astra →
history-notes and every other model → summary). Unset env still reads as history-notes
*during session load* so a notes resume does not throw; `session_start` then writes
the live env. `features/context-window` disables stock auto compaction in notes
(`getCompactionSettings().enabled === false`) and `context-notes` vetoes stock
summaries on `session_before_compact`. Cuts go through `applyCompaction`
(revision/leaf, abort → stale). This overlay must not call `ctx.compact()` or
supply a competing `session_before_compact` result in that mode.

| Mode | Who cuts | Overlay |
|---|---|---|
| history-notes (Astra default, or notes-window resume) | context-notes via `applyCompaction` | idle / openai-remote / circuit-breaker auto paths are dormant |
| summary (every other model default, or env override) | stock auto at the product client ratio (default 0.9) plus this overlay; Anthropic server compaction owns threshold/overflow for supported Claude models | idle after `agent_settled` (not for Anthropic server-compaction models); openai-remote may replace the summarizer via `session_before_compact`; circuit-breaker trips after 3 failures / 60s, manual bypass |

No double compaction: notes mode never starts this overlay; summary mode lets stock
auto run first, then idle only if usage is still over the product threshold (default
0.9, per-model `settings.compaction.models`). Abort/stale for notes cuts stay with
context-window. Opening a notes-window session with user-explicit summary fails
loudly instead of proceeding without recovery tools.
