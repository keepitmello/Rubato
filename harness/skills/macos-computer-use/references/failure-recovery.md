# Failure recovery

## Screen Recording denied while the settings list reads allowed

Symptoms: `PERMISSION_ERROR_SCREEN_RECORDING`; every window reported as
`<untitled>`; Apple's own `screencapture` failing with `could not create image
from display`; or a TCC prompt that keeps returning and names an application you
did not run.

macOS grants Screen Recording to the *responsible process* — the ancestor
application the chain was spawned under — not to the binary being executed. A
long-lived agent server keeps whatever responsible process it was launched with,
so granting `peekaboo`, `node`, or `python3` changes nothing while that server
stays up. A forked or renamed app is named by its code signature, so the prompt
can cite an upstream app that is not the one on screen.

Identify the responsible application before editing any list:

```bash
# launchd becomes the responsible process, breaking the inherited chain.
launchctl submit -l pbprobe -- /opt/homebrew/bin/peekaboo \
  see --mode screen --no-elements --path /tmp/probe.png --no-remote
sleep 5; launchctl remove pbprobe; ls -l /tmp/probe.png
```

A capture that succeeds under `launchctl` while the same command fails inline
proves the denial belongs to an ancestor. The prompt naming that ancestor is
itself visible in the probe screenshot.

Then fix that application's row in System Settings > Privacy & Security > Screen
Recording. A row can read "on" and still be denied: the grant is bound to the
code signature, so an app updated after the grant no longer matches. Toggling the
switch off and on does not re-bind it, and adding the same bundle again while the
row exists is a no-op. Remove the row, then add the bundle back.

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
