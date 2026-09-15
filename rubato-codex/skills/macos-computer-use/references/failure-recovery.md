# Failure recovery

## Peekaboo

- `Bridge operation target attribution failed`: add `--no-remote` and retry.
- `multiple eligible windows`: add `--window-title` or take a fresh `see` snapshot.
- `Do not combine an explicit --snapshot with --app`: drop `--app` and window flags when using `--snapshot`.
- `ACCESSIBILITY_INCOMPLETE` / `WINDOW_NOT_FOUND`: the process may have no AX window. Screenshot capture can still work. Re-observe once; if AX stays empty, fall back to Cua Driver.
- `Coordinates ... outside target window`: AX and WindowServer geometry disagree. Re-observe; if still incoherent, stop instead of guessing.
- `success: true` with an unverifiable effect: read the real app state before claiming success.
- A custom or canvas control lacks an AX press: re-observe, then use snapshot-bound coordinates only if the window geometry is coherent.
- Failure clearly occurred before action dispatch: a Cua Driver retry is allowed.
- Timeout, disconnect, or error during or after action dispatch: treat delivery as unknown. Re-observe before deciding whether Cua Driver may be used.

## Cua Driver

- `ax_window_unresolved`: the CG window exists but no AXWindow reports that `window_id`. Same class of failure as Peekaboo `ACCESSIBILITY_INCOMPLETE`. If both backends lack AX, stop.
- `Missing required integer field`: `call` takes JSON on stdin, not flags. `get_window_state` needs `pid` and `window_id`.
- Expected state is already present: do not repeat the mutation.
- Resulting state cannot be determined: stop and report the ambiguity.
