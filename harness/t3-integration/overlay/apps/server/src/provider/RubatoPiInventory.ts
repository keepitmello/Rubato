import {CommandId, MessageId, ProjectId, ThreadId} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import {OrchestrationEngineService} from "../orchestration/Services/OrchestrationEngine.ts";
import {ProjectionSnapshotQuery} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {ProviderInstanceRegistry} from "./Services/ProviderInstanceRegistry.ts";
import {ProviderSessionDirectory} from "./Services/ProviderSessionDirectory.ts";
import {ProviderService} from "./Services/ProviderService.ts";
import {rubatoBridgeFor, type PiSummary} from "./Drivers/RubatoPiDriver.ts";
import type {ProviderInstance} from "./ProviderDriver.ts";
import {ProviderAdapterRequestError} from "./Errors.ts";

function cursorMatches(value: unknown, summary: PiSummary): boolean {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "rubato-pi"
    && "serverId" in value && value.serverId === summary.serverId
    && "sessionId" in value && value.sessionId === summary.sessionId;
}
const io = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({try:action,
  catch:(cause) => new ProviderAdapterRequestError({provider:"rubato-pi",method,
    detail:cause instanceof Error ? cause.message : String(cause),cause})});

/** Reuses T3's existing project/thread commands and durable provider bindings.
 * It never starts a model turn and never owns Pi workers or conversation files. */
export const makeRubatoPiInventory = Effect.gen(function* () {
  const optionalRegistry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  if (Option.isNone(optionalRegistry)) return {sync:Effect.void,start:Effect.void};
  const registry = optionalRegistry.value;
  const directory = yield* ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const service = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const commandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make));
  const bindReaders = Effect.gen(function* () {
    for (const instance of yield* registry.listInstances) {
      const bridge = rubatoBridgeFor(instance);
      if (!bridge) continue;
      bridge.projectedMessages = (id) => Effect.runPromise(query.getThreadDetailById(ThreadId.make(id)).pipe(
        Effect.map((thread) => Option.isSome(thread) ? thread.value.messages : []),
      ));
    }
  });
  // Bind before native restart reconciliation can attempt a provider resume.
  // Also bind new instances immediately on hot reload, not only every poll.
  const changes = yield* registry.subscribeChanges;
  yield* bindReaders;
  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    yield* PubSub.take(changes); yield* bindReaders;
  })));

  const syncInstance = (instance: ProviderInstance) => Effect.gen(function* () {
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || !instance.enabled) return;
    const inventory = yield* io("inventory", () => bridge.inventory());
    const snapshot = yield* instance.snapshot.getSnapshot;
    const bindings = yield* directory.listBindings();
    let readModel = yield* query.getCommandReadModel();
    for (const entry of inventory) {
      yield* Effect.gen(function* () {
        // Old sessions without a cwd cannot be assigned an invented project.
        if (!entry.cwd || !entry.cwd.startsWith("/")) return;
        const binding = bindings.find((item) => item.providerInstanceId === instance.instanceId && cursorMatches(item.resumeCursor,entry));
        // A T3 composer thread claims the Pi session before its binding lands.
        // Importing it as a second thread duplicates the sidebar and the reply text.
        if (!binding && bridge.ownsSession(entry.sessionId)) return;
        const threadId = binding?.threadId ?? ThreadId.make(`import:${instance.instanceId}:${entry.serverId}:${entry.sessionId}`);
        let thread = readModel.threads.find((item) => item.id === threadId);
        if (thread?.deletedAt !== null && thread?.deletedAt !== undefined) return;
        if (thread?.archivedAt !== null && thread?.archivedAt !== undefined) return;
        let project = readModel.projects.find((item) => item.workspaceRoot === entry.cwd);
        if (project?.deletedAt !== null && project?.deletedAt !== undefined) return;
        if (!project) {
          const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
          yield* engine.dispatch({type:"project.create",commandId:yield* commandId,projectId,
            title:entry.cwd.split("/").filter(Boolean).at(-1) ?? entry.cwd,workspaceRoot:entry.cwd,
            createdAt:DateTime.formatIso(yield* DateTime.now)});
          readModel = yield* query.getCommandReadModel();
          project = readModel.projects.find((item) => item.id===projectId);
        }
        if (!project) return;
        if (thread && thread.projectId!==project.id) return; // Never move a user's thread.
        if (!thread) {
          const saved = yield* io("transcript", () => bridge.transcript(entry.sessionId));
          const preferred = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
          // This is an explicit UI sentinel, not a fabricated provider/model.
          // Input must select a real discovered model before any API call.
          const selected = "model" in saved && typeof saved.model === "string" ? saved.model : null;
          const model = selected ?? preferred?.slug ?? "rubato:select-model";
          yield* directory.upsert({threadId,provider:instance.driverKind,providerInstanceId:instance.instanceId,
            status:"stopped",runtimeMode:"full-access",resumeCursor:bridge.cursor(entry.sessionId),runtimePayload:{cwd:entry.cwd}},
            {onConflict:"ignore"});
          yield* engine.dispatch({type:"thread.create",commandId:yield* commandId,threadId,projectId:project.id,
            title:entry.title || "Pi session",modelSelection:{instanceId:instance.instanceId,model},runtimeMode:"full-access",
            interactionMode:"default",branch:null,worktreePath:null,historyImport:true,
            createdAt:DateTime.formatIso(DateTime.makeUnsafe(entry.createdAt))});
          readModel = yield* query.getCommandReadModel();
          thread = readModel.threads.find((item) => item.id===threadId);
        }
        if (!thread) return;
        const live = entry.runtimeId !== null && ["running", "waiting", "starting"].includes(entry.status);
        // Live attach replays the snapshot as UI events. Importing the same
        // transcript first concatenates the assistant text on one message.
        if (!live && thread.latestTurn===null && thread.session===null) {
          const existing = yield* query.getThreadDetailById(threadId);
          if (Option.isSome(existing) && existing.value.messages.length===0) {
            const saved = yield* io("transcript", () => bridge.transcript(entry.sessionId));
            const messages = bridge.importedMessages(entry.sessionId,saved.messages);
            if (messages.length) yield* engine.dispatch({type:"thread.history.import",commandId:yield* commandId,
              threadId,messages:messages.map((message) => ({messageId:MessageId.make(message.id),role:message.role,text:message.text,createdAt:message.createdAt}))});
          }
        }
        if (live && !bridge.hasSession(threadId) && !bridge.ownsSession(entry.sessionId)) {
          yield* service.startSession(threadId,{threadId,provider:instance.driverKind,providerInstanceId:instance.instanceId,
            cwd:entry.cwd,runtimeMode:thread.runtimeMode,resumeCursor:bridge.cursor(entry.sessionId)});
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Rubato session projection skipped",{sessionId:entry.sessionId,cause})));
    }
  });
  const sync = Effect.gen(function* () {
    yield* bindReaders;
    for (const instance of yield* registry.listInstances) {
      yield* syncInstance(instance).pipe(Effect.catch((cause) => Effect.logWarning("Rubato inventory is unavailable",{instanceId:instance.instanceId,cause})));
    }
  });
  return {
    sync,
    start:Effect.gen(function* () {
      // Startup's caller runs this only after the normal command/event runtime
      // is activated. There is never a hidden synthetic prompt in this loop.
      yield* Effect.forkScoped(Effect.forever(sync.pipe(Effect.andThen(Effect.sleep("5 seconds")))));
    }),
  };
});
