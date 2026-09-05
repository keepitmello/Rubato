# session-core-extension.patch — additive session/core contracts

Applies **after** `session-control.patch` and `rpc-reload-veto.patch`.
Does not recut reload-guard / reload-ui / memory-lifecycle.

## Order

```
reload-guard → reload-ui → memory-lifecycle → session-control → rpc-reload-veto
→ session-core-extension
```

Sibling: `pi-agent-core/0.84.2/removed-tool-hints.patch` (hint *delivery* in the loop).

## Host wiring

- `registerMcpServer` stores declarations; `ExtensionRunner.getRegisteredMcpServers()` lists them (first name wins). MCP stdio *client* (`builtin/mcp/service.js`) is still fork-only — not copied here.
- `setSessionFastMode` / `isFastModeActive` — session flag, no catalog-tier rewrite (provider owner).
- `setSessionModel` — session history only; does **not** call `setDefaultModelAndProvider`.
- `clearQueue({ abortWillFollow })` + abort gate uses `_hadClearedQueuedMessages` (Senpi gap).
- `attachRequestRunTracker` / `readConversationPage` / `requestTimelineSnapshot` — real tracker if attached; otherwise `sessionManager.getEntries()`, not an empty stub.
- `registerRemovedToolHint` also writes `agent.removedToolHints` for pi-agent-core delivery.
- New `dist/core/sensitive-output.js` + package-root export (`redactSensitiveOutput`) for the UI owner's import.

## Manifest (lead)

```json
{ "id": "session-core-extension", "file": "pi-coding-agent/0.84.2/session-core-extension.patch" }
{ "id": "removed-tool-hints", "package": "pi-agent-core", "file": "pi-agent-core/0.84.2/removed-tool-hints.patch" }
```
