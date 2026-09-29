import {CommandId, MessageId, OrchestrationMessageContext, ProjectId, ThreadId} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import {OrchestrationEngineService} from "../orchestration/Services/OrchestrationEngine.ts";
import {ProjectionSnapshotQuery} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {ProviderInstanceRegistry} from "./Services/ProviderInstanceRegistry.ts";
import {ProviderSessionDirectory} from "./Services/ProviderSessionDirectory.ts";
import {ProviderService} from "./Services/ProviderService.ts";
import {isAbsoluteLocalPath, rubatoBridgeFor, type PiSessionMessage, type PiSummary} from "./Drivers/RubatoPiDriver.ts";
import type {ProviderInstance} from "./ProviderDriver.ts";
import {ProviderAdapterRequestError} from "./Errors.ts";

function cursorMatches(value: unknown, summary: PiSummary): boolean {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "rubato-pi"
    && "serverId" in value && value.serverId === summary.serverId
    && "sessionId" in value && value.sessionId === summary.sessionId;
}
// 위저드를 한 번 누른 설치에는 ~/.codex 와 ~/.claude 기록이 스레드로 남아 있다.
// 새 임포트는 서버에서 막았지만, 이미 만들어진 사본은 그 설치에 그대로 있다.
// 시작할 때 치운다. 원본 대화는 두 홈 디렉터리에 그대로 있다.
const FOREIGN_IMPORT = /^import:(?:codex|claudeAgent):/;
const io = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({try:action,
  catch:(cause) => new ProviderAdapterRequestError({provider:"rubato-pi",method,
    detail:cause instanceof Error ? cause.message : String(cause),cause})});
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

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
  // The bridge calls the thread writer from outside any Effect; it runs with the
  // services the inventory was built with (command ids need Crypto).
  const services = yield* Effect.context<Crypto.Crypto>();
  // A message another conversation sent into a Pi session. It is a user message
  // that starts no turn (T3's own "append without a turn"), carrying the context
  // record the web timeline draws as the session-message bubble. Its id names the
  // sender's message and this thread, so a replay into the same thread is refused
  // as a duplicate while a fork's copy lands in the fork's own thread.
  const appendSessionMessage = (threadId: string, message: PiSessionMessage) => Effect.gen(function* () {
    yield* engine.dispatch({type:"thread.message.user.append",commandId:yield* commandId,threadId:ThreadId.make(threadId),
      message:{messageId:MessageId.make(message.id),text:message.text,attachments:[],context:decodeContext(message.context)},
      createdAt:message.createdAt});
  });
  const bindReaders = Effect.gen(function* () {
    for (const instance of yield* registry.listInstances) {
      const bridge = rubatoBridgeFor(instance);
      if (!bridge) continue;
      bridge.projectedMessages = (id) => Effect.runPromise(query.getThreadDetailById(ThreadId.make(id)).pipe(
        Effect.map((thread) => Option.isSome(thread) ? thread.value.messages : []),
      ));
      bridge.appendSessionMessage = (id, message) => Effect.runPromiseWith(services)(appendSessionMessage(id, message));
    }
  });
  // Bind before native restart reconciliation can attempt a provider resume.
  // Also bind new instances immediately on hot reload, not only every poll.
  const changes = yield* registry.subscribeChanges;
  yield* bindReaders;
  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    yield* PubSub.take(changes); yield* bindReaders;
  })));
  // Threads whose stored history this server has already checked. The check loads the
  // whole thread (messages, activities, turns) and the sync repeats every five seconds
  // over every stored session, so an imported thread — which keeps no turns and no
  // session — was loaded again on every pass. Its history does not change while idle:
  // new work makes the session live, and a live attach replays the snapshot instead.
  const historyChecked = new Set<string>();

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
        if (!entry.cwd || !isAbsoluteLocalPath(entry.cwd)) return;
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
            title:entry.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.cwd,workspaceRoot:entry.cwd,
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
        // After the profile engine is killed, Pi has no worker but T3 still
        // has a running turn in SQLite. Attach anyway so the snapshot replay
        // completes thinking instead of leaving it live with no stream.
        const t3Live = thread.session != null && (
          thread.session.status === "running" ||
          thread.session.status === "starting" ||
          thread.session.activeTurnId != null
        );
        // A session T3 sees for the first time brings its stored history, live or
        // not. The live attach below replays the snapshot, but that replay carries
        // assistant messages only (user messages normally come from T3's composer),
        // so a session started elsewhere — the CLI, the scheduler — lost every
        // prompt sent before T3 saw it. The attach seeds its projection from these
        // imported messages and sends no text for them again; only the reply still
        // in flight streams in.
        if (thread.latestTurn===null && thread.session===null && !historyChecked.has(threadId)) {
          const existing = yield* query.getThreadDetailById(threadId);
          if (Option.isSome(existing) && existing.value.messages.length===0) {
            const saved = yield* io("transcript", () => bridge.transcript(entry.sessionId));
            const messages = bridge.importedMessages(entry.sessionId,saved.messages,threadId);
            const plain = messages.filter((message) => message.context === undefined);
            if (plain.length) yield* engine.dispatch({type:"thread.history.import",commandId:yield* commandId,
              threadId,messages:plain.map((message) => ({messageId:MessageId.make(message.id),role:message.role,text:message.text,createdAt:message.createdAt}))});
            // History import takes no context, so session messages follow it; the
            // thread orders by createdAt, which is when each one arrived in Pi.
            for (const message of messages) if (message.context !== undefined)
              yield* appendSessionMessage(threadId, message);
          }
          historyChecked.add(threadId);
        }
        if ((live || t3Live) && !bridge.hasSession(threadId) && !bridge.ownsSession(entry.sessionId)) {
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
  const dropForeignImports = Effect.gen(function* () {
    // 서버에서 임포트를 다시 켠 설치라면, 그 사람이 일부러 가져온 것이다. 안 지운다.
    if (process.env.RUBATO_IMPORT_AGENT_HISTORY) return;
    const readModel = yield* query.getCommandReadModel();
    const foreign = readModel.threads.filter((thread) =>
      FOREIGN_IMPORT.test(thread.id) && (thread.deletedAt === null || thread.deletedAt === undefined));
    if (foreign.length === 0) return;
    for (const thread of foreign) {
      yield* engine.dispatch({type:"thread.delete",commandId:yield* commandId,threadId:thread.id});
    }
    yield* Effect.logInfo("Removed imported Codex/Claude threads",{count:foreign.length});
  });
  return {
    sync,
    start:Effect.gen(function* () {
      // Startup's caller runs this only after the normal command/event runtime
      // is activated. There is never a hidden synthetic prompt in this loop.
      yield* dropForeignImports.pipe(Effect.catch((cause) =>
        Effect.logWarning("Imported Codex/Claude threads could not be removed",{cause})));
      yield* Effect.forkScoped(Effect.forever(sync.pipe(Effect.andThen(Effect.sleep("5 seconds")))));
    }),
  };
});
