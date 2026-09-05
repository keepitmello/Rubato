# reload-guard.patch — provenance & metadata

Carries the senpi fork's cancellable `session_before_reload` hook onto **stock**
`@earendil-works/pi-coding-agent@0.84.2`. First real Pi source patch of the
cutover (no string loader, no native runtime). This slice is the reload gate
only — not a claim that all Rubato features have migrated.

## Upstream provenance (preserved, not replaced)

- Package: `@earendil-works/pi-coding-agent@0.84.2`, MIT.
- gitHead: `914cf1472e715297caa30db4b9535d534a9eb718`.
- integrity: `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`.
- Behavior source: senpi fork `@code-yeongyu/senpi@2026.9.4-3` (MIT):
  `dist/core/agent-session.js` `reload()` gate + `checkReloadVeto()`,
  `dist/core/extensions/runner.js` `isSessionBeforeEvent`, plus matching
  `.d.ts` lifecycle contracts (`SessionBeforeReloadEvent` /
  `SessionBeforeReloadResult` / `ReloadVetoDecision` /
  `AgentSession.reload`/`checkReloadVeto` return, `RunnerEmitResult`
  inference, package-root re-exports).
- Stock already owned `emit()` short-circuit on `result.cancel` and
  `hasHandlers()`. This patch ports that delta — no new semantics invented.

## What the patch does

1. `dist/core/extensions/runner.js` — add `session_before_reload` to
   `isSessionBeforeEvent`, so `cancel: true` short-circuits `emit()`.
2. `dist/core/agent-session.js` `reload()` — consult `checkReloadVeto()`
   FIRST and return the veto before `emitSessionShutdownEvent(...,
   reason: "reload")`. Idle / no-handler reloads run the original body and
   return `{ cancelled: false }`.
3. `dist/core/agent-session.js` — add `checkReloadVeto()` with
   fork-identical mapping: no handlers -> `{cancelled:false}`;
   `result?.cancel !== true` -> `{cancelled:false}`; else
   `{cancelled:true[, reason]}`.
4. Public types that match **wired** runtime:
   `AgentSession.reload` / `checkReloadVeto` return,
   `ExtensionAPI.on("session_before_reload")`,
   `SessionBeforeReloadEvent` / `Result` / `ReloadVetoDecision`,
   `SessionEvent` union, `RunnerEmitResult` for the new event,
   package-root `dist/index.d.ts` re-exports.
5. Command-context `ctx.reload()` declarations stay `Promise<void>`.
   Stock `rpc-mode.js` and `interactive-mode.js` `await session.reload()`
   and discard the result; `runner.js` forwards `reloadHandler()` as-is
   (undefined). This slice does **not** rewire those hosts.

`ExtensionContext.checkReloadVeto` is **not** added: it is not bound on
handler `ctx` in this patch.

## Consumer (verified, not just grepped)

`packages/rubato-runtime/src/components/task/reload-guard.ts`:

```ts
export function wireReloadGuard(pi, manager) {
  pi.on("session_before_reload", () => evaluateReloadVeto(manager))
}
```

The harness test imports those **exported functions** and drives them through
a real patched stock `AgentSession.reload()` / `checkReloadVeto()`.

## Apply / verify (baseline check, fuzz 0, noninteractive)

Apple/BSD `patch` asks reversed-patch questions on `/dev/tty`. Every
invocation must pass `--batch --forward` and a subprocess timeout.

```sh
cd <unpacked pi-coding-agent 0.84.2 root>
patch -p1 --fuzz=0 --batch --forward --dry-run -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
env -u NODE_OPTIONS node --test harness/rubato-pi/test/unit/pi-reload-guard.test.mjs
```

`--fuzz=0` rejects context mismatch; it does **not** reject line-number
offsets. Drift detection is a mutated pristine hunk anchor (must fail) plus
a clean apply on unmodified stock. Recut on context change; never widen fuzz.

## Test fixture (scratch only, never committed)

```sh
mkdir -p /tmp/pi-rg-fixture && cd /tmp/pi-rg-fixture && npm init -y \
  && npm install --ignore-scripts --no-audit --no-fund \
     @earendil-works/pi-coding-agent@0.84.2
```

Consumed via `PI_STOCK_FIXTURE_DIR` (default
`/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent`). SKIPS when
absent or version-mismatched. Copy to private scratch; do not modify the
shared fixture.

## Unresolved UI parity (NOT in this patch)

Stock interactive `handleReloadCommand()` (`interactive-mode.js`):

1. **Clears UI before the gate.** `resetExtensionUI()`, then builds and
   focuses a "Reloading..." box, **then** `await this.session.reload()`. A
   veto therefore runs against an already-cleared editor / shown reload box.
   This is more than a later box dismissal: the pre-gate UI teardown already
   happened.
2. **Success path after cancelled.** The host `await session.reload()` and
   **discards** `{ cancelled, reason }`. On veto the `try` still runs
   `restoreChatBeforeSessionStart()`, keybinding reload, "Reloaded
   keybindings..." status, and `dismissReloadBox(this.editor)` as if the
   reload succeeded. RPC `ctx.reload()` is the same discard
   (`rpc-mode.js`).

Senpi pre-checks the veto before showing reload UI and surfaces a cancelled
result. That host wiring is an unconnected follow-up, not full parity today.
Gate correctness on `AgentSession.reload()` is unaffected.

Other follow-ups: HOME layout (`~/.rubato-pi`), stock `cli.js` boot,
launcher/live-profile/deployment.
