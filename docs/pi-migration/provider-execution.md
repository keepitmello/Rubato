# Provider execution, fallback, and account-policy boundary

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

Status: Cursor's server-driven local tool execution is executable through an actual staged stock
Pi 0.85.1 `AgentSession`. Model fallback and multi-account credential rotation are mapped below but
are not implemented by this feature.

Evidence date: 2026-09-08. Stock/runtime checkpoint: product `ead7cb763`, lab `ad0f551`.
No live credential was read, refreshed, or written, and no external provider request was made.

## Executable Cursor bridge

Stock `@earendil-works/pi-agent-core@0.85.1` executes tool calls only after an assistant response.
It has no `execHandlers`, provider `onToolResult` buffer, or resolved-Cursor-block exclusion in its
unbundled `dist/agent-loop.js`. Cursor is different: its HTTP/2 server can pause a response on an
`ExecServerMessage`, wait for this client to run a tool, and then continue the same response. The
selected provider transport already synthesizes an assistant `toolCall`, marks it with its
module-local `kCursorExecResolved` symbol, and emits one paired `ToolResultMessage` through
`onToolResult` (`features/providers/vendor/pi-ai/api/cursor-agent.js`,
`utils/block-symbols.js`).

`providerExecutionFeature` closes the missing host side with this sequence:

```text
Cursor HTTP/2 exec frame
  -> selected Cursor transport marks one resolved toolCall
  -> createCursorExecBridge translates Cursor args
  -> the bound ExtensionAPI.executeTool validates and runs the registered Pi tool
  -> ordinary tool_call / tool_result hooks and update callbacks run
  -> the result is sent on Cursor's exec channel
  -> agent-loop appends the same one toolResult beside the assistant message
  -> both loop collection and the generic executor skip the resolved toolCall
```

The bridge maps `read`, `ls`, `grep`, `write`, shell-to-`bash`, MCP, and Cursor's Pi-prefixed
read/bash/edit/write/grep/find/ls variants. It reuses the selected transport's exact argument
helpers (`cursor-exec-bridge.mjs:1-8,92-154`) and the active session's registered tool, schema
validation, lazy-activation policy, and extension middleware. It does not construct a second tool
registry or copy Senpi's `AgentSession`.

`executeTool()` now accepts an optional non-empty `toolCallId`. A provider-owned id is passed
unchanged to the underlying tool and both middleware hooks; when omitted, the old
`rubato-<uuid>` generation remains unchanged. Empty/whitespace or non-string ids fail before tool
lookup, hooks, or execution (`features/tool-execution/runtime.mjs:19-60`). This is the necessary
pairing seam: generating a fresh id inside the host would leave Cursor's assistant block and tool
result unrelated.

The one stock loop patch targets
`@earendil-works/pi-agent-core@0.85.1/dist/agent-loop.js`, pristine SHA-256
`6732a1c65c09577d2ffcb716b48e4f4673e57e3e333f10ebfce5132d82e4d7a2`. It:

- passes provider execution lifecycle callbacks and one per-call `onToolResult` buffer;
- emits and appends buffered results immediately after the assistant message, including terminal
  error/abort turns;
- excludes `kCursorExecResolved` blocks both before batch execution and inside the executor;
- appends only newly executed loop results, preventing the provider results from being appended a
  second time.

Keeping the result buffer in the loop is intentional. Stock `ModelRuntime.streamSimple()` returns
a generic asynchronous lazy stream that forwards events and the terminal result but not arbitrary
inner methods. A stream-attached result queue was therefore lost even though the real tool and both
hooks had run. A request-local callback survives that wrapper without global mutable state.

The provider and extension must share exactly one controller:

```js
const execution = createProviderExecution();

createProvidersExtension({
  ...providerOptions,
  routeFactories: {
    ...providerOptions.routeFactories,
    cursor: execution.cursorRouteFactory,
  },
});

// Register this factory in the same ResourceLoader/AgentSession.
execution.extension;
```

Provider construction may happen before the extension binds because tool lookup occurs at request
time. A request before binding fails closed. Each extension generation replaces the prior binding,
and `session_shutdown` clears only its own generation (`provider-execution/extension.mjs:54-92`).
Creating separate controllers for the route and extension leaves the route permanently unbound.

The selected Cursor transport itself owns pending-local-work and drain semantics. It increments its
feature-local stream counter while an exec handler is unsettled, drains every dispatch before
publishing `done`, and bounds the post-`turnEnded` drain. The actual regression holds a real `read`
tool in its `tool_call` hook and proves that the AgentSession prompt remains pending and no HTTP/2
exec result is sent; after release it observes one wire result, one assistant block, one recorded
tool result, and one start/end lifecycle pair. Stock's outer `ModelRuntime` lazy stream does not
forward `hasPendingLocalWork()`, and stock's agent loop has no Senpi-style stream-idle watchdog to
consult it. That watchdog/empty-assistant recovery remains a separate host migration item; this
unit proves drain, not the missing watchdog.

No handler is installed for Cursor delete, diagnostics, approval probes, background shell,
computer use, or other fixed-verdict frames. The selected transport returns its explicit
not-available/rejected response and does not pretend a local tool ran. Adding these requires a
real matching Pi capability and a response-pairing test, not a no-op handler.

## Model fallback contract

Provider prefix remains routing and quota identity. Fallback selectors must retain the complete
`provider/model[:thinking]` identity; a similarly named xAI, Cursor, Codex, or Anthropic model is
not interchangeable merely because its base id resembles another lane.

Current Rubato policy and current Senpi mechanism are distinct:

