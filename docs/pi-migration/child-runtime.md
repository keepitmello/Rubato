# Child runtime binding

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
    // The factory wraps stock createAgentSession with the adapter; provide
    // stockModelRuntime when the parent owns auth/model state.
    createInProcessSession: createAgentSession,
    stockModelRuntime,
  }),
})
```

The adapter removes the Senpi-only `authStorage`/`modelRegistry` fields only
after a canonical `modelRuntime` is present. If neither the factory nor the
child options provide one, it fails instead of silently falling back to a
different provider/auth store.

The adapter only selects the child process entrypoint. It does not claim that
stock `createAgentSession` accepts Senpi-only `authStorage` or `modelRegistry`
options; the parent assembly must provide stock `modelRuntime`/model context
explicitly before declaring model/auth parity.

The staged fixture `harness/pi-runtime/features/child-runtime/fixture.ts`
exercises the real `InProcessRunner.start` path with a local injected stream,
isolated JSONL transcript, and `abort()`; it then starts `RpcProcessRunner`
through `buildRpcSpawn`, verifies `PI_CODING_AGENT_SESSION_DIR`, and terminates
the child. The Node test builds and stages the fixture from scratch, runs it
with an isolated HOME/PI_OFFLINE environment, and removes its temporary root:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=30000 \
  features/child-runtime/child-e2e.test.mjs
```

This verifies the selected stock runtime seam and lifecycle only; it does not
establish live provider/auth parity or full task/team behavior.
