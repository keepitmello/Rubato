# Provider, auth, and model migration boundary

Status: executable boundary started; the stock runtime is not yet the Rubato default.
Evidence date: 2026-09-08. Product baseline: `1f6ca5392a554b8b27126e6d016b0ffc00260707`.

This map compares these exact source trees without reading credentials, logging in, refreshing a
token, or making a provider request:

- stock `@earendil-works/pi-coding-agent@0.85.1` under `harness/pi-runtime/node_modules/`;
- its nested stock `@earendil-works/pi-ai@0.85.1` and `pi-agent-core@0.85.1`;
- pinned `@code-yeongyu/senpi@2026.9.4-3` under the original checkout's `node_modules`;
- Rubato provider sources under `harness/rubato-pi/src/`.

## Resulting executable boundary

The admitted product lanes are one ordered value, not seven unrelated conditionals:

```text
openai-codex -> xai -> cursor -> anthropic -> kiro -> google-antigravity -> opencode
```

`provider-capabilities.mjs:8-16` owns that value. `provider-ids.mjs` re-exports it, and
`provider-direct.mjs:48` uses the same object. `validateProviderAdmission()`
(`provider-capabilities.mjs:33-64`) rejects a malformed, duplicate, missing, unexpected, or reordered
factory result. `provider-overlay.mjs:83-95` completes that validation before either legacy or
Antigravity credential import and before the first `registerProvider` call. Thus a structurally bad
factory result makes zero credential-import or registration writes. A later host exception from an
individual `registerProvider` is not transactional; Pi exposes no batch/rollback registration API.

Native provider loading is now explicit and injectable. `nativeProviderFactoryLoader(piAiRoot)`
(`provider-direct.mjs:178-192`) resolves only `piAiRoot/dist/providers/<file>` and fails on a missing
file/export without falling back to Senpi or global module resolution. `directProviders()` accepts
that loader and separately injectable Cursor/Kiro/Antigravity constructors
(`provider-direct.mjs:247-268`). The production default still points at pinned Senpi until the full
candidate is composed. A stock-backed test already drives the actual 0.85.1 Codex, xAI, Anthropic,
and OpenCode factories through the Rubato decorators, fills the other three lanes with injected
route-contract providers, and admits the resulting all-seven vector through the real overlay.

The minimum maintained module boundary is therefore:

1. **runtime resolver (root-owned):** supplies one verified `pi-ai` package root and the stock host;
2. **native factory adapter:** loads Codex/xAI/Anthropic/OpenCode and applies only Rubato model/auth
   presentation policy;
3. **product route adapters:** Cursor, Kiro, and Antigravity own vendor-specific transport/lifecycle;
4. **pure admission:** validates the complete ordered provider vector before stateful overlay work;
5. **stream decorator:** owns Rubato measurement, cancellation, retry-settlement, cache audit, and
   local-work signal preservation without implementing a transport;
6. **small stock patches:** only where an extension/provider API cannot express required behavior.

Do not copy Senpi's complete `pi-ai` tree. The selected closure is listed below.

## Current seven-lane map

