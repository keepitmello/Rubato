---
name: macos-computer-use
description: "Drive native macOS app GUIs with Cua Driver when no dedicated API or CLI exists."
---

# macOS computer use

Use this only for native macOS app UI. Prefer a dedicated API, CLI, or file operation when one already solves the task. Browser work stays on the existing browser tools.

The backend is Cua Driver (`cua-driver`). It runs as its own daemon app, `/Applications/CuaDriver.app`, with its own Accessibility and Screen Recording permissions. Installing, starting and granting it are in Rubato's Settings → macOS Permissions → Computer use. Read [references/backend.md](references/backend.md) for tool use and measured limits, and [references/failure-recovery.md](references/failure-recovery.md) after a failed or ambiguous action.

## Action contract

- Observe the relevant state before a mutation and define what result will prove success.
- Perform the smallest necessary action.
- Verify the resulting application state. Tool success alone is not proof.
- A result with `"status":"refused"` did not dispatch and may be retried after a fresh observation. Anything else may have landed: observe before any retry.
- If delivery is ambiguous, stop instead of risking a duplicate click, submission, message, purchase, or deletion.

## Calling it

Arguments go as JSON on stdin. Put the same `"session"` label on every call of one task: element tokens belong to a session, and each CLI call is otherwise its own session, so a token from the previous call comes back `stale_element_token`.

```bash
printf '%s' '{"session":"t1","pid":<pid>}' | cua-driver call list_windows --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"include_screenshot":false,"query":"<label>"}' \
  | cua-driver call get_window_state --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"element_token":"<token>"}' | cua-driver call click --json
printf '%s' '{"session":"t1","pid":<pid>,"window_id":<id>,"element_token":"<token>","text":"..."}' \
  | cua-driver call type_text --json
```

Prefer element tokens over coordinates. `cua-driver list-tools` lists every tool and `cua-driver describe <tool>` prints its schema.
