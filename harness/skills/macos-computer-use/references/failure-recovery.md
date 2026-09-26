# Failure recovery

## Permissions

`cua-driver permissions status --json` answers for the daemon's own identity (`com.trycua.driver`); with no daemon running it reports `unknown`. If Accessibility or Screen Recording is off, ask the user to press Set up under Settings → macOS Permissions → Computer use, or to run `cua-driver permissions grant`. The prompts need a person.

A row in System Settings can read "on" and still be denied: the grant is bound to the app's code signature. The Cua installer keeps grants across compatible releases and resets them when it cannot. Remove the CuaDriver row, then grant again.

## Errors

- `daemon is not running`: `open -g -a /Applications/CuaDriver.app`, then retry.
- `stale_element_token`: the token came from another session or an older read. Put the same `"session"` label on every call and read again with `get_window_state`.
- `ax_window_unresolved`: the window exists for WindowServer but has no accessibility window. Bring the app forward and read again; with Stage Manager on, strip windows often have none. If it stays empty, stop instead of guessing coordinates.
- `window_id_not_found` / `window_owner_pid_mismatch`: list windows again; the window closed or belongs to another process.
- `Missing required integer field`: `call` takes JSON on stdin, not flags.
- `"status":"refused"`: nothing was dispatched. Read again and retry once.
- Any other failure during or after dispatch: treat delivery as unknown. Observe before deciding anything.
- Expected state is already present: do not repeat the mutation.
- Resulting state cannot be determined: stop and report the ambiguity.
