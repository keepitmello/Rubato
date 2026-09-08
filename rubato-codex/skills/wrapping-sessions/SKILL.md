---
name: wrapping-sessions
description: "Reference-only Rubato session wrap format. Use only when the user or repository explicitly asks for a wrap; never auto-commit from Codex."
---

# Rubato session wrap reference

This source workflow is packaged for compatibility, but it is not an active
Codex completion hook. Use it only when the user or repository explicitly asks
for a durable session wrap. Do not create private case-study paths, stage files,
or commit merely because a Codex turn is ending.

When explicitly requested, preserve the facts that a diff cannot recover:
decision rationale, rejected approaches and why, external answers, reversed
assumptions, unresolved findings, verification actually run, and the exact next
action. Separate confirmed facts from estimates. Follow the current repository's
chosen destination, language, commit policy, and ownership boundaries; if no
destination is specified, ask rather than inventing a private path.
