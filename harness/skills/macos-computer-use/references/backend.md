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

## Fallback: Cua Driver

Use Cua Driver (`cua-driver call`) when Peekaboo is missing, cannot start, cannot bind, or cannot operate the required surface. Daemon, Accessibility, and Screen Recording can be healthy while a given window still has no AX surface.

```bash
cua-driver status
cua-driver permissions status --json
printf '%s\n' '{}' | cua-driver call list_apps --json
printf '%s\n' '{}' | cua-driver call get_accessibility_tree --json
```

`call` arguments go as JSON on stdin. `get_window_state` needs both `pid` and `window_id`.
