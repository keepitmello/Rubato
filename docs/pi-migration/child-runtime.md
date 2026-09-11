# Child runtime binding

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

Rubato task and team children use an explicit stock-Pi runtime descriptor. The
descriptor is passed to `buildRpcSpawn(spec, runtime)` by the Rubato runner
assembly; the default `senpi-task` runtime remains unchanged for legacy users.

`harness/pi-runtime/features/child-runtime/stock-rpc-runtime.mjs` accepts the
stage receipt's `runtime.patchableRpcEntry` (`dist/rpc-entry.js`) and rejects
the bundled entry or a missing path. It intentionally returns no executable
resolver. This forces the child command to be the already-selected parent
Node/Bun runtime plus that patched unbundled entrypoint, instead of consulting
`SENPI_BIN`, PATH, or a globally installed Senpi.

The runner assembly should wire it at the existing seam:

```js
const childRuntime = createStockRpcSpawnRuntime({ rpcEntry: runtime.patchableRpcEntry })
createTaskComponent({
  runnerFactories: createTaskRunnerFactories({
    rpcSpawnRuntime: childRuntime,
    // Provider-only entries; do not pass the parent Rubato/MCP/task list.
    stockChildProfile: createStockChildFeatureProfile({ rpcExtensions: providerExtensionPaths }),
    // The factory wraps stock createAgentSession with the adapter; provide
    // stockModelRuntime when the parent owns auth/model state.
    createInProcessSession: createAgentSession,
    stockModelRuntime,
  }),
})
```

`createStockChildFeatureProfile` de-duplicates and validates the explicit
absolute provider extension paths. `resolveStockChildProviderProfile(root)`
selects the staged `child-runtime/provider-extension.mjs`, whose closure binds
the seven-provider module and the shared provider-execution bridge. The staged
`providers`, `provider-execution`, and `tool-execution` features are
prerequisites; provider-execution is imported by that single child extension,
not passed as a second standalone factory. `createTaskRunnerFactories` uses
that profile for both first RPC launches and respawns; an explicit
`rpcChildExtensions` option overrides it. In-process children continue to
receive the parent's canonical model runtime through `stockModelRuntime` and
keep the minimal child resource loader, so the parent task/MCP assembly is not
re-run in the child.

The adapter removes the Senpi-only `authStorage`/`modelRegistry` fields only
after a canonical `modelRuntime` is present. If neither the factory nor the
child options provide one, it fails instead of silently falling back to a
different provider/auth store.

The adapter only selects the child process entrypoint. It does not claim that
stock `createAgentSession` accepts Senpi-only `authStorage` or `modelRegistry`
options; the parent assembly must provide stock `modelRuntime`/model context
explicitly before declaring model/auth parity.

The staged fixture `harness/pi-runtime/features/child-runtime/fixture.ts`
exercises the real `InProcessRunner.start` path with a configured fixture
provider/auth model, local injected stream, isolated JSONL transcript, and
`abort()`. It then starts `RpcProcessRunner` through `buildRpcSpawn` with an
explicit provider-only extension, runs one fake provider turn, checks the
provider/auth identity and transcript, verifies `PI_CODING_AGENT_SESSION_DIR`,
and terminates the child. The Node test builds and stages the fixture from
scratch, runs it with an isolated HOME/PI_OFFLINE environment, and removes its
temporary root:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=30000 \
  features/child-runtime/child-e2e.test.mjs
```

This verifies the selected stock runtime seam, provider-only child profile,
model/auth identity, and lifecycle. It still does not establish live paid
provider behavior or full task/team orchestration parity. Under the current
profile, codemode, terminal, loop/tool-pair guards, media-tools, MCP,
service-tier, tool-search, task/team, and memory extensions are intentionally
absent. In-process children additionally use an empty extension loader, so
Senpi builtin compaction/goal/todo extensions are absent; adding any of these
requires a separate child-safe profile rather than forwarding the parent
assembly.

## A4 (2026-09-11)

The full candidate now opts the child profile into context-notes owner + tool
guards (`includeContextNotes`/`includeGuards` on bootstrap). In-process children
reload a stock `DefaultResourceLoader` and `bindExtensions()` so `session_start`
can register the notes gate; RPC children receive the same extension paths with
`--extension`. Provider-only success is not the full-candidate claim. Child
filesystem tools (`write`/`read`/...) are created from the child cwd; parent
closures of those names are dropped before `createAgentSession`. Measured by
`features/child-runtime/child-e2e.test.mjs` writing `cwd-probe.txt` in both seams.
`bash` is in that child-owned set too: a parent bash closure would keep the
parent `TerminalToolContext.cwd` when `executeTool` omits `execCtx`, so the
helper drops it and the child uses stock bash created with the child cwd.
Both seams measure this with `pwd > bash-cwd.txt`. Loop-guard inheritance is
measured by blocking a repeated identical child tool call, not a hardcoded list.
