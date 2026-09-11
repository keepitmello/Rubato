# Failure recovery

## Codex Computer Use

- `cua_repl` tool missing or server unavailable: use Peekaboo before mutation.
- App binding or permission denied: report the missing app approval or macOS permission. Use Peekaboo only if it already has access.
- Failure clearly occurred before action dispatch: a Peekaboo retry is allowed.
- Timeout, disconnect, or error during or after action dispatch: treat delivery as unknown. Re-observe the app before deciding whether the action may be repeated.
- Expected state is already present: do not repeat the mutation.
- Resulting state cannot be determined: stop and report the ambiguity.

## Peekaboo

- `Bridge operation target attribution failed`: add `--no-remote` and retry.
- `multiple eligible windows`: add `--window-title` or take a fresh `see` snapshot.
- `Do not combine an explicit --snapshot with --app`: drop `--app` and window flags when using `--snapshot`.
- `Coordinates ... outside target window`: AX and WindowServer geometry disagree. Re-observe; if still incoherent, stop instead of guessing.
- `success: true` with an unverifiable effect: read the real app state before claiming success.
- A custom or canvas control lacks an AX press: re-observe, then use snapshot-bound coordinates only if the window geometry is coherent.
