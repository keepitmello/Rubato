# Backend selection

Measured on this machine (macOS 27, Cua Driver 0.29.1, Peekaboo 4.6.0; harness and raw results in rubato-lab `bench/computer-use/`). With the target app in front both backends completed every task. Working behind the user's current app, both again completed every task when Stage Manager was off; with Stage Manager on, Cua Driver still typed into the background window and Peekaboo refused. Cua Driver read trees 2–3x faster (0.4–0.5 s vs 1.0–1.1 s).

## Default: Cua Driver

The driver runs as its own daemon app (`com.trycua.driver`), so its Accessibility and Screen Recording grants belong to CuaDriver.app, not to whatever spawned the command.

```bash
cua-driver status                       # not running: open -g /Applications/CuaDriver.app
cua-driver permissions status --json    # the daemon's own grants
cua-driver describe get_window_state    # full schema of any tool
printf '%s' '{"session":"t1"}' | cua-driver call list_apps --json
```

- Put the same `"session"` label on every call of one task, or element tokens from the last call come back stale.
- `get_window_state` returns a base64 screenshot unless `"include_screenshot": false`. With the screenshot a GitHub Desktop window was 1.9 MB of output, without it 0.3 MB, and with `"query": "<label>"` 5 KB. Ask for the screenshot only when you need to look.
- `type_text` inserts through accessibility first, so it is immune to the input source (Korean IME) and reaches background windows. Check the field value afterwards anyway.
- `hotkey` defaults to background delivery. Menu key equivalents (cmd+c, cmd+s, cmd+w) need `"delivery_mode": "foreground"`, which fronts the window briefly and restores the previous app.
- A reported success is not proof. On an app whose focused element accepted nothing, `type_text` still reported success.

## Stage Manager

With Stage Manager on, every window except the current stage is a thumbnail in the side strip (a 700×500 TextEdit window became 87×100). Tree reads, element clicks and menu invocation still work there. Screenshots capture the thumbnail, and anything that depends on window geometry fails. Bring the target app to the front (`open -a <App>`, or `bring_to_front`) before capturing or pointer work, then go back to the user's app.

## Electron and Chromium apps (Rubato, Slack, VS Code, Discord, ...)

A window that shows only window buttons and empty groups is usually web content whose accessibility tree is off, not an app without controls. Electron builds the web tree only after an assistive client sets `AXManualAccessibility`. Run `scripts/enable-web-ax.sh <App name | pid>` once; it lasts until the app quits. Do not make the app keep accessibility always on — Chromium then maintains the tree continuously, which costs CPU and memory.

Measured on Rubato (Electron 44), settings screen: 12 elements before, 26 after `AXManualAccessibility` at Peekaboo's default depth, 125 with `--depth 40` — every sidebar item, toggle and row button by name. Coordinate clicking on such a window is the last resort, not the default.

## Fallback: Peekaboo

Use local Peekaboo when Cua Driver is missing, cannot start, cannot bind, or cannot operate the required surface. Keep `--no-remote` on every command; the Bridge path failed exact-window target attribution on this machine. Peekaboo runs inside the calling process, so its grants are the responsible app's (the Rubato app, for Rubato sessions).

```bash
peekaboo permissions --no-remote
peekaboo window list --app <bundle id> --no-remote --json
peekaboo see --window-id <id> --no-remote --json
peekaboo click --on <element-id> --snapshot <snapshot> --no-remote --json
peekaboo type "<text>" --snapshot <snapshot> --no-remote --json
```

- Mutations need an exact target: `--pid` or a bundle id, not a display name, and a fresh `see` snapshot. With a snapshot, do not also pass `--app` or window flags.
- `type` often lands the text and still reports `dispatched_unverified` with `retry_safe: false`. Read the field before retrying, or the text goes in twice.
- For Electron windows pass `--depth 40 --max-elements 2000` to `see`; the default traversal stops early. Do not raise it globally with `PEEKABOO_AX_MAX_*`.
- Some apps (notably Calculator in the Stage Manager strip) expose a CG window but no AX window; `see` returns `ACCESSIBILITY_INCOMPLETE`. Bring the app forward and re-observe; if AX stays empty on both backends, stop instead of guessing coordinates.
