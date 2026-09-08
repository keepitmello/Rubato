# Context-window migration contract

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

## Result and boundary

This slice gives stock `@earendil-works/pi-coding-agent@0.85.1` the two
extension-context operations required by Rubato's existing context-notes
controller:

```ts
getMessageRevision(): number
applyCompaction(
  precomputed: CompactionResult,
  options: { reason: "extension"; expectedRevision?: number; signal?: AbortSignal },
): Promise<
  | { applied: true; reason: "ok" }
  | { applied: false; reason: "stale" | "rejected" }
>
```

The notes controller remains the feature owner. It still creates and validates
the next window, persists the PREPARE marker, supplies the bootstrap carrier,
and detects a committed-but-incomplete transition. The Pi patch only provides a
revision/commit seam, a final provider-admission gate, and the next-turn live
message refresh. It does not copy Senpi's `AgentSession`, compaction classes, or
speculative/idle lane machinery.

`context-window` has a build-time dependency on the additive `context-notes`
files because its narrow stock hooks import the current Rubato
`engine-gate.mjs`. Root catalog/bootstrap registration is intentionally outside
this feature-owned patch manifest.

## Source-backed hook map

| Entry | State/event | Consumer | Cleanup/failure | Stock 0.85.1 gap and hook |
|---|---|---|---|---|
| `ContextNotesController.roll()` (`harness/rubato-pi/src/context-notes/controller.mjs:294`) | PREPARE marker, `expectedRevision`, precomputed bootstrap | `ctx.applyCompaction()` | Refreshes authoritative journal after both success and exception; a committed post-hook failure is quarantined and never retried | Stock extension context had neither operation. `dist/core/extensions/{types.d.ts,runner.js,runner.d.ts}` now carry only these two closures. |
| `AgentSession.applyCompaction()` (build patch) | Checks abort, revision, current prepared leaf, note freshness; appends one `fromHook` compaction and rebuilds `agent.state.messages` | Existing controller and any future precomputed-window owner | Stale/busy/invalid inputs append nothing. A failure after append emits failure and is re-read by the controller as committed-incomplete. | Reuses the append/rebuild shape already present in stock manual compaction (`dist/core/agent-session.js:1539`) without auth, summary generation, or provider calls. |
| `_installAgentNextTurnRefresh()` (`dist/core/agent-session.js:289`) | Compares the local loop's old `turn.context` with live window messages | `pi-agent-core`'s next tool-loop provider call | One-shot by content identity: when both carry the current window, stock context remains unchanged | Stock agent loop retains a local `currentContext`; replacing only `agent.state.messages` during `turn_end` otherwise leaves the next provider call on the old window. |
| `createCompactionSummaryMessage()` (`dist/core/messages.js:48`) | Recognizes a Rubato bootstrap summary | Session context builder and provider conversion | Summary mode remains stock behavior | Without the hook, Pi wraps the bootstrap in a generic compaction-summary prompt and the notes extension injects a second carrier. The hook returns the existing exact bootstrap user message instead. |
| SDK `transformContext` (`dist/core/sdk.js:227`) | Final `assertSessionReady(sessionManager, transformed)` | Last boundary before `convertToLlm` and provider dispatch | Missing/broken notes owner aborts the run and throws before stream dispatch | Stock `ExtensionRunner.emitContext()` records handler errors and continues, so the extension handler alone was not fail-closed. |
| `SettingsManager.getCompactionSettings()` (`dist/core/settings-manager.js:565`) | Dynamic history-notes mode returns `enabled:false` | All stock automatic compaction checks | Summary mode returns untouched stock settings | Stock has manual and automatic compaction but no Senpi speculative/idle/restoration lanes. The existing `session_before_compact` veto remains defense in depth for manual/RPC calls. |
| Anthropic server compaction guard (`harness/rubato-pi/src/anthropic-server-compaction.mjs:48`) | `historyNotesEnabled()` makes support false | Provider fetch rewrite | Body and headers pass through unchanged | Stock Pi itself has no server-compaction injector. Rubato's provider adapter already owns the only injector and is bypassed in notes mode. |

## Atomicity and races

The successful commit has no callback or `await` between its final checks and:

1. `SessionManager.appendCompaction(...)` with the controller's values unchanged;
2. `SessionManager.buildSessionContext()`;
3. assignment of the new live `agent.state.messages`;
4. revision refresh.

