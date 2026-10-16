import {
  ProviderDriverKind, ServerProvider, TextGenerationError,
} from "@t3tools/contracts";
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
// Imported sessions may use either path syntax, independently of the server OS.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  PI_CAPABILITIES_V2, PiRpcError, makePiAdapterV2, type PiRpcConnection, type PiRpcRecord,
} from "@t3tools/provider-pi/server";
import { PiSettings } from "@t3tools/provider-pi/settings";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "../Errors.ts";

/** Unix, Windows drive-letter, and UNC paths. Host platform must not gate this. */
export const isAbsoluteLocalPath = (value: string): boolean =>
  NodePath.posix.isAbsolute(value) || NodePath.win32.isAbsolute(value);

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
  /** The session a side chat was opened from; absent for every other session. */
  readonly sideChatOf?: string;
}
/** A prompt file a new conversation can open with (bridge session-prompts.mjs). */
export interface PiSessionPromptEntry {
  readonly id: string;
  readonly label: string;
  readonly source: string;
}
/** The prompt a session runs on instead of Rubato's own; never its text. */
export interface PiSessionPromptSummary {
  readonly label?: string;
  readonly source?: string;
  readonly createdAt?: string;
}
/** A message another conversation sent into a Pi session (bridge events.mjs sessionMessageFrom). */
export interface PiSessionMessage {
  readonly id: string;
  readonly role: "user";
  readonly text: string;
  readonly createdAt: string;
  readonly context: unknown;
}
/** A rewind that lands after a finished tool step: its row's call id, its turn, and when it finished. */
export interface RubatoRevertStep {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly after: string;
}
export type PiImportedMessage =
  | {readonly id: string; readonly role: "user" | "assistant"; readonly text: string; readonly createdAt: string; readonly context?: undefined}
  | PiSessionMessage;
/** One Pi RPC stream served by the Rubato engine (bridge rpc-connection.mjs). */
export interface PiRpcBridgeConnection {
  request(record: PiRpcRecord): Promise<unknown>;
  send(record: PiRpcRecord): void;
  close(error?: unknown): Promise<void>;
}
export interface PiBridge {
  /** T3's thread.fork: a new engine session cut before `beforeEntryId`; its id. */
  forkForThread(input: {source: string; beforeEntryId: string | null}): Promise<string>;
  /** The session a thread already runs in (RubatoPiSessions.ts binds it at startup). */
  /** Sessions a V2 thread reattached to from before V2; their history is native. */
  readonly resumedSessions?: Set<string>;
  /** Sessions a thread of this server shows; the inventory leaves them to that thread. */
  readonly claimed: Set<string>;
  boundSession?: (threadId: string) => Promise<{readonly sessionId: string; readonly serverId: string | null} | null>;
  openRpc(options: {threadId: string; cwd: string; onRecord: (record: PiRpcRecord) => void;
    onClosed: (error: unknown) => void}): Promise<PiRpcBridgeConnection>;
  projectedMessages: (threadId: string) => Promise<ReadonlyArray<{id: string; text: string; streaming: boolean}>>;
  appendSessionMessage: (threadId: string, message: PiSessionMessage) => Promise<void>;
  /** `/rewind`: T3's conversation revert of `turns` turns before `afterTurn`, and that turn (RubatoPiInventory.ts). */
  rewindConversation: (threadId: string, request: {readonly afterTurn: string; readonly turns: number}) => Promise<void>;
  projectedThread: (threadId: string) => Promise<{
    messages: ReadonlyArray<{id: string; role: string; text: string; turnId: string | null; createdAt: string}>;
    checkpoints: ReadonlyArray<{turnId: string; checkpointTurnCount: number}>;
    activities?: ReadonlyArray<{kind: string; turnId: string | null; createdAt: string}>;
  } | null>;
  inventory(): Promise<ReadonlyArray<PiSummary>>;
  cursor(id: string): {kind: string; serverId: string; sessionId: string};
  transcript(id: string): Promise<{messages: ReadonlyArray<unknown>}>;
  /** A new session from `id`'s completed history, named `title` (pi-server Management fork). */
  forkSession(id: string, title: string, options?: {side?: boolean; at?: string}): Promise<PiSummary | undefined>;
  /** Deletes a side chat's session (pi-server Management discard); refuses any other. */
  discardSession(id: string): Promise<void>;
  /** Every side chat session, which `inventory()` leaves out. */
  sideChats(): Promise<ReadonlyArray<PiSummary>>;
  /** The new-thread screen's prompt library (bridge session-prompts.mjs). */
  sessionPromptLibrary(): Promise<ReadonlyArray<PiSessionPromptEntry>>;
  openSessionPromptFolder(): Promise<{folder: string}>;
  /** The thread's session opens with this prompt as its whole system prompt; refused once it started. */
  prepareSessionPrompt(threadId: string, choice: {id: string} | {text: string; label?: string}): Promise<PiSessionPromptSummary>;
  /** What the session runs on instead of Rubato's prompt, or null. */
  sessionPrompt(sessionId: string): Promise<PiSessionPromptSummary | null>;
  /** `threadId` is the T3 thread the history goes to; a session message's id names it. */
  importedMessages(id: string, messages: ReadonlyArray<unknown>, threadId: string): ReadonlyArray<PiImportedMessage>;
  /** `fresh` drops every cached catalogue first: an explicit refresh must see a key added a moment ago. */
  catalogue(cwd: string, options?: {fresh?: boolean}): Promise<{models: ReadonlyArray<{provider:string; id:string; name:string; reasoning?:boolean; capabilities?:{optionDescriptors?:ReadonlyArray<unknown>}|null}>; model:{provider:string;id:string}|null; slashCommands?: ReadonlyArray<{name:string; description?:string; input?:{hint:string}}>; skills?: ReadonlyArray<{name:string; description?:string; path:string; scope?:string; enabled:boolean; displayName?:string; shortDescription?:string}>}>;
  startSession(input: unknown): Promise<unknown>;
  sendTurn(input: unknown): Promise<unknown>;
  compact(threadId: string, customInstructions?: string): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  respondToRequest(threadId: string, requestId: string, decision: string): Promise<void>;
  respondToUserInput(threadId: string, requestId: string, answers: unknown): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  listSessions(): ReadonlyArray<unknown>;
  hasSession(threadId: string): boolean;
  ownsSession(sessionId: string): boolean;
  readThread(threadId: string): Promise<{threadId: string; turns: ReadonlyArray<{id:string;items:ReadonlyArray<unknown>}>}>;
  /** `step` lands inside a turn, after a finished tool step (bridge stepRewindPlan). */
  rollbackThread(threadId: string, numTurns: number, step?: RubatoRevertStep): Promise<{threadId: string; turns: ReadonlyArray<{id:string;items:ReadonlyArray<unknown>}>}>;
  /** Runs again from a step rewind's tool results with no new message. */
  continueThread(threadId: string): Promise<void>;
  close(): Promise<void>;
}
/** 카탈로그 조회 결과. 기계 스냅샷 조립과 워크스페이스 조회가 같은 모양을 쓴다. */
export type PiCatalogue = Awaited<ReturnType<PiBridge["catalogue"]>>;
const bridges = new WeakMap<ProviderInstance, PiBridge>();
export const rubatoBridgeFor = (instance: ProviderInstance): PiBridge | undefined => bridges.get(instance);
const detail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const decodeSnapshot = Schema.decodeUnknownSync(ServerProvider);

