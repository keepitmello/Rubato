# reload-ui.patch — provenance, order, remaining wiring

Second cutover slice. Applies **after** `reload-guard.patch`. Do not apply
alone: it calls `AgentSession.checkReloadVeto()` and reads
`reload()` `{ cancelled, reason? }`, which the first patch adds.

This is not a full-feature migration.

## Integration order

From an unpacked `@earendil-works/pi-coding-agent@0.84.2` root:

```
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-ui.patch
```

Apple/BSD `patch` prompts on `/dev/tty`; every invocation needs `--batch
--forward` and a subprocess timeout. `--fuzz=0` rejects context mismatch, not
line offsets. Drift: mutate a pristine `handleReloadCommand` hunk anchor.

## Upstream / behavior source

- Stock: `@earendil-works/pi-coding-agent@0.84.2`, MIT, Mario Zechner / pi
  contributors. File: `dist/modes/interactive/interactive-mode.js`
  `handleReloadCommand`.
- Behavior: senpi `@code-yeongyu/senpi@2026.9.4-3` (MIT) interactive
  `handleReloadCommand` (~6763–6869):
  1. Preflight `session.checkReloadVeto()` **before** any UI clear or reload
     box. Warn and return if cancelled.
  2. `reload()` re-checks internally (race window). If
     `reloadResult.cancelled`, restore the previous editor, warn, **return**
     (no success status, no keybinding/theme rebuild).
  3. `resetExtensionUI()` moves into `beforeSessionStart`, i.e. only after
     the internal veto has allowed teardown.

Stock-only extras in senpi (timings, compaction-delegation footer) are **not**
ported. No native host rewrite.

## What this patch does (1 file)

`handleReloadCommand()` only. `/reload` and command-context `reload:` already
call this method.

- Veto: existing editor / extension UI stay up; `showWarning(reason)`; no
  "Reloaded keybindings..." status; `session.reload()` is not started, so no
  teardown.
- Race after preflight: reload box may appear, then cancelled result restores
  `this.editor`, warns, skips success.
- `resetExtensionUI()` (including stock `setCustomEditorComponent(undefined)`,
  which always clears `editorContainer` and focuses `defaultEditor`) runs only
  in `beforeSessionStart`. The Reloading box is **re-seated and re-focused**
  immediately after that reset so `session_start` / `extendResources` still see
  the box — not a live editor. This is reload-local; stock editor policy is
  not forked.
- Error after `beforeSessionStart`: `dismissReloadBox(this.editor)` so a
  detached custom `previousEditor` is never re-seated.
- Normal reload: stock rebuild then dismiss box onto `this.editor`.

## Command-context / RPC (intentionally retained)

Previous slice documented stock hosts as:

```
reload: async () => { await session.reload(); }           // rpc-mode.js
reload: async () => { await this.handleReloadCommand(); } // interactive bind
```

Both are `Promise<void>` and **discard** `{ cancelled, reason }`. This slice
does **not** change those declarations or RPC protocol (`check_reload_veto`
command is senpi-only and unwired). Interactive `ctx.reload()` still returns
undefined; side effects now go through the preflighting `handleReloadCommand`.
RPC `ctx.reload()` still discards `session.reload()` — remaining wiring, not
promised here.

`ExtensionContext.checkReloadVeto` is still not bound on handler `ctx`.

## Unresolved (full cutover not complete)

- RPC stdin `reload` / `check_reload_veto` protocol and result payload.
- Interactive theme/header rebuild parity with later senpi extras.
- Launcher, live profile, HOME/`cli.js` boot, Unicode (other slice).
