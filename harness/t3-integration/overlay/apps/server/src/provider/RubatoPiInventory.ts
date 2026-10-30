/**
 * Rubato sessions started elsewhere (the CLI, the scheduler, another window) show as threads,
 * on T3's V2 orchestrator. Every few seconds the engine's session list is compared with the
 * threads: a session no thread shows yet becomes one, in the project of its folder (made if
 * missing), with its stored history (RubatoThreadImporter importPiSessionThread). Its first
 * turn from T3 continues that same session. Which sessions count is the bridge's rule
 * (bridge.mjs inventory: live ones, and ones in an existing folder outside temp dirs).
 *
 * It never starts a model turn and never owns Pi workers or conversation files. A thread the
 * person deleted or archived is not brought back.
 *
 * A session the engine is running (a lead Segno opened, a scheduled run) is imported as active,
 * not settled, and its run shows as a turn of its thread like any other: thinking, tools and
 * steering included (user items 4c2a0df1, a8508a74). The same goes for a thread T3 let go idle
 * whose session the engine runs again. The inventory sends the thread the bridge's
 * `engineRunText`; T3 opens the thread's stream for it as for any turn, and the stream adopts the
 * engine's run instead of prompting (bridge rpc-connection.mjs ENGINE_RUN_TEXT). Segno's own
 * conversation is a chat log and is left out (companion-thread.mjs).
 */
