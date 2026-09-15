---
name: macos-computer-use
description: "Drive native macOS app GUIs with local Peekaboo when no dedicated API or CLI exists. Cua Driver is optional."
---

# macOS computer use

Use this only for native macOS app UI. Prefer a dedicated API, CLI, or file operation when one already solves the task. Browser work stays on the existing browser tools.

## Backend selection

1. Use local Peekaboo with `--no-remote` by default.
2. Use Cua Driver only when explicitly requested.

Read [references/backend.md](references/backend.md) when selecting or diagnosing a backend. Read [references/failure-recovery.md](references/failure-recovery.md) after a failed or ambiguous action.

## Action contract

- Observe the relevant state before a mutation and define what result will prove success.
- Perform the smallest necessary action.
- Verify the resulting application state. Tool success alone is not proof.
- Do not replay a mutation through a second backend until observation proves the original action did not occur.
- If delivery is ambiguous, stop instead of risking a duplicate click, submission, message, purchase, or deletion.

## Peekaboo

Always pass `--no-remote`; the remote Bridge failed target attribution on this machine. Use fresh snapshot-bound element IDs and re-observe after navigation, rerender, or window changes.

```bash
peekaboo see --app <App> --window-title <Title> --no-remote --json
peekaboo click --on <element-id> --snapshot <snapshot> --no-remote --json
peekaboo set-value --on <element-id> --snapshot <snapshot> --value <value> --no-remote --json
```

Prefer semantic elements over coordinates. Use coordinates only with a fresh exact-window snapshot whose geometry is coherent.
