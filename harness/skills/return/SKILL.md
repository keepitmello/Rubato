---
name: return
description: "Non-interactive worker stdout: one actionable result layer with details in files. Distinguish a valid return, unfinished work and a fulfilled outcome."
---

# Return

This contract applies to non-interactive `rubato dispatch` / `--print` /
`--mode json` output. The caller may truncate stdout and retain the full output in `last.stdout`.

## Actionable return

Keep stdout to a short result, any needed decision or approval, and evidence paths.
State whether the assigned outcome is satisfied, partially covered at budget,
blocked, measurement-invalid, or no longer required by an approved decision.
Code citations, command output, file/line lists, commit dumps and stack traces go
in the detail artifact.

## Detail file

Record the artifact state, actual changes/findings, checks and their results,
intent/criterion revision, limitations, material support used, and what remains.
Use an existing artifact for the same purpose.

Default path supplied by the harness:

- With a session file: `<session-file>.return.md`.
- Without one: `~/.rubato-pi/agent/reports/<stamp>-return.md`.
- `RUBATO_RETURN_DETAIL` overrides the path when provided.

Create needed directories. If the detail file cannot be written, report that
delivery failure.
