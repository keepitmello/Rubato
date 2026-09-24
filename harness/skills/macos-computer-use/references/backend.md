# Backend selection

## Default: Peekaboo

Use local Peekaboo with `--no-remote`. It lists apps and windows, reads accessibility trees, captures screenshots, and performs snapshot-bound clicks and value changes.

The default Peekaboo Bridge path previously failed exact-window target attribution on this machine. Keep `--no-remote` on every Peekaboo command.

Useful commands:

```bash
peekaboo permissions status
peekaboo app list --no-remote --json
peekaboo window list --app Finder --no-remote --json
peekaboo see --app ComputerUseBench --window-title "Computer Use Bench" --tree --no-screenshot --no-remote --json
peekaboo help see
peekaboo help click
```

With a snapshot, do not also pass `--app` or window flags. Prefer `set-value` for fields and `click` for semantic controls. Do not keep element IDs across navigation, rerender, or window changes.

Some apps (notably Calculator) expose a CG window but no AX window. Screenshot capture can still succeed while `see` returns `ACCESSIBILITY_INCOMPLETE`. Re-observe; if AX stays empty, fall back to Cua Driver. If that surface is also empty, stop instead of guessing coordinates unless a fresh exact-window snapshot has coherent geometry.

### Electron and Chromium apps (Rubato, Slack, VS Code, Discord, ...)

A window that shows only window buttons and empty groups is usually web content whose accessibility tree is off, not an app without controls. Two separate limits hide it:

1. Electron builds the web AX tree only after an assistive client sets `AXManualAccessibility` on the app. Peekaboo does not. Run `scripts/enable-web-ax.sh <App name | pid>` once; it lasts until the app quits. Do not make the app keep accessibility always on — Chromium then maintains the tree continuously, which costs CPU and memory on this machine.
2. Web trees are deep. Peekaboo's default traversal stops early, so pass `--depth 40 --max-elements 2000` to `see` for these windows. Do not raise it globally with `PEEKABOO_AX_MAX_*`; native apps get slower for nothing.

```bash
~/.agents/skills/macos-computer-use/scripts/enable-web-ax.sh Rubato
peekaboo see --window-id <id> --depth 40 --max-elements 2000 --no-remote --json
peekaboo click --on <element-id> --snapshot <snapshot> --no-remote --json
```

Measured on Rubato (Electron 44), settings screen: 12 elements before, 26 after `AXManualAccessibility` at default depth, 125 with `--depth 40` — every sidebar item, toggle and row button by name. Coordinate clicking on such a window is the last resort, not the default.

## Fallback: Cua Driver

Use Cua Driver (`cua-driver call`) when Peekaboo is missing, cannot start, cannot bind, or cannot operate the required surface. Daemon, Accessibility, and Screen Recording can be healthy while a given window still has no AX surface.

```bash
cua-driver status
cua-driver permissions status --json
printf '%s\n' '{}' | cua-driver call list_apps --json
printf '%s\n' '{}' | cua-driver call get_accessibility_tree --json
```

`call` arguments go as JSON on stdin. `get_window_state` needs both `pid` and `window_id`.
