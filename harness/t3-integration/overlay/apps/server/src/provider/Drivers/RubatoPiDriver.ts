import {
  ProviderDriverKind, ProviderRuntimeEvent, ProviderSession, ProviderTurnStartResult,
  ServerProvider, TextGenerationError, ThreadId, TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

const kind = ProviderDriverKind.make("rubato-pi");
export const RubatoPiConfig = Schema.Struct({
  bridgeModule: Schema.String,
  descriptorPath: Schema.String,
  catalogueCwd: Schema.String,
});
export type RubatoPiConfig = typeof RubatoPiConfig.Type;
export interface PiSummary {
  readonly sessionId: string;
  readonly serverId: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: number;
  readonly status: string;
  readonly runtimeId: string | null;
}
export interface PiBridge {
  projectedMessages: (threadId: string) => Promise<ReadonlyArray<{id: string; text: string; streaming: boolean}>>;
  inventory(): Promise<ReadonlyArray<PiSummary>>;
  cursor(id: string): {kind: string; serverId: string; sessionId: string};
  transcript(id: string): Promise<{messages: ReadonlyArray<unknown>}>;
  importedMessages(id: string, messages: ReadonlyArray<unknown>): ReadonlyArray<{id:string; role:"user"|"assistant"; text:string; createdAt:string}>;
  catalogue(cwd: string): Promise<{models: ReadonlyArray<{provider:string; id:string; name:string; reasoning?:boolean}>; model:{provider:string;id:string}|null}>;
  startSession(input: unknown): Promise<unknown>;
  sendTurn(input: unknown): Promise<unknown>;
  interruptTurn(threadId: string): Promise<void>;
  respondToRequest(threadId: string, requestId: string, decision: string): Promise<void>;
  respondToUserInput(threadId: string, requestId: string, answers: unknown): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  listSessions(): ReadonlyArray<unknown>;
  hasSession(threadId: string): boolean;
  readThread(threadId: string): Promise<{threadId: string; turns: ReadonlyArray<{id:string;items:ReadonlyArray<unknown>}>}>;
  close(): Promise<void>;
}
const bridges = new WeakMap<ProviderInstance, PiBridge>();
export const rubatoBridgeFor = (instance: ProviderInstance): PiBridge | undefined => bridges.get(instance);
const detail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const decodeSession = Schema.decodeUnknownSync(ProviderSession);
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeTurn = Schema.decodeUnknownSync(ProviderTurnStartResult);
const decodeSnapshot = Schema.decodeUnknownSync(ServerProvider);

export const RubatoPiDriver: ProviderDriver<RubatoPiConfig> = {
  driverKind: kind,
  metadata: { displayName: "Rubato Pi", supportsMultipleInstances: true },
  configSchema: RubatoPiConfig,
  defaultConfig: () => ({ bridgeModule: "", descriptorPath: "", catalogueCwd: "" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) => Effect.gen(function* () {
    const fail = (cause: unknown) => new ProviderDriverError({ driver: kind, instanceId, detail: detail(cause), cause });
    if (environment.length !== 0) return yield* fail(new Error("Configure credentials in the external Rubato profile, not T3's child-process environment"));
    if (!config.bridgeModule.startsWith("/") && !config.bridgeModule.startsWith("file:///"))
      return yield* fail(new Error("bridgeModule must be an absolute local module path"));
    if (!config.descriptorPath.startsWith("/") || !config.catalogueCwd.startsWith("/"))
      return yield* fail(new Error("descriptorPath and catalogueCwd must be absolute paths"));
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const updates = yield* PubSub.unbounded<ServerProvider>();
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      yield* PubSub.shutdown(events); yield* PubSub.shutdown(updates);
    }));
    const bridge = yield* Effect.tryPromise({
      try: async () => {
        const module: unknown = await import(/* @vite-ignore */ config.bridgeModule);
        if (!module || typeof module !== "object" || !("createBridge" in module) || typeof module.createBridge !== "function")
          throw new Error("bridgeModule must export createBridge");
        const factory = module.createBridge as (options: {descriptorPath:string; instanceId:string; emit:(event:unknown)=>void; projectedMessages:(id:string)=>Promise<never>}) => PiBridge;
        return factory({ descriptorPath: config.descriptorPath, instanceId,
          emit: (event) => { PubSub.publishUnsafe(events, decodeEvent(event)); },
          projectedMessages: async () => { throw new Error("T3's read-only transcript projection is not bound yet; retry after startup"); },
        });
      }, catch: fail,
    });
    const request = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({
      try: action, catch: (cause) => new ProviderAdapterRequestError({provider:kind, method, detail:detail(cause), cause}),
    });
    yield* Effect.addFinalizer(() => request("dispose", () => bridge.close()).pipe(Effect.catch((error) => Effect.logWarning(error.message))));
    const continuationIdentity = defaultProviderContinuationIdentity({driverKind:kind, instanceId});
    let current = decodeSnapshot({instanceId, driver:kind, enabled, installed:false, version:null,
      status:enabled ? "warning" : "disabled", auth:{status:"unknown"},
      checkedAt:DateTime.formatIso(yield* DateTime.now), models:[], displayName:displayName ?? "Rubato Pi",
      ...(accentColor ? {accentColor} : {}), showInteractionModeToggle:false,
      supportsConversationRollback:false, supportsTextGeneration:false,
      requiresNewThreadForModelChange:false, setup:{canAuthenticate:false,canInstall:false},
      message:"Start the external Rubato Pi server; T3 connects without owning its process.",
    });
    const refreshFor = (cwd: string) => Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const result = enabled ? yield* request("catalogue", () => bridge.catalogue(cwd)).pipe(Effect.result) : null;
      const catalogue = result?._tag === "Success" ? result.success : null;
      current = decodeSnapshot({...current, checkedAt, installed:catalogue !== null,
        status:!enabled ? "disabled" : catalogue ? "ready" : "error",
        message:result?._tag === "Failure" ? result.failure.message : "Rubato profile policy; only Full access is supported. Existing extension questions still require a reply.",
        models:catalogue?.models.map((model) => ({slug:`${model.provider}/${model.id}`, name:model.name,
          subProvider:model.provider, isCustom:false, capabilities:null,
          isDefault:catalogue.model?.provider===model.provider && catalogue.model?.id===model.id })) ?? [],
      });
      yield* PubSub.publish(updates, current);
      return current;
    });
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider:kind,
      capabilities:{sessionModelSwitch:"in-session",supportsConversationRollback:false,promptlessTurnContinuation:true},
      startSession: (input) => request("startSession", async () => {
        if (!enabled) throw new Error("Rubato Pi provider is disabled");
        return decodeSession(await bridge.startSession(input));
      }),
      sendTurn:(input) => request("sendTurn", async () => decodeTurn(await bridge.sendTurn(input))),
      interruptTurn:(id) => request("interruptTurn", () => bridge.interruptTurn(id)),
      respondToRequest:(id, requestId, decision) => request("respondToRequest", () => bridge.respondToRequest(id,requestId,decision)),
      respondToUserInput:(id, requestId, answers) => request("respondToUserInput", () => bridge.respondToUserInput(id,requestId,answers)),
      stopSession:(id) => request("stopSession", () => bridge.stopSession(id)),
      listSessions:() => Effect.sync(() => bridge.listSessions().map((value) => decodeSession(value))),
      hasSession:(id) => Effect.sync(() => bridge.hasSession(id)),
      readThread:(id) => request("readThread", async () => {
        const snapshot = await bridge.readThread(id);
        return {threadId:ThreadId.make(snapshot.threadId), turns:snapshot.turns.map((turn) => ({id:TurnId.make(turn.id),items:turn.items}))};
      }),
      rollbackThread:() => Effect.fail(new ProviderAdapterRequestError({provider:kind,method:"rollbackThread",detail:"Pi history rollback is not exposed by this adapter"})),
      stopAll:() => request("stopAll", () => Promise.all(bridge.listSessions().map((value) => decodeSession(value)).map((session) => bridge.stopSession(session.threadId))).then(() => undefined)),
      streamEvents:Stream.fromPubSub(events),
    };
    const unsupported = (operation: "generateCommitMessage"|"generatePrContent"|"generateBranchName"|"generateThreadTitle") =>
      Effect.fail(new TextGenerationError({operation, detail:"Use another T3 provider for background text generation"}));
    const instance: ProviderInstance = {
      instanceId,driverKind:kind,continuationIdentity,displayName,accentColor,enabled,adapter,
      snapshot:{resolveMaintenance:() => Effect.succeed({provider:kind,packageName:null,update:null}),
        getSnapshot:Effect.sync(() => current),refresh:refreshFor(config.catalogueCwd),
        streamChanges:Stream.fromPubSub(updates),applyUsageLimits:() => Effect.void},
      snapshotForCwd:(cwd) => refreshFor(cwd),
      refreshModels:() => refreshFor(config.catalogueCwd).pipe(Effect.asVoid),
      textGeneration:{generateCommitMessage:() => unsupported("generateCommitMessage"),generatePrContent:() => unsupported("generatePrContent"),
        generateBranchName:() => unsupported("generateBranchName"),generateThreadTitle:() => unsupported("generateThreadTitle")},
    };
    bridges.set(instance,bridge);
    yield* refreshFor(config.catalogueCwd);
    return instance;
  }),
};
