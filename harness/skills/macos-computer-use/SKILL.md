---
name: macos-computer-use
description: "맥 앱 GUI 조작. Peekaboo, 전용 CLI가 없을 때."
---

# macOS computer use

Use this only for native macOS app UI. Browser work stays on the existing browser/Chrome tools. Prefer a dedicated CLI, API, or file tool when it already solves the task.

Current measured default driver: **Peekaboo 4.2.0** via `/opt/homebrew/bin/peekaboo`.
Codex built-in Computer Use remains available through `node_repl` + `@oai/sky` in Desktop threads. Do not wrap it.
Cua Driver is installed but is not the default in this skill.

## Policy that matched the local bench

1. Use Peekaboo locally: always pass `--no-remote`. The default Bridge path failed target attribution on this machine.
2. Observe with `peekaboo see --app <App> --window-title <Title> --no-remote --json`. When you only need structure, add `--tree --no-screenshot` and skip the image entirely. Take the screenshot only when AX is incomplete, the target is visual/canvas, or layout itself matters.
3. Act with element IDs from that snapshot. Do not keep stale IDs across navigation, rerender, or window changes.
4. Prefer `set-value --on <id> --snapshot <snap>` for fields. Do not add `--app` when a snapshot is already supplied.
5. Prefer `click --on <id> --snapshot <snap>`. This used background accessibility and did not steal focus.
6. Do not take another screenshot just to reassure yourself. `see` already captures one.
7. If `type` refuses because the process has multiple windows, add `--window-title` or click the field first. Better: `set-value`.
8. Coordinates are last resort. Background coordinates need a fresh exact-window snapshot and must sit inside that window. Background delivery is the default. Reach for `--foreground` only when the app genuinely needs a key window, a Space switch, or a raw mouse event.
9. Never report success from `success: true` alone. Read the app's real state. The bench app writes `/tmp/computer-use-bench-state.json`.
10. If a custom/canvas control has no AX press, semantic click can lie. Re-observe, then use snapshot-bound coordinates only if the window geometry is coherent.

## Commands

```bash
peekaboo permissions status
peekaboo app list --no-remote --json
peekaboo window list --app Finder --no-remote --json
peekaboo see --app ComputerUseBench --window-title "Computer Use Bench" --no-remote --json
peekaboo click --on elem_5 --snapshot <snapshot> --no-remote --json
peekaboo set-value --on elem_7 --snapshot <snapshot> --value "TOKEN" --no-remote --json
```

MCP server name: `peekaboo` (`peekaboo mcp --no-remote`).

## Live help

The binary ships its own current usage. Read it from the binary instead of guessing flags.

```bash
peekaboo help
peekaboo help see
peekaboo help click
peekaboo learn
```