| Product identity | Current request/stream path | Auth and catalog | Stock 0.85.1 status | Retained Rubato/Senpi behavior |
|---|---|---|---|---|
| `openai-codex/<id>` | Senpi `openaiCodexProvider()` -> Codex Responses WS/SSE -> Rubato stream decorator | stock/Senpi OAuth; legacy import only when target lacks it; static catalog | Native factory exists (`providers/openai-codex.js:6`), but stock catalog has no `-fast` rows and its request builder is behind selected Senpi behavior | 272K cap; Daybreak base/fast; selected picker; priority `/fast`; Astra configuration updates; WS/cache fixes; pool semantics |
| `xai/grok-4.6` | Senpi `xaiProvider()` -> OpenAI Responses-compatible xAI endpoint -> decorator | `XAI_API_KEY` or OAuth; legacy import eligible | Native factory and xAI device OAuth exist (`providers/xai.js:6-22`, `auth/oauth/xai.js:114-189`) | 65,536 output cap; `xhigh`; xAI priority `/fast`; pools |
| `cursor/<id>` | Senpi Cursor HTTP/2 Connect `AgentService/Run` -> Rubato canary/picker/error wrappers -> decorator | Cursor OAuth; per-account `GetUsableModels`; activation marker bound to credential+catalog generation | **Absent.** Zero source hits for Cursor runtime/provider in stock non-bundle sources | Entire selected Cursor transport closure, server-driven tool lifecycle, local-work heartbeat, catalog grouping, OAuth, canary, Grok Fast pin, Gemini 3.8 grouping |
| `anthropic/<id>` | native Anthropic Messages -> setup-token fallback -> Rubato effort/server-compaction fetch wrappers -> decorator | stored OAuth/API key or Anthropic env; then setup-token file, then Keychain | Native provider exists. Factory differs from Senpi only by Senpi's two direct stream exports; underlying API implementation still differs | selected picker/Fable compatibility; setup-token; Opus fast body+beta; mid-conversation effort marks; server compaction; pools |
| `kiro/<id>` | Rubato `createProvider()` + Anthropic Messages API -> loopback `kiro.rs` at `127.0.0.1:8990`; sidecar ensure happens at first stream | stored key, then `KIRO_API_KEY`, then Rubato Kiro config; no OAuth | **Absent as a provider.** Stock `createProvider` and Anthropic API are reusable | loopback-only gate, two-model catalog, lazy sidecar recovery; no `/fast` because it is a gateway path |
| `google-antigravity/gemini-3.8-flash` | Rubato Antigravity API adapter -> Google internal endpoint; state keyed by profile/provider/model/session/branch/generation | Rubato Google OAuth; parent-only one-time Keychain import; project id carried in credential env | **Absent** | OAuth/login/refresh, project discovery, state/lineage reset on tree and accepted compaction |
| `opencode/muse-spark-1.3-contributor-free` | native OpenCode provider -> decorator | native env/stored API key, then macOS Keychain fallback; no Rubato OAuth | Native factory/catalog exists and is newer/more complete than the pinned Senpi catalog | picker restriction and Keychain fallback only |

Evidence anchors:

- actual composition and order: `harness/rubato-pi/src/provider-direct.mjs:247-326`;
- overlay auth/admission/register/unregister order: `harness/rubato-pi/src/extensions/provider-overlay.mjs:68-162`;
- stock builtins include the four native factories: stock `pi-ai/dist/providers/all.js:52-103`;
- stock Cursor/Kiro/Antigravity absence: a non-bundle source search for
  `cursor-agent|cursor-cli-oauth|kiro|antigravity` returned no hits;
- Cursor's dynamic catalog/protocol contract: pinned Senpi
  `pi-ai/dist/providers/cursor.js:9-92`; Rubato canary/publish gate
  `cursor-route.mjs:422-640`;
- Kiro config/auth/provider construction: `kiro-route.mjs:124-203,225-291`;
- Antigravity OAuth/provider/lifecycle: `antigravity-route.mjs:116-203,221-310`.

## Model identity, aliases, effort, and `/fast`

Provider prefix is routing identity, not decoration. Keep `xai/grok-4.6`,
`cursor/cursor-grok-4.6`, `openai-codex/gpt-5.6-sol`, and similarly named models in other
providers distinct; they use different credentials, quotas, and transports.

The current picker policy is explicit (`picker-catalog.mjs:6-25`):

- Codex: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, and
  `gpt-daybreak-blue-latest`;
- xAI: `grok-4.6`;
- Anthropic: `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`,
  `claude-haiku-4-5`;
