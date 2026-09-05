# memory-lifecycle.patch — provenance, order, remaining wiring

Third cutover slice. Applies **after** `reload-guard.patch` then `reload-ui.patch`.
Do not apply alone: hunks are against the post-reload-ui 0.84.2 tree (types union
already contains `SessionBeforeReloadEvent`).

This is not a full-feature migration and not a Senpi file copy.

## Integration order

From an unpacked `@earendil-works/pi-coding-agent@0.84.2` root:

```
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-ui.patch
patch -p1 --fuzz=0 --batch --forward -i memory-lifecycle.patch
```

Apple/BSD `patch` prompts on `/dev/tty`; every invocation needs `--batch
--forward` and a subprocess timeout. `--fuzz=0` rejects context mismatch.
Drift: mutate a pristine `async abort()` hunk anchor after the two prior patches.

## Upstream / behavior source

- Stock: `@earendil-works/pi-coding-agent@0.84.2`, MIT, Mario Zechner / pi
  contributors. Files: `dist/core/agent-session.js`, `agent-session.d.ts`,
  `dist/core/extensions/{runner.js,runner.d.ts,types.d.ts,index.d.ts}`,
  `dist/index.d.ts`.
- Behavior authority: senpi `@code-yeongyu/senpi@2026.9.4-3` (MIT)
  `prompt()` inputId + `input_disposition`, `ExtensionRunner.emitInput(..., inputId)`,
  plus Rubato consumers
  `packages/rubato-runtime/src/components/memory/nudge-wiring.ts` and
  `dream-trigger.ts` (`session_abort` cancels the idle timer).
- Stock already had `InputEvent` (no `inputId`) and `abort()` without
  `session_abort`. This patch adds the missing identity + disposition + abort
  event. It does **not** replace AgentSession / the agent loop.

## What this patch does

1. `ExtensionRunner.emitInput` — include `inputId` on the `input` event
   (default `"input"` when omitted).
2. `AgentSession.prompt` — when `input` handlers exist, allocate a
   `randomUUID()` (never the runner default literal `"input"`, never
   `sessionId:counter` which collides across resume of the same session id).
   Pass that id to `emitInput`, then emit `input_disposition` with the **same**
   id:
   - `handled` — extension `action: "handled"`
   - `queued` — streaming steer/followUp queue
   - `started` — admission succeeded, about to `_runAgentPrompt`
   - `rejected` — throw after the input event (no model, streaming without
     `streamingBehavior`, auth failure, …)
   Control/queue callers overlay a prepared id (`prepareInteractiveInput`,
   Rubato `randomUUID` / `clientInputId`) in `session-control.patch`.
3. `AgentSession.abort` — **Senpi gap gate, not always-emit.** Snapshot
   `wasMidRun` / retry backoff / compaction-or-pending, then
   `abortCompaction()` + stock `abortRetry()`/`agent.abort()`.
   Emit `{ type: "session_abort" }` on the runner **and** session subscribers
   only when `!wasMidRun && (hadRetryBackoff || hadCompactionOrPending)`,
   then stock `waitForIdle()`.
   - Mid-run streaming abort: no `session_abort` (`agent_end` carries it).
     Dream timer was already reset by `agent_start`; settle may re-arm.
   - Idle abort with no retry/compaction/queue: no `session_abort` (Senpi).
   - Abort during retry backoff, compaction, or queued continuation: emit once
     before waitForIdle so `dream-trigger` cancels the idle timer.
   Not ported (stock has no equivalent): `AgentAbortProvenance` late-join on
   an open `agent_end` boundary, `abortWillFollow` cleared-queue flag.
4. Public types matching the wired runtime: `InputEvent.inputId`,
   `InputDispositionEvent`, `SessionAbortEvent`, `ExtensionAPI.on` overloads,
   `SessionEvent` / `ExtensionEvent` unions, `AgentSessionEvent`,
   `emitInput` signature, package-root re-exports.

No new payload modules. No `cli-main`. No interactive-mode hunks.

## Consumers (verified against source, not assumed)

`nudge-wiring.ts`:

- `input` with `source === "extension"` is ignored (no pending id).
- `input_disposition` looks up `payload.inputId`; only `queued` and `started`
  increment accepted turns; `rejected` / `handled` do not.

`dream-trigger.ts`:

- `session_abort` cancels the idle timer for that session; a stale timer fire
  launches nothing.

## Apply / verify

```sh
cd <unpacked pi-coding-agent 0.84.2 root>
patch -p1 --fuzz=0 --batch --forward -i reload-guard.patch
patch -p1 --fuzz=0 --batch --forward -i reload-ui.patch
patch -p1 --fuzz=0 --batch --forward -i memory-lifecycle.patch
env -u NODE_OPTIONS node --test --test-timeout=60000 \
  harness/rubato-pi/test/unit/pi-memory-lifecycle.test.mjs
```

## Manifest addition required (not applied this slice)

Lead owns `harness/pi-patches/manifest.json` / applicator. Do not edit them
here. After this patch, the coding-agent package entry needs:

```json
{
  "id": "memory-lifecycle",
  "file": "pi-coding-agent/0.84.2/memory-lifecycle.patch"
}
```

appended **after** `reload-ui` in `packages[].patches` for `pi-coding-agent`.
Per-file sha256 / postimageSha256 for the seven touched files must be
recomputed by the lead's applicator run. Files:

- `dist/core/agent-session.js`
- `dist/core/agent-session.d.ts`
- `dist/core/extensions/runner.js`
- `dist/core/extensions/runner.d.ts`
- `dist/core/extensions/types.d.ts`
- `dist/core/extensions/index.d.ts`
- `dist/index.d.ts`

## Not in this patch

- Compaction-throw-before-input still has no `inputId` (stock order).
- Senpi's extra queue-during-auto-compaction / `_hadClearedQueuedMessages`
  abort gaps.
- RPC `check_reload_veto`, `prepareInteractiveInput`, launcher `cli-main`.
- Needle retune of Rubato loader transforms onto these new events.
