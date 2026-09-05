# rpc-reload-veto.patch — provenance and order

RPC lifecycle for `session.checkReloadVeto()` from `reload-guard.patch`.
Applies **after** `memory-lifecycle` (safe after `session-control` too). Independent file set from session-control.

Stock 0.84.2 RPC has no `reload` / `check_reload_veto` commands. Senpi implemented them on fork-only `connection-handler.js`. This patch maps them onto stock `rpc-mode.js` + `rpc-client.js`.

## Order

```
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-ui.patch
patch -p1 --fuzz=0 --batch --forward -i memory-lifecycle.patch
patch -p1 --fuzz=0 --batch --forward -i session-control.patch   # optional sibling
patch -p1 --fuzz=0 --batch --forward -i rpc-reload-veto.patch
```

Depends on: `AgentSession.checkReloadVeto` / `reload()` returning `{ cancelled, reason? }` (reload-guard).

## Host wiring

- `rpc-mode.js` `handleCommand`: `reload` → `session.reload()`; `check_reload_veto` → `session.checkReloadVeto()`.
- `RpcClient.reload()` / `checkReloadVeto()` send those command types.
- `rpc-types.d.ts` + `rpc-client.d.ts` match.

Does not spawn a live agent. Command-context `ctx.reload()` remains `Promise<void>` (reload-guard).

## Manifest addition (lead — not edited here)

```json
{ "id": "rpc-reload-veto", "file": "pi-coding-agent/0.84.2/rpc-reload-veto.patch" }
```

after `session-control` (or after `memory-lifecycle` if session-control is deferred). Files: `dist/modes/rpc/rpc-mode.js`, `rpc-client.js`, `rpc-client.d.ts`, `rpc-types.d.ts`.