- OpenCode: `muse-spark-1.3-contributor-free`;
- Cursor: `cursor-grok-4.6`, `gpt-5.6-sol`, `claude-fable-5-1`, `claude-opus-5`,
  `gemini-3.8-flash`, `kimi-k3`, `composer-2.5` (`cursor-picker.mjs:14-22`).

Picker filtering does not delete the provider's stored catalog. Daybreak is derived from Terra and
adds low/medium/high/xhigh/max (`provider-direct.mjs:105-165`). Fable 5.1 is derived only if the
native catalog lacks it (`provider-direct.mjs:127-137`). xAI keeps the native thinking map and caps
`maxTokens` to 65,536 so `max_output_tokens` remains stable across turns
(`provider-direct.mjs:212-236,280-284`).

`/fast` has three different wires and one persistence surface:

- Codex: `service_tier: "priority"`; current Senpi has `-fast` catalog aliases whose
  `upstreamModelId` is the base model. Stock 0.85.1 has the base models but no `-fast` rows.
- xAI: also `service_tier: "priority"`, but the provider is `xai` and the API is OpenAI
  completions/responses-compatible.
- direct Anthropic Opus 5/4.8: body `speed: "fast"` plus beta
  `fast-mode-2026-02-01`; Kiro and other Anthropic-message gateways are excluded.
- Cursor Grok Fast is not `/fast`: the visible base `cursor-grok-4.6` is pinned at request time to
  `cursor-grok-4.6-{low|medium|high|xhigh}-fast`
  (`cursor-grok-fast.mjs:13-23,109-178`).

Senpi's builtin service-tier module owns `/fast`, per-base-model SettingsManager memory, model-switch
restore, the session fast flag, and `before_provider_request`
(`senpi/dist/core/extensions/builtin/service-tier.js:51-135,135-266`). Rubato's current transform
extends it for xAI and Anthropic and preserves fast identity across restart
(`transforms/core-service-tier.mjs:3-91`). Stock Pi has no corresponding unbundled builtin module.

That behavior is now selected into `harness/pi-runtime/features/service-tier/extension.mjs`. It uses
stock `registerCommand`, `model_select`, `session_start`, and `before_provider_request` hooks and the
real stock AgentSession request path. Two exact-preimage patches in `patches.mjs` add only
`SettingsManager.getModelServiceTier()` / `setModelServiceTier()` and the corresponding declaration.
The value is persisted in the normal global settings file as
`modelServiceTiers["<provider>/<base-model-id>"] = "priority" | "auto"`; the explicit `auto` value
is what keeps `/fast off` disabled after restart. The runtime descriptor stages the extension and
its MIT notice under `rubato-features/service-tier/` so the extension resolves the patched stock SDK
from the selected staged root, rather than importing this source checkout's package graph.

For the stock CLI, the extension calls `SettingsManager.create(ctx.cwd, undefined, ...)`, so the
settings root is stock Pi's normal `PI_CODING_AGENT_DIR` (or its stock default). Stock 0.85.1's
extension context does **not** expose `agentDir` or `serviceTier`. An SDK host that supplies an
explicit AgentSession `agentDir` must therefore create the feature with the same `{ agentDir }` (or
an explicit `settingsManagerFactory`); silently guessing a directory would split persistence.
The stock model registry also has no service-tier resolver, so catalog `serviceTier` and
`upstreamModelId` are read from a model only when an owned alias supplies them. Stock's base models
need no aliases for the three direct request wires.

`createServiceTierFeature()` exposes `getState()` and `onChange()` as the small host boundary for
footer/lightning and RPC `fastMode` state. Those host consumers are not connected in this unit;
their current behavior remains a required follow-up, not a removed feature. Stock has no public
`setSessionFastMode` API, so this extension does not pretend that such a hook exists.

The live toggle and persisted preference have intentionally different scopes, matching the latest
Rubato transform. Once `/fast on` is active, that session intent survives a model switch while the
incoming model supports a fast wire (including Codex-to-Codex); switching to Kiro or another
unsupported model turns it off. Disk memory remains keyed per model, so the incoming model is not
silently written and its own value controls a fresh session/reload. This distinction is covered by
an actual stock AgentSession regression rather than inferred from settings alone.