/**
 * What Rubato can do on T3's V2 orchestrator. It starts from upstream Pi's set (same
 * RPC, same event mapping) and takes away what the shared engine does not offer:
 * T3's permission hook and MCP bridge are Pi extensions T3 injects into a process it
 * spawns, and Rubato sessions run in the engine with Rubato's own tool policy. Rollback
 * and fork stay on: the engine rewinds in place (bridge rpc-connection.mjs) and forks
 * through its Management service (bridge forkForThread).
 */
export const RUBATO_CAPABILITIES_V2: OrchestrationV2ProviderCapabilities = {
  ...PI_CAPABILITIES_V2,
  sessions: { ...PI_CAPABILITIES_V2.sessions, supportsRuntimeModeSwitchInSession: true },
  tools: { ...PI_CAPABILITIES_V2.tools, supportsMcpTools: false },
  approvals: { ...PI_CAPABILITIES_V2.approvals, supportsCommandApproval: false, supportsFileChangeApproval: false },
};
const piSettings = Schema.decodeSync(PiSettings);
/** Turn items the V1 importer wrote (LegacyV1ThreadImporter IMPORT_EVENT_PREFIX). */
const LEGACY_ITEM = "migration:v1:";
/**
 * Whether T3's history handoff is already in the model's context. A thread from before V2
 * that reattached to its Rubato session (rpc-connection.mjs), or one written from a session's
 * stored history (a whole-thread fork, the inventory), still gets T3's import handoff,
 * which would replay that history into the same conversation a second time.
 * Anything else (a provider switch, a fork delta, a mix) goes inline as for any provider.
 */
