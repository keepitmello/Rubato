# Cua Driver

Measured on this machine (macOS 27, Cua Driver 0.29.1; harness and raw results in rubato-lab `bench/computer-use/`): tree reads, element clicks, menu invocation, typing and window screenshots all succeeded with the target app in front and behind the user's current app, without taking focus. A tree read takes about 0.4–0.5 s.

## Daemon and permissions

```bash
cua-driver status                       # not running: open -g -a /Applications/CuaDriver.app
cua-driver permissions status --json    # the daemon's own grants (com.trycua.driver)
cua-driver permissions grant            # walks through the macOS prompts; needs a person
```

`call` needs the daemon; it does not start one. Rubato starts it when the app launches. Start it through LaunchServices (`open -g -a`) so the daemon is its own responsible process and its grants are CuaDriver.app's, not those of whatever spawned the command.

## Observing

- `get_window_state` needs `pid` and `window_id` (from `list_windows` or `launch_app`). It returns a base64 screenshot unless `"include_screenshot": false`. With the screenshot a GitHub Desktop window was 1.9 MB of output, without it 0.3 MB, and with `"query": "<label>"` 5 KB. Ask for the screenshot only when you need to look.
- Electron and Chromium apps: the driver turns on their web accessibility tree itself. A fresh Linear window read as 154 elements, login buttons included.
- Some apps expose a window only to WindowServer, with no accessibility window (Calculator while it sits in the Stage Manager strip). Bring the app forward and read again before falling back to coordinates.

## Acting

- `type_text` inserts through accessibility first, so it is immune to the input source (Korean IME) and reaches background windows. Check the field value afterwards anyway: it once reported success on an app whose focused element took nothing.
- `hotkey` defaults to background delivery. Menu key equivalents (cmd+c, cmd+s, cmd+w) need `"delivery_mode": "foreground"`, which fronts the window briefly and restores the previous app. A key combo is never read back.
- `invoke_menu` takes the exact menu path in the app's language, e.g. `["파일", "신규"]` for TextEdit File > New on a Korean system.

## Stage Manager

With Stage Manager on, every window except the current stage is a thumbnail in the side strip (a 700×500 TextEdit window became 87×100). Tree reads, element clicks, typing and menus still work there. Screenshots capture the thumbnail, and anything that depends on window geometry fails. Bring the target app to the front (`bring_to_front`, or `open -a <App>`) before capturing or pointer work, then return to the user's app.
