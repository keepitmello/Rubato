---
name: macos-computer-use
description: "Drive native macOS app GUIs with Cua Driver when no dedicated API or CLI exists, falling back to local Peekaboo."
---

# macOS computer use

Use this only for native macOS app UI. Prefer a dedicated API, CLI, or file operation when one already solves the task. Browser work stays on the existing browser tools.

## Backend selection

1. Use Cua Driver (`cua-driver call`) by default.
2. Fall back to local Peekaboo (`--no-remote`) when Cua Driver is unavailable, cannot bind to the target, or cannot operate the required surface.

Read [references/backend.md](references/backend.md) when selecting or diagnosing a backend. Read [references/failure-recovery.md](references/failure-recovery.md) after a failed or ambiguous action.

## Action contract

- Observe the relevant state before a mutation and define what result will prove success.
- Perform the smallest necessary action.
- Verify the resulting application state. Tool success alone is not proof.
- Before a mutation, a Cua Driver refusal may fall back immediately.
- During or after a mutating call, never replay the action through the other backend until observation proves the original action did not occur.
- If delivery is ambiguous, stop instead of risking a duplicate click, submission, message, purchase, or deletion.

## Cua Driver

Arguments go as JSON on stdin. Put the same `"session"` label on every call of one task: element tokens belong to a session, and each CLI call is otherwise its own session, so a token from the previous call comes back `stale_element_token`.

```bash
printf '%s' '{"session":"t1","pid":<pid>}' | cua-driver call list_windows --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"include_screenshot":false,"query":"<label>"}' \
  | cua-driver call get_window_state --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"element_token":"<token>"}' | cua-driver call click --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"element_token":"<token>","text":"..."}' \
  | cua-driver call type_text --json
```

Prefer element tokens over coordinates. A result with `"status":"refused"` did not dispatch; anything else may have landed.