## Auth and credential lifecycle

The current overlay sequence is:

```text
build all providers
  -> validate complete ordered set
  -> import eligible legacy Codex/xAI entries (never overwrite)
  -> reject only damaged-store blockers; unauthenticated `absent` is allowed
  -> parent-only Antigravity Keychain import/project resolution
  -> register all seven
  -> register Antigravity lifecycle and Cursor notice
  -> unregister foreign builtins
```

Legacy import is deliberately only `openai-codex` and `xai`
(`credential-import.mjs:18,185-266`). It validates each candidate and the target with the engine's
auth parser, merges under a file lock, preserves existing target entries, and never copies Cursor,
Anthropic, Kiro, Antigravity, or OpenCode credentials. Tests refuse live credential paths.

Anthropic setup-token resolution is fallback-only: stored/native OAuth or API key and Anthropic env
win first; otherwise Rubato reads the configured/default setup-token file and then Keychain. It does
not own login or refresh (`anthropic-setup-token.mjs:209-292`). OpenCode follows the same native-first
shape, with Keychain service `opencode.ai` (`opencode-keychain.mjs:20-108`). Kiro uses stored key,
then `KIRO_API_KEY`, then its config file and accepts only a loopback endpoint
(`kiro-route.mjs:133-203,243-291`). Antigravity imports from Keychain only in the parent, resolves a
project id before write where possible, validates before a locked merge, and thereafter its provider
OAuth owns refresh (`antigravity-keychain-import.mjs:204-301`, `antigravity-route.mjs:139-203`).

Stock AuthStorage supports one flat `api_key` or OAuth credential per provider and locked
read/modify/delete/list (`stock coding-agent/dist/core/auth-storage.js:157-231,263-412`). It does not
validate or select `accounts`. Current Senpi preserves a backward-readable flat projection plus
named `accounts`, optional pin, append-on-login, named refresh merge, numbered env slots, HRW/session
affinity, cooldown/half-open health, and pre-output-only failover. The model runtime enters rotation
only for multiple slots and never for an explicit request key or runtime key
(`senpi/dist/core/model-runtime.js:17-23,483-639`). Post-output failure is prefixed
`senpi:no-turn-retry:` so the session layer cannot replay committed text/tool output.

This pool behavior is genuinely retained product behavior. It requires a narrow stock host seam in
model request preparation and credential login/refresh storage; provider factories alone cannot
implement it. Until that seam exists and is mock-tested, stock AuthStorage must not be declared
parity-complete and existing `auth.json` pools must not be rewritten by stock code.

## Request, cache, recovery, and compaction interactions

The outer Rubato decorator is transport-neutral. It wraps both top-level native streams and nested
`provider.api` streams while preserving every other provider field
(`rubato-stream.mjs:594-640`). Its Proxy binds unknown methods/properties back to the original stream,
so `result()`, iterator `return()`, `hasPendingLocalWork()`, and `trackLocalWork()` survive; cancellation
and terminal settlement remain attached to the underlying transport
(`rubato-stream.mjs:344-498`). It also enforces no turn retry after emitted text/tool deltas and keeps
pre-output errors retryable.

For direct Anthropic only, the decorator adds mid-conversation effort and server-compaction fetch
wrappers (`rubato-stream.mjs:537-567`). Effort keeps the top-level value frozen and inserts an empty
system configuration mark at the original message index, excluding `cache_control` from the lineage
fingerprint so cache-breakpoint motion is not mistaken for compaction
(`mid-conversation-effort.mjs:1-47,91-135,166-220`).

