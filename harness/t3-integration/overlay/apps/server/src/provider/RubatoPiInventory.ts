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
 */
import { CommandId, ProjectId, type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";
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
import { importedPiThreadId, threadOfPiSession } from "./RubatoPiSessions.ts";
import { RubatoThreadImporter } from "./RubatoThreadImporter.ts";

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

/** A folder name for a session's project: the last path part, Unix or Windows. */
export const projectTitleOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

export const makeRubatoPiInventory = Effect.gen(function* () {
  // Optional services: the startup layer's requirements stay what upstream declares.
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const projects = yield* Effect.serviceOption(ProjectService);
  const importer = yield* Effect.serviceOption(RubatoThreadImporter);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const crypto = yield* Effect.serviceOption(Crypto.Crypto);
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

  const importSession = (instance: ProviderInstance, entry: PiSummary) => Effect.gen(function* () {
    // Old sessions without a cwd cannot be assigned an invented project.
    if (!entry.cwd || !isAbsoluteLocalPath(entry.cwd)) return;
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || bridge.ownsSession(entry.sessionId)) return;
    if ((yield* threadOfPiSession(entry.sessionId)) !== null) return;
    const threadId = importedPiThreadId(instance.instanceId, entry.serverId, entry.sessionId);
    if (yield* knownThread(threadId)) return;
    const project = yield* projectFor(entry.cwd);
    if (project === null) return;
    const saved = yield* Effect.tryPromise(() => bridge.transcript(entry.sessionId));
    const snapshot = yield* instance.snapshot.getSnapshot;
    const lastModel = "model" in saved && typeof saved.model === "string" ? saved.model : null;
    const preferred = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
    const model = lastModel ?? preferred?.slug;
    if (!model) return;
    const modelSelection: ModelSelection = { instanceId: instance.instanceId as ProviderInstanceId, model };
    const messages = bridge.importedMessages(entry.sessionId, saved.messages, threadId).flatMap((message) =>
      message.context === undefined && (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [{ role: message.role, text: message.text, createdAt: message.createdAt }] : []);
    yield* importer.value.importPiSessionThread({ threadId, projectId: project.id, title: entry.title || "Rubato session",
      sessionId: entry.sessionId, modelSelection, runtimeMode: "full-access", interactionMode: "default",
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(entry.createdAt)), messages, settled: true });
  }).pipe(Effect.catch((cause) => Effect.logWarning("Rubato session projection skipped", { sessionId: entry.sessionId, cause })));

  const syncInstance = (instance: ProviderInstance) => Effect.gen(function* () {
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || !instance.enabled) return;
    const inventory = yield* Effect.tryPromise(() => bridge.inventory());
    for (const entry of inventory) yield* importSession(instance, entry);
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
