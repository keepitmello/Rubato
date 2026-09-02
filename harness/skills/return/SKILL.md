---
name: return
description: "Final stdout contract from a non-interactive worker to its dispatcher: one executive layer, details in files."
---

# Return

This is the contract for what you put on stdout when the session is non-interactive (`--print` / `--mode json`). Interactive and `--mode rpc` sessions ignore it.

## Boss report only

Final stdout is one layer: a report a client can act on without reading the repo.

Include, and only include:

- Done or not done — the outcome, in one sentence.
- What the client must decide.
- What still needs the user's approval.
- Evidence as file paths.

A few hundred characters. No code citations. No command output. No file:line lists. No commit dumps. No stack traces.

## Detail file

Write the technical record — files and lines changed, commands and their results, rationale, commit hash — to a file. Put that path on stdout as one line.

Default location (harness fills the concrete path for this run below):

- Session file in use: `<session-file>.return.md`, next to the session.
- `--no-session` or no session file: `~/.rubato-pi/agent/reports/<stamp>-return.md`, sibling of `sessions/`. Create the directory if needed.
- `RUBATO_RETURN_DETAIL` overrides both.

If you cannot write the file, say so on stdout and stop. Do not pour the detail into stdout instead.