For Astra, Rubato similarly freezes request-level effort and inserts Responses
`configuration_update` at its original input index; moving the item would invalidate the prompt
prefix (`transforms/misc-astra-codex.mjs:3-60`). The same patch strips temperature and preserves
thinking/text signatures on WebSocket continuation (`:62-114`). A source-only probe against stock
0.85.1 failed at the configuration-update anchor: stock lacks the selected Senpi extra-body/reasoning
builder shape. This needs a stock-specific minimal patch, not blind reuse of the old transform.

Current cache policy keeps user subkeys while enforcing cache-aware timeouts and a 300-second safety
buffer (`session-defaults.mjs:48-68,112-150`). Rubato's Senpi patches extend GPT-5.6+ prompt-cache TTL
to 1,800 seconds and Codex WebSocket idle cache to 30 minutes, with an unref'd timer
(`transforms/misc-prompt-cache-ttl.mjs:3-29`,
`transforms/misc-codex-ws-cache-ttl.mjs:3-24`). The WebSocket TTL transform applied cleanly to stock
0.85.1 in a read-only source probe. Stock 0.85.1 no longer has the standalone
`utils/prompt-cache-ttl.js`, so that old transform has no target and its policy must move to the stock
request/host timeout boundary.

Current empty-assistant recovery buffers start/thinking until visible output. Rubato patches its
outer stream to report upstream activity and delegate local work, preventing the 90-second start
watchdog from killing a live long-thinking or Cursor-exec request
(`transforms/core-empty-recovery.mjs:3-85`). Stock pi-agent-core 0.85.1 has no
`empty-assistant-recovery.js` and the source search found no equivalent symbol; whether stock moved
the behavior into its coding-agent bundle or removed it is still an open runtime trace. Do not drop
the behavior merely because the old patch path vanished.

Accepted compaction invalidates effort lineage naturally (first-message fingerprint changes) and
explicitly advances Antigravity's conversation generation after dropping per-session state
(`antigravity-route.mjs:293-310`). Auxiliary title/summary/compaction streams are classified separately
by the decorator so they do not overwrite main-turn speed measurements. Stock-host compaction and
empty-recovery ordering still needs a response-mock combination test.

## Builtin registration and settings

Current settings disable `claude-sdk-oauth`, `cursor-cli-oauth`, `anthropic-web-search`, and
`websearch` while preserving unrelated user keys (`session-defaults.mjs:14-46,112-150`). The overlay
registers the seven product providers first and then unregisters foreign builtin ids; same-id
last-registration behavior is why the order matters. Stock ModelRuntime provides native and config
registration/unregistration and an offline refresh (`stock model-runtime.js:549-599`). Current Senpi
additionally wires registered OAuth handlers into runtime credentials and supports a no-refresh
registration option (`senpi model-runtime.js:748-816`). Root owns the final complete builtin snapshot;
this document only fixes the provider-side ordering and exclusions.

## Selected source/package closure and licenses

The stock recursive installation is exactly locked by `harness/pi-runtime/package-lock.json`; do not
reconstruct it from a hand list. The provider boundary directly requires stock
`@earendil-works/pi-ai@0.85.1`; its manifest dependencies are
`@anthropic-ai/sdk@0.123.0`, `@aws-sdk/client-bedrock-runtime@3.1048.0`,
`@earendil-works/pi-telemetry@^0.85.1`, `@google/genai@1.52.0`,
`@smithy/node-http-handler@4.7.3`, `http-proxy-agent@7.0.2`,
`https-proxy-agent@7.0.6`, `openai@6.40.0`, `partial-json@0.1.7`, and
`typebox@1.3.7` (`stock pi-ai/package.json:66-89`). Pi, pi-ai, pi-agent-core, pi-tui, chord, and
pi-telemetry are MIT; the lockfile is the authority for every transitive version/license.

Selected Senpi-derived material that has no stock replacement must be ported as owned modules, not
by copying the package:

