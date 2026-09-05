# session-control.patch — provenance and order

Fourth coding-agent slice. Applies **after** `reload-guard` → `reload-ui` → `memory-lifecycle`.
Does not include RPC (`rpc-reload-veto.patch` is a sibling, same baseline).

Not a Senpi copy. Keeps stock AgentSession / agent loop.

## Order

```
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-ui.patch
patch -p1 --fuzz=0 --batch --forward -i memory-lifecycle.patch
patch -p1 --fuzz=0 --batch --forward -i session-control.patch
```

## What it wires (host, not declarations-only)

1. `AgentSession.prepareInteractiveInput` / `takeInteractiveSubmitResult` — prepared `id` (caller `clientInputId` or `randomUUID()`) is the `input`/`input_disposition` id. Unprepared prompts also use `randomUUID()` from memory-lifecycle, never `sessionId:counter` or the emitInput default `"input"`.
2. Control dispositions: `started`, `queued-steer`, `queued-follow-up`, `handled`, `rejected`.
3. `createInteractiveControlSurface()` — session-backed `submitInput` / `abortAgent` / `reload` / `snapshot` / `listCommands` / `clearPendingInputs`. Bound onto `ExtensionRunner` at construct so `pi.getInteractiveControl()` is live without TUI.
4. `ExtensionAPI.getInteractiveControl` + `registerRemovedToolHint` on loader factory; hints stored on the extension and flushed at runner bind.

TUI overlay (`respondToUiRequest`, slash remoteMode, etc.) is the UI owner's InteractiveMode surface. This patch is the session host that remote/task can call in RPC or tests.

## Not in this patch

- `registerMcpServer`, `setSessionFastMode`, `setSessionModel` (coordinate with lead; MCP/service-tier are not session-loop).
- Hint *delivery* on tool-call (`agent.removedToolHints` lives in senpi's agent-core).
- Full `RequestRunTracker` / `readConversationPage` history (Rubato-owned tracker module; fourth owner adapters).
- `rpc-reload-veto.patch`.

## Manifest addition (lead / applicator — not edited here)

```json
{ "id": "session-control", "file": "pi-coding-agent/0.84.2/session-control.patch" }
```

after `memory-lifecycle`. Recompute sha256 for the eight touched files listed in the patch headers.