const alreadyNative = (bridge: PiBridge, input: {readonly providerThread: {readonly nativeThreadRef: {readonly nativeId: string | null} | null};
  readonly messages: ReadonlyArray<{readonly itemId: string}>}) => {
  const sessionId = input.providerThread.nativeThreadRef?.nativeId;
  if (sessionId == null || input.messages.length === 0) return false;
  // History written from this very session (RubatoPiSessions importPiSessionThread).
  const own = `rubato-pi-import:${sessionId}:`;
  if (input.messages.every((message) => String(message.itemId).startsWith(own))) return true;
  return bridge.resumedSessions?.has(sessionId) === true
    && input.messages.every((message) => String(message.itemId).startsWith(LEGACY_ITEM));
};

/** A PiRpcConnection (provider-pi rpc.ts) over the bridge's engine attachment. */
const openRubatoConnection = (bridge: PiBridge, input: {readonly threadId: string; readonly cwd: string}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
    const exited = yield* Deferred.make<number, PiRpcError>();
    const ended = (error: unknown) => {
      const failure = new PiRpcError({ operation: "transport",
        detail: error === undefined ? "Rubato attachment closed" : detail(error), cause: error });
      Queue.failCauseUnsafe(events, Cause.fail(failure));
      Deferred.doneUnsafe(exited, error === undefined ? Effect.succeed(0) : Effect.fail(failure));
    };
    const connection = yield* Effect.tryPromise({
      try: () => bridge.openRpc({ threadId: input.threadId, cwd: input.cwd,
        onRecord: (record) => { Queue.offerUnsafe(events, record); }, onClosed: ended }),
      catch: (cause) => new PiRpcError({ operation: "attach", detail: detail(cause), cause }),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => connection.close()));
    const result: PiRpcConnection = {
      send: (record) => Effect.sync(() => connection.send(record)),
      request: (record) => Effect.tryPromise({
        try: () => connection.request(record),
        catch: (cause) => new PiRpcError({ operation: String(record["type"] ?? "request"), detail: detail(cause), cause }),
      }),
      events,
      exited: Deferred.await(exited),
      // Stop-with-restart: drop this attachment; the engine keeps the session.
      terminate: Effect.promise(() => connection.close()),
    };
    return result;
  });