- service tier: selected as the Rubato-owned stock ExtensionAPI module
  `harness/pi-runtime/features/service-tier/extension.mjs`, two exact-hash SettingsManager patches,
  and `THIRD_PARTY_NOTICES.md`; no non-core runtime package or data asset;
- credential pools: Senpi core `credential-pool/{env-slots,rotation-stream,state-store,classify,
  failover}.js`, the minimum request/login/refresh hooks, and pi-ai
  `auth/pool/{select,slots}.js`. Runtime packages are `proper-lockfile@4.1.2` (MIT) and the actually
  resolved `zod@3.25.76` (MIT); state is the existing mode-0600
  `credential-pool-state.json`, containing health/HMAC revisions but no credential material;
- Cursor provider/catalog/OAuth eager closure:
  `providers/cursor.js`, `api/{cursor-agent.lazy,lazy}.js`,
  `auth/{context,credential-store,helpers,resolve}.js`, `auth/oauth/{load,cursor,pkce}.js`,
  `auth/pool/slots.js`, `cursor/{catalog-grouping,model-capabilities,store-migration}.js`,
  `models{,-store}.js`, `utils/{abort,diagnostics,event-stream}.js`, and asset
  `cursor/cursor-variant-aliases.json`;
- Cursor Node-only transport closure loaded by the lazy boundary:
  `api/cursor-agent.js`, `api/cursor-agent/{deterministic-id,exec-lifecycle,exec-modern,measure,
  pi-args,reasoning-params,stream-retry}.js`, generated `api/cursor-agent/gen/agent_pb.js`,
  `api/{cursor-conversation-rotation,cursor-task-args,lazy}.js`,
  `cursor/{composer-prompt,model-capabilities,selection-descriptor}.js`, `session-resources.js`,
  `utils/{abort,block-symbols,diagnostics,event-stream,headers,json-parse,sanitize-unicode}.js`,
  `models{,-store}.js`, `auth/{context,credential-store,resolve}.js`, `auth/pool/slots.js`, and the
  same alias JSON. External runtime packages are `@bufbuild/protobuf@2.14.0`
  (`Apache-2.0 AND BSD-3-Clause`) and `partial-json@0.1.7` (MIT), plus Node
  `crypto`, `fs`, `http2`, and `path`;
- Rubato uses Senpi's module-local `utils/block-symbols.js` identity today. A stock boundary must
  source that symbol from the selected Cursor module or expose it through an adapter; recreating it
  with `Symbol.for()` is not equivalent.

All selected Senpi packages inspected here (`senpi`, its pi-ai, pi-agent-core, and pi-tui aliases)
declare MIT. License texts and attribution must accompany any copied/derived source. The generated
Cursor protobuf file and alias JSON are required assets, not optional source-map material. `.d.ts`,
`.map`, tests, unrelated providers/APIs, and the rest of the Senpi pi-ai tree are not in the runtime
closure above.

## Verification path and remaining unknowns

Completed without network or credential access:

- `node --test harness/rubato-pi/test/unit/provider-capabilities.test.mjs`: 4/4 passed;
- isolated Bun run of `provider-direct.test.mjs`: 50/50 passed, including actual stock 0.85.1
  factories, no-fallback loader failure, all-seven overlay admission, and zero auth/registration work
  for an incomplete stock-backed result;
- isolated Node run of `features/service-tier/service-tier.test.mjs`: 7/7 passed against a copied,
  patched actual stock 0.85.1 SDK. It exercised real SettingsManager file persistence, `/fast on` and
  `/fast off`, per-model persistence, Codex-to-Codex live-intent preservation, model switch,
  extension reload, fresh AgentSession restart,
  Codex/xAI `service_tier`, direct Anthropic `speed` plus beta, and Kiro/unsupported exclusions;
- source SHA comparison: stock and Senpi provider factory files are identical for Codex, xAI, and
  OpenCode; Anthropic differs only by Senpi's exported direct stream aliases;