import { CommandId, MessageId, OrchestrationMessageContext, ProjectId, ThreadId, type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { isAbsoluteLocalPath, rubatoBridgeFor, type PiSummary } from "./Drivers/RubatoPiDriver.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { BUSY_RUN, importedPiThreadId, threadOfPiSession } from "./RubatoPiSessions.ts";
import { RubatoThreadImporter, type PiSessionThreadInput } from "./RubatoThreadImporter.ts";

// The loop passes every five seconds. A fork wants its new session shown now: it cuts the
// wait short, or, asked during a pass that may have listed sessions before the fork existed,
// lets the next pass start without waiting.
let wake: Deferred.Deferred<void> | undefined;
let wakePending = false;
export const syncRubatoInventoryNow = Effect.suspend(() => {
  if (wake) return Effect.asVoid(Deferred.succeed(wake, undefined));
  wakePending = true;
  return Effect.void;
});
const nextPass = Effect.gen(function* () {
  if (wakePending) { wakePending = false; return; }
  const current = yield* Deferred.make<void>();
  wake = current;
  yield* Effect.race(Effect.sleep("5 seconds"), Deferred.await(current)).pipe(
    Effect.ensuring(Effect.sync(() => { if (wake === current) wake = undefined; })),
  );
});

/** Whether the engine is running a session now (its session list row's status). */
export const engineRunning = (entry: Pick<PiSummary, "status">) =>
  entry.status === "running" || entry.status === "starting" || entry.status === "waiting";

/** A folder name for a session's project: the last path part, Unix or Windows. */
export const projectTitleOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

export const makeRubatoPiInventory = Effect.gen(function* () {
  // Optional services: the startup layer's requirements stay what upstream declares.
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const projects = yield* Effect.serviceOption(ProjectService);
  const importer = yield* Effect.serviceOption(RubatoThreadImporter);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const crypto = yield* Effect.serviceOption(Crypto.Crypto);
  const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  if (Option.isNone(registry) || Option.isNone(projects) || Option.isNone(importer) || Option.isNone(sql) || Option.isNone(crypto))
    return { sync: Effect.void, start: Effect.void };
  const uuid = crypto.value.randomUUIDv4();

  // A thread row under the import id, kept or deleted: either way the session needs no new one.
  const knownThread = (threadId: string) => sql.value<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0));

  const projectFor = (cwd: string) => Effect.gen(function* () {
    const existing = yield* projects.value.getByWorkspaceRoot(cwd, { includeDeleted: true });
    if (Option.isSome(existing)) return existing.value.deletedAt ? null : existing.value;
    return yield* projects.value.create({ commandId: CommandId.make(`rubato-inventory:${yield* uuid}`),
      projectId: ProjectId.make(yield* uuid), title: projectTitleOf(cwd), workspaceRoot: cwd });
  });

  // Sessions a thread already shows, or that can never get one, are settled for this server's
  // life: a pass over a thousand old sessions then reads nothing for them. Without this every
  // five-second pass asked the database about each one again (the live V2 server spent ~70% CPU).
  const settledSessions = new Set<string>();
  const importSession = (instance: ProviderInstance, entry: PiSummary) => Effect.gen(function* () {
    if (settledSessions.has(entry.sessionId)) return;
    // Old sessions without a cwd cannot be assigned an invented project.
    if (!entry.cwd || !isAbsoluteLocalPath(entry.cwd)) { settledSessions.add(entry.sessionId); return; }
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || bridge.ownsSession(entry.sessionId)) return;
    if ((yield* threadOfPiSession(entry.sessionId)) !== null) { settledSessions.add(entry.sessionId); return; }
    const threadId = importedPiThreadId(instance.instanceId, entry.serverId, entry.sessionId);
    if (yield* knownThread(threadId)) { settledSessions.add(entry.sessionId); return; }
    const project = yield* projectFor(entry.cwd);
    if (project === null) return;
    const saved = yield* Effect.tryPromise(() => bridge.transcript(entry.sessionId));
    const snapshot = yield* instance.snapshot.getSnapshot;
    const lastModel = "model" in saved && typeof saved.model === "string" ? saved.model : null;
    const preferred = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
    // A running session's thread starts on the model it runs on: the turn that shows its run then
    // selects nothing new, even before the session has replied once.
    const running = engineRunning(entry) ? yield* Effect.promise(() => bridge.runningModel(entry.sessionId)) : null;
    const model = running ?? lastModel ?? preferred?.slug;
    if (!model) return;
    const modelSelection: ModelSelection = { instanceId: instance.instanceId as ProviderInstanceId, model };
    const messages = bridge.importedMessages(entry.sessionId, saved.messages, threadId, { companion: entry.companion === true }).flatMap((message): PiSessionThreadInput["messages"] => {
      if (message.text.trim() === "") return [];
      // A message another conversation sent keeps its sender context (bridge sessionMessageFrom).
      if (message.context !== undefined) {
        const context = Schema.decodeUnknownOption(OrchestrationMessageContext)(message.context);
        return [{ role: "session" as const, id: message.id, text: message.text, createdAt: message.createdAt,
          ...(Option.isSome(context) ? { context: context.value } : {}) }];
      }
      return [{ role: message.role, text: message.text, createdAt: message.createdAt }];
    });
    yield* importer.value.importPiSessionThread({ threadId, projectId: project.id, title: entry.title || "Rubato session",
      sessionId: entry.sessionId, modelSelection, runtimeMode: "full-access", interactionMode: "default",
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(entry.createdAt)), messages, settled: !engineRunning(entry) });
    settledSessions.add(entry.sessionId);
  }).pipe(Effect.catch((cause) => Effect.logWarning("Rubato session projection skipped", { sessionId: entry.sessionId, cause })));

  // A thread the person has not deleted or archived: only such a one shows a running session.
  const openThread = (threadId: string) => sql.value<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE thread_id = ${threadId} AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0));

  // The thread a running session shows in: the one bound to it, or the one the inventory imported.
  // While T3 holds its stream the adapter shows the run itself (a wake); while the thread runs or
  // queues a turn, that turn has it.
  const showEngineRun = (instance: ProviderInstance, entry: PiSummary) => Effect.gen(function* () {
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || entry.companion === true || Option.isNone(orchestrator)) return;
    const threadId = (yield* threadOfPiSession(entry.sessionId)) ?? importedPiThreadId(instance.instanceId, entry.serverId, entry.sessionId);
    if (bridge.rpcFor(threadId) || !(yield* openThread(threadId))) return;
    const { runs } = yield* orchestrator.value.getThreadRecords(ThreadId.make(threadId), ["runs"]);
    if (runs.some((run) => BUSY_RUN.has(run.status))) return;
    const id = yield* uuid;
    bridge.markEngineRun(threadId);
    yield* orchestrator.value.dispatch({ type: "message.dispatch", commandId: CommandId.make(`rubato-engine-run:${id}`),
      threadId: ThreadId.make(threadId), messageId: MessageId.make(`rubato-engine-run:${id}`), text: bridge.engineRunText,
      notification: { source: { kind: "system" }, outcome: "updated", summary: "Rubato started this turn" },
      attachments: [], dispatchMode: { type: "queue_after_active" }, createdBy: "agent", creationSource: "server" });
  }).pipe(Effect.catch((cause) => Effect.logWarning("Rubato engine run not shown", { sessionId: entry.sessionId, cause })));

  const syncInstance = (instance: ProviderInstance) => Effect.gen(function* () {
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || !instance.enabled) return;
    const inventory = yield* Effect.tryPromise(() => bridge.inventory());
    for (const entry of inventory) yield* importSession(instance, entry);
    for (const entry of inventory) if (engineRunning(entry)) yield* showEngineRun(instance, entry);
  }).pipe(Effect.catch((cause) => Effect.logWarning("Rubato inventory is unavailable", { instanceId: instance.instanceId, cause })));

  const sync = Effect.gen(function* () {
    for (const instance of yield* registry.value.listInstances) yield* syncInstance(instance);
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
  return {
    sync,
    // The caller runs this only after the command runtime is active.
    start: Effect.forkScoped(Effect.forever(sync.pipe(Effect.andThen(nextPass)))).pipe(Effect.asVoid),
  };
});