export const RubatoPiDriver: ProviderDriver<RubatoPiConfig, any> = {
  driverKind: kind,
  // The one instance is the configured `rubato` (write-gui-settings.mjs); an unconfigured
  // default would only fail on its empty paths.
  metadata: { displayName: "Rubato", supportsMultipleInstances: true, hasDefaultInstance: false },
  configSchema: RubatoPiConfig,
  defaultConfig: () => ({ bridgeModule: "", descriptorPath: "", catalogueCwd: "" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) => Effect.gen(function* () {
    const fail = (cause: unknown) => new ProviderDriverError({ driver: kind, instanceId, detail: detail(cause), cause });
    if (environment.length !== 0) return yield* fail(new Error("Configure credentials in the external Rubato profile, not T3's child-process environment"));
    if (!isAbsoluteLocalPath(config.bridgeModule) && !config.bridgeModule.startsWith("file:///"))
      return yield* fail(new Error("bridgeModule must be an absolute local module path"));
    if (!isAbsoluteLocalPath(config.descriptorPath) || !isAbsoluteLocalPath(config.catalogueCwd))
      return yield* fail(new Error("descriptorPath and catalogueCwd must be absolute paths"));
    const updates = yield* PubSub.unbounded<ServerProvider>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(updates));
    const bridge = yield* Effect.tryPromise({
      try: async () => {
        const moduleHref = config.bridgeModule.startsWith("file:") ? config.bridgeModule : pathToFileURL(config.bridgeModule).href;
        const module: unknown = await import(/* @vite-ignore */ moduleHref);
        if (!module || typeof module !== "object" || !("createBridge" in module) || typeof module.createBridge !== "function")
          throw new Error("bridgeModule must export createBridge");
        const factory = module.createBridge as (options: {descriptorPath:string; instanceId:string}) => PiBridge;
        return factory({ descriptorPath: config.descriptorPath, instanceId });
      }, catch: fail,
    });
    const request = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({
      try: action, catch: (cause) => fail(new Error(`${method}: ${detail(cause)}`)),
    });
    yield* Effect.addFinalizer(() => request("dispose", () => bridge.close()).pipe(Effect.catch((error) => Effect.logWarning(error.message))));
    const continuationIdentity = defaultProviderContinuationIdentity({driverKind:kind, instanceId});
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const orchestrationAdapter = yield* makePiAdapterV2({
      instanceId, settings: piSettings({ enabled }), environment: {}, continuationRequests,
      driverKind: kind, capabilities: RUBATO_CAPABILITIES_V2,
      openConnection: (input) => openRubatoConnection(bridge, { threadId: input.threadId, cwd: input.cwd }),
      injectHistory: (input) => Effect.sync(() => alreadyNative(bridge, input)),
      forkSession: (input) => Effect.tryPromise({
        try: () => bridge.forkForThread({ source: input.sourceNativeId, beforeEntryId: input.beforeEntryId }),
        catch: (cause) => new PiRpcError({ operation: "fork", detail: detail(cause), cause }),
      }),
    });
    let current = decodeSnapshot({instanceId, driver:kind, enabled, installed:false, version:null,
      status:enabled ? "warning" : "disabled", auth:{status:"unknown"},
      checkedAt:DateTime.formatIso(yield* DateTime.now), models:[], displayName:displayName ?? "Rubato",
      ...(accentColor ? {accentColor} : {}), continuation:{groupKey:continuationIdentity.continuationKey},
      showInteractionModeToggle:false, supportedRuntimeModes:["full-access"],
      reportsContextWindow:true, supportsConversationRollback:true, supportsTextGeneration:false,
      requiresNewThreadForModelChange:false, setup:{canAuthenticate:false,canInstall:false},
      message:"Start the external Rubato server; T3 connects without owning its process.",
    });
    // 카탈로그 한 번 조회. 기계 스냅샷도 발행도 건드리지 않는다.
    const probeCatalogue = (cwd: string, fresh = false) => Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const result = enabled ? yield* request("catalogue", () => bridge.catalogue(cwd, {fresh})).pipe(Effect.result) : null;
      return {checkedAt, catalogue: result?._tag === "Success" ? result.success : null,
        failure: result?._tag === "Failure" ? result.failure : null};
    });
    const snapshotFrom = (probe: {readonly checkedAt: string; readonly catalogue: PiCatalogue | null;
      readonly failure: {readonly message: string} | null}) => decodeSnapshot({...current,
      checkedAt:probe.checkedAt, installed:probe.catalogue !== null,
      status:!enabled ? "disabled" : probe.catalogue ? "ready" : "error",
      message:probe.failure ? probe.failure.message : "Rubato profile policy; only Full access is supported. Existing extension questions still require a reply.",
      models:probe.catalogue?.models.map((model) => ({slug:`${model.provider}/${model.id}`, name:model.name,
        subProvider:model.provider, isCustom:false, capabilities:model.capabilities ?? null,
        isDefault:probe.catalogue?.model?.provider===model.provider && probe.catalogue?.model?.id===model.id })) ?? [],
      slashCommands:probe.catalogue?.slashCommands ?? [],
      skills:probe.catalogue?.skills ?? [],
    });
    // 기계 스냅샷을 새로 쓰고 알리는 자리는 여기 하나뿐이다. workspaceSnapshots 는
    // T3 registry 가 자기 목록으로 merge 하므로 드라이버가 싣지 않는다. 다시 받으라는
    // 요청이라 bridge 의 재사용 목록을 거치지 않는다.
    const refreshFor = (cwd: string) => Effect.gen(function* () {
      current = snapshotFrom(yield* probeCatalogue(cwd, true));
      yield* PubSub.publish(updates, current);
      return current;
    });
    // 워크스페이스 조회는 스냅샷을 돌려주기만 한다. 여기서 발행하면 모든 클라이언트가
    // config 를 새로 받아 화면 전체를 다시 그린다.
    const snapshotForCwd = (cwd: string) => Effect.gen(function* () {
      return snapshotFrom(yield* probeCatalogue(cwd));
    });
    const unsupported = (operation: string) =>
      Effect.fail(new TextGenerationError({operation, detail:"Use another T3 provider for background text generation"}));
    const instance: ProviderInstance = {
      instanceId,driverKind:kind,continuationIdentity,displayName,accentColor,enabled,orchestrationAdapter,
      snapshot:{resolveMaintenance:() => Effect.succeed({provider:kind,packageName:null,update:null}),
        getSnapshot:Effect.sync(() => current),refresh:refreshFor(config.catalogueCwd),
        streamChanges:Stream.fromPubSub(updates),applyUsageLimits:() => Effect.void},
      snapshotForCwd,
      refreshModels:() => refreshFor(config.catalogueCwd).pipe(Effect.asVoid),
      textGeneration:{generateCommitMessage:() => unsupported("generateCommitMessage"),generatePrContent:() => unsupported("generatePrContent"),
        generateBranchName:() => unsupported("generateBranchName"),generateThreadTitle:() => unsupported("generateThreadTitle"),
        generateReviewGuide:() => unsupported("generateReviewGuide")},
    };
    bridges.set(instance,bridge);
    yield* refreshFor(config.catalogueCwd);
    return instance;
  }),
};