- read-only transform probes: Codex WS TTL applies to stock; Astra patch drifts; old prompt-cache TTL
  and empty-recovery target files are absent.

The full provider test is reproducible without resolving an engine or credential profile from the
user's home directory. The temporary top-level symlink only supplies the pinned dependency tree to
legacy test cases; the stock tests pass their `harness/pi-runtime` pi-ai root explicitly, and a
missing stock export is required to fail rather than fall back through that symlink:

```sh
cd /Users/wy/Github-repos/rubato-lab/worktrees/pi-adapter-0851
ln -s /Users/wy/Github-repos/rubato-lab/rubato/node_modules node_modules
isolated_engine="$(mktemp -d /tmp/rubato-provider-engine-0851.XXXXXX)"
trap 'unlink node_modules; rmdir "$isolated_engine"' EXIT
env NODE_TEST_CONTEXT=child-v8 \
  RUBATO_ENGINE_DIR="$isolated_engine" \
  RUBATO_SPEED_INDEX=0 \
  bun test harness/rubato-pi/test/unit/provider-direct.test.mjs
```

`NODE_TEST_CONTEXT` activates the live-auth refusal gate. Individual credential tests inject their
own temporary `RUBATO_LEGACY_AUTH_PATH` and `RUBATO_TARGET_AUTH_PATH`; do not set a process-wide
`*_CODING_AGENT_DIR`, because doing so would replace the live-path guard that one safety test
deliberately exercises.

The service-tier run is separately reproducible with an empty home/profile. It copies and patches
the stock package into its own temporary directory, injects that actual SettingsManager into the
extension, replaces every provider stream with a local in-process fake, and makes no provider or
credential call:

```sh
cd /Users/wy/Github-repos/rubato-lab/worktrees/pi-adapter-0851
isolated_home="$(mktemp -d /tmp/rubato-service-tier-home-0851.XXXXXX)"
trap 'rmdir "$isolated_home"' EXIT
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  HOME="$isolated_home" \
  PI_CODING_AGENT_DIR="$isolated_home/pi-agent" \
  PI_OFFLINE=1 \
  node --test --test-timeout=30000 \
    harness/pi-runtime/features/service-tier/service-tier.test.mjs
```

Next response/mock checks, in order:

1. use the isolated stock runtime resolver to supply the loader root; mock fetch/WS responses for the
   four native providers and assert request body, event stream, abort, and terminal settlement;
2. connect the service-tier `getState()` / `onChange()` bridge to existing footer/lightning and RPC
   `fastMode` consumers, without adding a private AgentSession mutation API unless composition proves
   one is necessary;
3. add the minimum stock host credential-pool hooks and exercise two mock accounts: HRW affinity,
   pre-output 429 rotation, post-output no-retry, refresh merge, and flat backward compatibility;
4. stage the selected Cursor closure and run its existing response/protobuf mocks, including
   server-driven tool `hasPendingLocalWork`, canary, cancellation, and catalog migration;
5. run combined long-thinking -> empty recovery -> compaction mocks and verify no watchdog false
   timeout or stale Antigravity/Cursor state;
6. only then run isolated copied-profile startup/resume. Live OAuth/provider calls remain separately
   authorized verification and are not evidence in this map.

Unknowns that block a parity claim:

- the final bootstrap consumer for the staged service-tier extension and its footer/lightning/RPC
  state bridge; the direct `/fast` request and SettingsManager paths themselves are verified;
- the stock location or absence of empty-assistant retry behavior and its watchdog ordering;
- a stock-specific Astra `configuration_update`/extra-body patch and prompt-cache timeout owner;
- the smallest stable stock ModelRuntime/AuthStorage hook for account pools without forking the
  runtime;
- Cursor package export/bundle integration for the selected generated protobuf and lazy Node module;
- full builtin registration parity, final distribution/CLI entry, live auth refresh, and paid model
  behavior. Those are deliberately not claimed complete.
