---
name: return
description: "Reference contract for Rubato non-interactive worker stdout. Do not use it to replace Codex native final responses."
---

# Rubato worker return contract

This packaged source is conditional documentation for a process launched by
`rubato dispatch` in non-interactive print or JSON mode. It does not change
Codex native completion, messaging, or final-response behavior. Ignore this
skill unless the current task is explicitly implementing or operating that
Rubato worker path.

When it applies, keep worker stdout to one actionable executive layer: outcome,
client decision, approvals still required, and evidence-file paths. Put detailed
commands, changes, rationale, and logs in the Rubato session's detail file. Use
`RUBATO_RETURN_DETAIL` only when the caller explicitly supplies it. If the
detail file cannot be written, report that and stop rather than flooding stdout.
