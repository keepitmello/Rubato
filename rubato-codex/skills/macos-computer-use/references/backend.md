# Backend selection

## Default: Codex Computer Use

Use the skill-carried `cua_repl` MCP server first. It provides a persistent app binding, structured accessibility state, actions, and post-action inspection through one API. The tool's own description is the source of truth for initialization and available methods.

The local launcher enables only the `computer` surface. Browser tasks remain on the existing browser tools.

## Fallback: Peekaboo

Use Peekaboo locally with `--no-remote` when:

- the ChatGPT/Codex Computer Use runtime or plugin launcher is missing;
- the MCP server fails to start or disconnects before an action;
- app approval, macOS permission, or target binding prevents CUA access;
- CUA cannot expose or operate the required surface.

Peekaboo is a fallback, not a blind retry mechanism. After an uncertain mutating CUA action, observe first and replay only when the action is proven not to have occurred.

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

## Optional Cua Driver

Cua Driver may remain installed, but it is not part of the automatic chain. Use it only when explicitly requested or when its AX token path is specifically needed.