The start event is deliberately published after this synchronous commit. That
prevents a synchronous event listener from changing the checked branch between
validation and persistence. `session_compact` and `compaction_end` follow in
the same order as the stock success lifecycle.

The revision token observes the persisted leaf plus the live message list's
length and tail identity. This covers stock/Rubato engine-owned appends,
rebuilds, removals, branch changes, custom entries, and tool turns. The commit
also runs the existing `assertTransitionCommit()` immediately before append,
which checks `preparedLeafId`, the PREPARE/window identity, and checkpoint
freshness. An already-aborted signal or a changed revision returns `stale`
without emitting or appending anything. Concurrent calls cannot both win:
the first synchronous commit changes the leaf/revision and owns the compaction
controller before its first await.

This is atomic against JavaScript interleaving, not a new transactional storage
engine. Stock `SessionManager` mutates its in-memory tree and persists through
its existing synchronous append path. A filesystem failure after an in-memory
append, or a failing post-commit extension hook, can still leave a durable or
in-memory boundary whose live follow-up failed. The unchanged controller's
post-error journal refresh identifies that state and blocks a duplicate cut.

## No-prune and compaction ownership

Stock 0.85.1 has no Senpi `lane-policy`, speculative/idle/restoration
compaction, or context-prune pipeline. Its agent loop appends every tool result
before `turn_end`; its compaction cut finder does not select a tool result as a
cut point. Therefore copying Senpi's pruning/repair modules would add an unused
second engine.

In history-notes mode:

- the settings gate disables every stock automatic threshold/overflow entry;
- the existing `session_before_compact` handler rejects manual, RPC, and
  extension-driven stock summaries;
- `new_context` alone uses the precomputed atomic seam;
- provider-ready context is checked by the registered session gate;
- Rubato's Anthropic wrapper does not add the server compaction beta or
  `context_management` edit.

The actual SDK test also preserves an assistant tool-call and its matching tool
result together in the provider input immediately before the cut. The next
provider input contains one bootstrap user message, not a pruned/orphaned pair,
old user text, note body, or generic summary wrapper.

## Verification

Run with the workspace's selected stock install and without inherited Node
loaders/caches:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  node --test harness/pi-runtime/features/context-window/context-window.test.mjs
```

Verified locally on 2026-09-08:

- descriptor/hash/drift and composition with reload, service-tier,
  input-lifecycle, abort-provenance, request-run, extension-rpc,
  session-catalog, providers, and context-notes;
- actual SDK `notes_write_file -> new_context -> next provider turn`, exactly
  one context-window compaction for the controller transition, exact bootstrap
  carrier, persistent journal, complete pre-cut tool pair, and no
  summarizer/provider side call;
- two simultaneous `applyCompaction()` calls carrying the same valid revision,
  with exactly one committed winner and one stale loser;
- stale revision after a real custom-entry append and an already-aborted signal,
  both with zero additional compaction entries;
- fail-closed SDK provider admission when the notes owner is absent;
- history-notes Anthropic server-compaction wire bypass with body/headers
  unchanged;
- actual unbundled RPC tool invocation, `compaction_end(reason="extension")`,
  `get_entries` read-back, extension-RPC revision read, stale race, abort, and
  unchanged one-boundary count.

Result: 4 tests passed, 0 failed. No network provider, live profile, original
checkout, shared stock fixture, or paid API was used.

## Remaining integration boundary

- Root still owns catalog dependency ordering and bootstrap registration. Until
  `context-notes` and `context-window` are selected together, the public runtime
  must remain unregistered; enabling only the additive notes extension would
  reintroduce the previous `/new-context` failure.
- Summary-mode Anthropic server-compaction activation still depends on the
  provider feature's stock marker/lane integration. This slice proves only the
  required history-notes bypass and does not claim summary-mode provider parity.
- Full TUI rendering, remote socket/gateway transport, and launcher/auth are
  separate lanes. The same stock SDK and unbundled RPC semantics are verified
  here; no live remote connection was made.
- Direct host code can mutate the public `session.state.messages` objects
  in-place without a session entry. That is outside the extension/controller
  contract. There is no asynchronous or callback boundary between the
  controller's revision capture and the final commit checks, so this does not
  open a race on the supported path.
