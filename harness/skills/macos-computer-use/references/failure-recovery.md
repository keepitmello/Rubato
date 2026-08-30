# Failure recovery

- `Bridge operation target attribution failed`: add `--no-remote` and retry.
- `multiple eligible windows`: add `--window-title` or a fresh `see` snapshot.
- `Do not combine an explicit --snapshot with --app`: drop `--app` / window flags when using `--snapshot`.
- `Coordinates ... outside target window`: the AX frame and WindowServer frame disagree, often because Stage Manager collapsed the window. Do not guess. Re-see; if still incoherent, stop and say so.
- Tool `success: true` with `effect: unverifiable`: read real app state before claiming the click worked.