| Contract | Current Rubato/Senpi behavior | Stock 0.85.1 status in this unit |
|---|---|---|
| Default gate | Rubato writes `retry.modelFallback: false` only when unset and preserves an explicit user value (`session-defaults.mjs:128-145`) | Not ported; no stock retry-fallback controller is claimed |
| Chains when enabled | Senpi layers user keys over family defaults. Fable 5/5.1 and wildcard lanes prefer K3 then Opus; `[]` is an opt-out tombstone (`retry-fallback/settings.js`) | Not ported |
| Candidate admission | Exact/base chain precedes wildcard; skip self, already tried, cooldown-suppressed, unauthenticated, unknown, and provider-declared ineligible candidates (`retry-fallback/chains.js`, `controller.js`) | Stock ModelRuntime has no `isFallbackEligible()` surface |
| Failure policy | Refusal changes model without same-model retry; billing/hard errors can pin; transient/rate-limit behavior follows bounded retry profiles and cooldown; successful compaction releases a refusal pin but not billing | Not ported |
| Revert | Unpinned fallback can return at a turn boundary after cooldown; `never` and pinned state stay on the fallback model | Not ported |

Cursor's `CursorCanaryError.fallbackEligible` and activation decision records classify whether a
failed *activation probe* could use another route. They are diagnostics, not the session model
fallback controller, and the stock native-provider registration does not turn them into one.
Rubato's product default therefore remains “show the selected model's error” unless a later owned
fallback feature ports the explicit-user-enabled policy.

## Account and credential policy contract

Stock 0.85.1 AuthStorage holds one flat API-key or OAuth credential per provider. This bridge uses
that canonical store and performs no credential reads or refreshes of its own. In particular,
Cursor local execution is bound to the session selected by stock ModelRuntime; it does not choose a
second account for a tool call.

Current Senpi's account pool is a separate request-preparation layer:

- stored credentials may contain named `accounts`, an optional pin, and a backward-readable flat
  projection; a new login appends/upserts a slot rather than erasing unrelated accounts;
- numbered API-key variables use the base name and `_2` through `_16`, with gaps allowed;
- rotation starts only when more than one usable slot exists and is disabled by an explicit
  per-request API key, a runtime API key, or provider policy `credentials.rotation: false`;
- a pin wins; otherwise HRW/rendezvous ordering uses the affinity key, normally the session id, so
  stable sessions keep cache/account locality;
- stored credentials outrank ordinary numbered environment slots. Explicit named policy slots can
  still supplement the stored lane;
- auth/billing failures block that account, rate limits apply a bounded persisted cooldown and
  half-open lease, and provider/network faults retry the same account rather than poisoning it;
- rotation is allowed only before committed output. After any non-`start` event, failure carries
  the no-turn-retry marker so text or tool effects cannot be replayed on another account.

Evidence is current Senpi
`core/model-runtime.js:483-639`,
`core/credential-pool/{env-slots,rotation-stream,classify,failover}.js`, and
`core/auth-storage.js:320-370`. Pool health belongs in
`credential-pool-state.json`; it is not provider configuration and must not be written into the
stock flat auth record.

Model fallback and account failover must remain two layers. Account failover retries the same
provider/model before committed output; model fallback deliberately changes the selected model at
the session layer. This feature implements neither layer. Until a separately owned stock seam is
mock-tested, existing pooled `auth.json` data must not be rewritten by stock AuthStorage and pool
or fallback parity must not be reported.

## Source closure and license

The feature-owned runtime closure is three staged files inside selected stock pi-ai:

```text
dist/rubato-features/provider-execution/extension.mjs
dist/rubato-features/provider-execution/cursor-exec-bridge.mjs
dist/rubato-features/provider-execution/THIRD_PARTY_NOTICES.md
```

It imports only the already selected provider closure's Cursor argument helpers. There is no new npm
dependency: HTTP/2/protobuf remains owned by the providers feature, including exact
`@bufbuild/protobuf@2.14.0`. The bridge is derived from
`@code-yeongyu/senpi@2026.9.4-3`; its full MIT notice is staged with the feature. The shared
tool-execution feature remains Rubato-owned runtime glue and adds no package dependency.

## Credential-free verification

Run the focused actual-SDK regression with three fresh roots and no inherited Node instrumentation:

```sh
TEST_HOME=$(mktemp -d /tmp/rubato-provider-exec-home.XXXXXX)
TEST_AGENT=$(mktemp -d /tmp/rubato-provider-exec-agent.XXXXXX)
TEST_ENGINE=$(mktemp -d /tmp/rubato-provider-exec-engine.XXXXXX)
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  HOME="$TEST_HOME" \
  PI_CODING_AGENT_DIR="$TEST_AGENT" \
  RUBATO_PI_CODING_AGENT_DIR="$TEST_AGENT" \
  RUBATO_ENGINE_DIR="$TEST_ENGINE" \
  RUBATO_SPEED_INDEX=0 \
  RUBATO_NO_KIRO_ENSURE=1 \
  PI_OFFLINE=1 \
  node --test harness/pi-runtime/features/provider-execution/provider-execution.test.mjs
```

The test stages real stock SDK packages plus `tool-execution`, `providers`, and
`provider-execution`; starts a local HTTP/2 Cursor server; writes only a fake token to its own
temporary `auth.json`; runs the stock `read` tool against a temporary file; and asserts request
blocking, drain, exact call-id propagation, middleware hooks, lifecycle events, wire output,
transcript pairing, and no duplicate execution. It also rejects an invalid supplied id before any
hook and verifies the omitted-id `rubato-<uuid>` behavior. It never falls back to HOME, the original
Senpi runtime, or a live provider.

The remaining exact gaps are: the stock-host stream-idle/empty-assistant watchdog, credential
pools and their login/refresh merge, model retry/fallback and fallback UI/events, error outcome
metadata that cannot be inferred if a third-party `tool_result` hook replaces all details, and real
capabilities for the unsupported Cursor exec variants above.
