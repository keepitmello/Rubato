// @effect-diagnostics nodeBuiltinImport:off anyUnknownInErrorContext:off -- the driver declares its requirements as any.
// The Rubato driver on upstream's Pi adapter: the picker's options upstream Pi has no field for
// (reasoning effort, Fast) reach the bridge's connection as one `rubato_selection` record after
// the model is set (pi-adapter-edits.mjs selectionRecord; the bridge applies it,
// rpc-connection.mjs applySelection). The bridge here is a stub module that records what the
// adapter sends.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeId, ProviderInstanceId, ProviderSessionId, RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RubatoPiDriver } from "./RubatoPiDriver.ts";

const BRIDGE = `
const model = { provider: "stub", id: "model", name: "Stub", reasoning: true, contextWindow: 100000 };
export function createBridge() {
  const sent = (globalThis.rubatoDriverTestRecords = []);
  return {
    claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(), resumedSessions: new Set(),
    async catalogue(_cwd, options) {
      (globalThis.rubatoDriverTestFresh ??= []).push(options?.fresh ?? false);
      return { models: [model], model, slashCommands: [{ name: "compact" }, { name: "audit", description: "Run an audit" }],
        skills: [{ name: "ship-it", description: "Ship the change", path: "/skills/ship-it/SKILL.md", enabled: true,
          displayName: "ship-it", shortDescription: "Ship the change" }] };
    },
    async close() {},
    async openRpc() {
      return {
        async request(record) {
          sent.push(record);
          switch (record.type) {
            case "get_state": return { sessionId: "stub-session", sessionFile: "stub-session", model,
              thinkingLevel: "low", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
            case "get_available_models": return { models: [model] };
            case "set_model": return model;
            case "get_entries": return { leafId: null, entries: [] };
            case "get_messages": return { messages: [] };
            case "get_commands": return { commands: [] };
            default: return {};
          }
        },
        send(record) { sent.push(record); },
        async close() {},
      };
    },
  };
}`;
const records = () => (globalThis as unknown as { rubatoDriverTestRecords: Array<{ type: string; options?: unknown }> })
  .rubatoDriverTestRecords;

const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)));

const instanceFor = () => Effect.gen(function* () {
  const folder = mkdtempSync(join(tmpdir(), "rubato-driver-"));
  const bridgeModule = join(folder, "bridge.mjs");
  writeFileSync(bridgeModule, BRIDGE);
  const instance = yield* RubatoPiDriver.create({ instanceId: ProviderInstanceId.make("rubato-test"), enabled: true,
    environment: [], displayName: "Rubato", config: { bridgeModule, descriptorPath: join(folder, "descriptor.json"), catalogueCwd: folder } });
  return { instance, folder };
});

const startTurn = (options: ReadonlyArray<{ id: string; value: string | boolean }> | undefined) => Effect.gen(function* () {
  const folder = mkdtempSync(join(tmpdir(), "rubato-driver-"));
  const bridgeModule = join(folder, "bridge.mjs");
  writeFileSync(bridgeModule, BRIDGE);
  const instanceId = ProviderInstanceId.make("rubato-test");
  const threadId = ThreadId.make("driver-test-thread");
  const instance = yield* RubatoPiDriver.create({ instanceId, enabled: true, environment: [], displayName: "Rubato",
    config: { bridgeModule, descriptorPath: join(folder, "descriptor.json"), catalogueCwd: folder } });
  const selection = { instanceId, model: "stub/model", ...(options ? { options } : {}) };
  const runtimePolicy = { runtimeMode: "full-access", interactionMode: "default", cwd: folder } as const;
  const runtime = yield* instance.orchestrationAdapter!.openSession({
    providerSessionId: ProviderSessionId.make("driver-test-runtime"), threadId, modelSelection: selection, runtimePolicy });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy });
  const now = yield* DateTime.now;
  yield* runtime.startTurn({
    appThread: { id: threadId, title: "Driver test", modelSelection: selection, runtimeMode: "full-access",
      interactionMode: "default", createdAt: now, updatedAt: now },
    threadId, runId: RunId.make("driver-test-run"), runOrdinal: 1, providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("driver-test-attempt"), rootNodeId: NodeId.make("driver-test-node"), providerThread,
    message: { messageId: "driver-test-message", text: "Hello", attachments: [], createdBy: "user", creationSource: "web" },
    modelSelection: selection, runtimePolicy,
  } as never);
  yield* Effect.yieldNow;
  return records();
});

it.effect("the picker's reasoning effort and Fast reach the bridge after the model, before the prompt", () => Effect.gen(function* () {
  const options = [{ id: "reasoningEffort", value: "high" }, { id: "fastMode", value: true }];
  const sent = yield* startTurn(options);
  const types = sent.map((record) => record.type);
  const selection = types.indexOf("rubato_selection");
  assert.isTrue(selection > types.indexOf("set_model"), JSON.stringify(types));
  assert.isTrue(selection < types.indexOf("prompt"), JSON.stringify(types));
  assert.deepStrictEqual(sent[selection]!.options, options);
}).pipe(Effect.scoped, Effect.provide(layer)));

it.effect("a selection without options sends no extra record", () => Effect.gen(function* () {
  const sent = yield* startTurn(undefined);
  assert.isFalse(sent.some((record) => record.type === "rubato_selection"));
  assert.isTrue(sent.some((record) => record.type === "prompt"));
}).pipe(Effect.scoped, Effect.provide(layer)));

it.live("the snapshot carries the commands and skills; a workspace probe neither changes nor publishes it", () => Effect.gen(function* () {
  (globalThis as unknown as { rubatoDriverTestFresh: boolean[] }).rubatoDriverTestFresh = [];
  const { instance, folder } = yield* instanceFor();
  const machine = yield* instance.snapshot.getSnapshot;
  const workspace = yield* instance.snapshotForCwd!(folder);
  assert.deepStrictEqual(workspace.slashCommands.map((command) => command.name), ["compact", "audit"]);
  assert.strictEqual(workspace.skills[0]!.name, "ship-it");
  // T3's registry merges workspace lists itself; one carried here would wipe other folders'.
  assert.strictEqual(workspace.workspaceSnapshots, undefined);
  assert.strictEqual(yield* instance.snapshot.getSnapshot, machine);
  // Publishing would make every client reload its config and redraw.
  const published = yield* Stream.runHead(instance.snapshot.streamChanges).pipe(Effect.timeoutOption("100 millis"));
  assert.isTrue(Option.isNone(published));
  // A workspace probe may reuse the catalogue; an explicit refresh asks again.
  yield* instance.refreshModels!();
  const fresh = (globalThis as unknown as { rubatoDriverTestFresh: boolean[] }).rubatoDriverTestFresh;
  assert.deepStrictEqual(fresh.slice(-2), [false, true]);
}).pipe(Effect.scoped, Effect.provide(layer)));
