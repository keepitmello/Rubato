/**
 * Which Rubato (Pi) session an app thread runs in, and the other way round, on T3's V2
 * orchestrator. Three records can answer, newest first:
 *   1. the thread's V2 provider thread: its native thread id is the engine session id
 *      (bridge rpc-connection.mjs reports it as Pi's `sessionFile`);
 *   2. the V1 binding (`provider_session_runtime.resume_cursor_json`, copied into the V2
 *      database with the rest of the V1 tables), for conversations from before V2 that
 *      have not run since;
 *   3. the thread id itself for a session the inventory imported:
 *      `import:<instance>:<serverId>:<sessionId>`.
 */
import { CommandId, OrchestrationMessageContext, ProviderInstanceId, RunId, ThreadId, TurnItemId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { AgentAwarenessRelay } from "../relay/AgentAwarenessRelay.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { RubatoThreadImportError, RubatoThreadImporter, importFailure, isRubatoRun, nextTurnItemOrdinal, saidRunId, ENGINE_RUN_PREFIX,
  type SessionMessage } from "./RubatoThreadImporter.ts";
import { rubatoBridgeFor, type PiBridge, type PiSessionMessage } from "./Drivers/RubatoPiDriver.ts";

export interface PiSessionRef {
  readonly sessionId: string;
  /** The engine the session lives in, when the record says; V2 provider threads do not. */
  readonly serverId: string | null;
}

/** The Rubato session that sent a session message, from its context record (bridge events.mjs). */
const senderSessionOf = (context: unknown): string | null => {
  const record = (context as { readonly records?: ReadonlyArray<{ readonly payload?: { readonly from?: { readonly sessionId?: unknown } } }> } | null)
    ?.records?.[0];
  const sessionId = record?.payload?.from?.sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
};
const BUSY_RUN: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running", "waiting"]);
/**
 * When a run that carries Segno's words asks the relay again while its running state failed to
 * publish: the relay's own retry delays (AgentAwarenessRelay RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS).
 */
export const OWN_RUN_RETRY_DELAYS = ["1 second", "2 seconds", "4 seconds", "8 seconds", "16 seconds"] as const;
const IMPORTED_THREAD = /^import:[^:]+:([^:]+):(.+)$/;
const DRIVER = "rubato-pi";

/** The session an inventory-imported thread's id names. */
export const importedPiSession = (threadId: string): PiSessionRef | null => {
  const match = IMPORTED_THREAD.exec(threadId);
  return match ? { serverId: match[1]!, sessionId: match[2]! } : null;
};

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
};
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * What a thread shows, for the bridge's backfill (bridge backfill.mjs): every message in order with
 * its words and its run, read from the projection the app itself reads.
 */
export const threadMessages = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly message_id: string; readonly role: string; readonly run_id: string | null;
      readonly created_at: string; readonly payload_json: string }>`
      SELECT message_id, role, run_id, created_at, payload_json FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} ORDER BY created_at ASC, message_id ASC`;
    return rows.map((row) => ({ id: row.message_id, role: row.role, runId: row.run_id, turnId: row.run_id,
      createdAt: row.created_at, text: text(field(parse(row.payload_json), "text")) ?? "" }));
  });

/**
 * When the thread had no stream: from each time T3 stopped its provider session (status `stopped`,
 * an idle stop among them) to the next time one was attached or ready again, or now. These are
 * T3's own provider-session events, the same ones that stopped it (bridge backfill.mjs).
 */
export const threadStreamGaps = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly event_type: string; readonly occurred_at: string; readonly payload_json: string }>`
      SELECT event_type, occurred_at, payload_json FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type IN ('provider-session.updated', 'provider-session.attached')
      ORDER BY sequence ASC`;
    return gapsFromProviderEvents(rows);
  });

/** The stream gaps in a thread's provider-session events, oldest first (threadStreamGaps). */
export const gapsFromProviderEvents = (rows: ReadonlyArray<{ readonly event_type: string; readonly occurred_at: string;
  readonly payload_json: string }>): ReadonlyArray<{ from: number; to: number }> => {
  const gaps: Array<{ from: number; to: number }> = [];
  let from: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.occurred_at);
    const status = field(parse(row.payload_json), "status");
    if (from === null && row.event_type === "provider-session.updated" && status === "stopped") from = at;
    else if (from !== null && (row.event_type === "provider-session.attached" || status === "ready" || status === "running")) {
      gaps.push({ from, to: at });
      from = null;
    }
  }
  if (from !== null) gaps.push({ from, to: Number.MAX_SAFE_INTEGER });
  return gaps;
};

/** The Pi session `threadId` runs in, or null. */
export const piSessionOfThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The active provider thread first: after a provider switch an older Rubato
    // provider thread may remain, and the thread no longer runs in it.
    const providerThreads = yield* sql<{ readonly payload_json: string; readonly active: number }>`
      SELECT pt.payload_json AS payload_json,
        CASE WHEN t.active_provider_thread_id = pt.provider_thread_id THEN 1 ELSE 0 END AS active
      FROM orchestration_v2_projection_provider_threads pt
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.thread_id = ${threadId} AND pt.driver = ${DRIVER}
      ORDER BY active DESC, pt.updated_at DESC
      LIMIT 1
    `;
    const nativeId = text(field(field(parse(providerThreads[0]?.payload_json ?? null), "nativeThreadRef"), "nativeId"));
    if (nativeId !== null) return { sessionId: nativeId, serverId: null } satisfies PiSessionRef;
    const legacy = yield* sql<{ readonly resume_cursor_json: string | null }>`
      SELECT resume_cursor_json FROM provider_session_runtime
      WHERE thread_id = ${threadId} AND provider_name = ${DRIVER}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => []));
    const cursor = parse(legacy[0]?.resume_cursor_json ?? null);
    const sessionId = field(cursor, "kind") === DRIVER ? text(field(cursor, "sessionId")) : null;
    if (sessionId !== null) return { sessionId, serverId: text(field(cursor, "serverId")) } satisfies PiSessionRef;
    return importedPiSession(threadId);
  });

/** The live (not deleted) thread that runs in `sessionId`, or null. */
export const threadOfPiSession = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const live = (rows: ReadonlyArray<{ readonly thread_id: string }>) =>
      rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id);
    const fromProviderThread = live(yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id AS thread_id
      FROM orchestration_v2_projection_provider_threads pt
      JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.driver = ${DRIVER} AND t.deleted_at IS NULL
        AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
      ORDER BY pt.updated_at DESC
      LIMIT 1
    `);
    if (fromProviderThread !== null) return fromProviderThread;
    const fromLegacy = live(yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id AS thread_id
      FROM provider_session_runtime b
      JOIN orchestration_v2_projection_threads t ON t.thread_id = b.thread_id
      WHERE b.provider_name = ${DRIVER} AND t.deleted_at IS NULL
        AND json_extract(b.resume_cursor_json, '$.sessionId') = ${sessionId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [])));
    if (fromLegacy !== null) return fromLegacy;
    return live(yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND thread_id LIKE ${"import:%:" + sessionId}
      LIMIT 1
    `);
  });

/** The bridge of a Rubato provider instance: the named one, or the first enabled. */
export const rubatoBridge = (instanceId?: string) =>
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
    if (Option.isNone(registry)) return null;
    if (instanceId !== undefined) {
      const instance = yield* registry.value.getInstance(ProviderInstanceId.make(instanceId));
      return instance === undefined ? null : rubatoBridgeFor(instance) ?? null;
    }
    for (const instance of yield* registry.value.listInstances) {
      if (instance.driverKind !== DRIVER || !instance.enabled) continue;
      const bridge = rubatoBridgeFor(instance);
      if (bridge) return bridge;
    }
    return null;
  });

/**
 * Lets every Rubato bridge find the session a thread already runs in, so its first
 * turn on V2 continues that conversation instead of starting a new one. Bound again
 * whenever the registry rebuilds an instance.
 */
export const bindRubatoSessionLookup = Effect.gen(function* () {
  // Optional services: the startup layer's requirements stay what upstream declares.
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  if (Option.isNone(registry) || Option.isNone(sql)) return;
  // The session's own name becomes the thread's title (rpc-connection.mjs mirrorTitle).
  const retitle = (threadId: string, title: string) => Effect.gen(function* () {
    if (Option.isNone(orchestrator)) return;
    const shell = yield* orchestrator.value.getThreadShell(ThreadId.make(threadId));
    if (shell === null || shell.title === title) return;
    yield* orchestrator.value.dispatch({ type: "thread.metadata.update",
      commandId: CommandId.make(`rubato-title:${threadId}:${yield* Clock.currentTimeMillis}`), threadId: ThreadId.make(threadId), title });
  });
  // A typed `/rewind N` (bridge rpc-connection.mjs control): T3 reverts the /rewind turn and the
  // N before it the way the timeline's revert does, which rewinds the engine through the
  // adapter's rollback. Files stay, as the command says.
  const liveRuns = (threadId: string) => Effect.gen(function* () {
    if (Option.isNone(orchestrator)) return yield* new RubatoThreadImportError({ detail: "The conversation is not available" });
    const records = yield* orchestrator.value.getThreadRecords(ThreadId.make(threadId), ["runs", "checkpoints"]);
    // A run this overlay wrote (Segno's words, a turn the engine ran unwatched) is no turn T3 can rewind.
    return { runs: records.runs.filter((run) => run.status !== "rolled_back" && !isRubatoRun(run.id)).sort((left, right) => left.ordinal - right.ordinal),
      checkpoints: records.checkpoints };
  });
  const checkRewind = (threadId: string, turns: number) => Effect.gen(function* () {
    const settled = (yield* liveRuns(threadId)).runs.filter((run) => !BUSY_RUN.has(run.status)).length;
    if (turns > settled) return yield* new RubatoThreadImportError({ detail: settled === 0
      ? "There is nothing to rewind yet" : `This conversation has only ${settled} turn${settled === 1 ? "" : "s"} to rewind` });
  });
  const rewindConversation = (threadId: string, turns: number) => Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const { runs, checkpoints } = yield* liveRuns(threadId);
      if (runs.some((run) => BUSY_RUN.has(run.status))) {
        if (attempt >= 150) return yield* new RubatoThreadImportError({ detail: "The /rewind turn did not settle" });
        yield* Effect.sleep("200 millis");
        continue;
      }
      // The last run is the /rewind turn itself; it goes with the N before it.
      const keep = runs.length - 1 - turns;
      if (keep < 0) return yield* new RubatoThreadImportError({ detail: "Fewer turns than /rewind asked for" });
      const target = keep === 0
        ? checkpoints.findLast((checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null)
        : checkpoints.find((checkpoint) => checkpoint.id === runs[keep - 1]!.checkpointId);
      if (!target || target.status !== "ready") return yield* new RubatoThreadImportError({ detail: "That turn has no checkpoint to rewind to" });
      if (Option.isNone(orchestrator)) return;
      yield* orchestrator.value.dispatch({ type: "checkpoint.rollback",
        commandId: CommandId.make(`rubato-rewind:${threadId}:${yield* Clock.currentTimeMillis}`), threadId: ThreadId.make(threadId),
        scopeId: target.scopeId, checkpointId: target.id, restoreFiles: false });
      return;
    }
  });
  // A message another conversation sent while the thread was open (bridge rpc-connection.mjs):
  // written once, as an agent's message with its sender context and, when the sender is a
  // thread here, a link to it.
  const importer = yield* Effect.serviceOption(RubatoThreadImporter);
  // One own run at a time, so two of Segno's messages never take the same run ordinal.
  const ownRuns = yield* Semaphore.make(1);
  // The phone hears of a thread only from the states the relay publishes, and it publishes from a
  // worker that reads the thread when it gets to it: a run that finishes before the relay got its
  // running state out is read only as finished, the same as the last state, and nothing goes out.
  // So the own run stays running until the relay has published it: publishThread works the queue
  // through to this thread, and while that publish failed and waits on a retry (publishPending,
  // apply.mjs edit), the run asks again on the relay's own schedule, then gives up.
  const relay = yield* Effect.serviceOption(AgentAwarenessRelay);
  const ownRunShown = (thread: ThreadId) => Option.isNone(relay) ? Effect.sleep("1 second") : Effect.gen(function* () {
    for (const delay of [...OWN_RUN_RETRY_DELAYS, null]) {
      yield* relay.value.publishThread(thread);
      if (!(yield* relay.value.publishPending(thread)) || delay === null) return;
      yield* Effect.sleep(delay);
    }
  });
  /**
   * Segno's words from a hidden run (tell_user) in a run of their own, so the phone hears of them
   * (RubatoThreadImporter appendOwnRun). While the thread has a run going, the words go in as a
   * plain message instead: that run's own ending notifies, and a second running run would take the
   * messages the person sends meanwhile. A message the person queued while the own run showed as
   * running starts once it completes, as it would after any run.
   */
  const appendOwnRun = (thread: ThreadId, message: SessionMessage, ordinal: () => Effect.Effect<number, RubatoThreadImportError>) =>
    ownRuns.withPermits(1)(Effect.gen(function* () {
      if (Option.isNone(orchestrator) || Option.isNone(importer)) return false;
      const records = yield* orchestrator.value.getThreadRecords(thread, ["runs"]).pipe(
        Effect.mapError(importFailure("Could not read the thread's runs")));
      // The same words delivered twice (the live stream and an attach's snapshot) are written once. A
      // run an attempt opened and never completed (the server went down during the hold) is
      // completed with the words now; the caller found no message for them.
      const opened = records.runs.find((run) => run.id === saidRunId(message.id));
      if (opened?.status === "completed") return true;
      if (opened === undefined && records.runs.some((run) => BUSY_RUN.has(run.status))) return false;
      const shell = yield* orchestrator.value.getThreadShell(thread).pipe(Effect.mapError(importFailure("Could not read the thread")));
      if (shell === null) return false;
      yield* importer.value.appendOwnRun({ threadId: thread, message, itemOrdinal: yield* ordinal(),
        runOrdinal: opened?.ordinal ?? Math.max(0, ...records.runs.map((run) => run.ordinal)) + 1,
        providerInstanceId: shell.modelSelection.instanceId, modelSelection: shell.modelSelection, whileRunning: ownRunShown(thread),
        ...(opened === undefined ? {} : { opened }) });
      yield* orchestrator.value.resumeQueuedRuns.pipe(Effect.ignore);
      return true;
    }));
  /**
   * A turn the engine runs while T3 holds no stream on the thread (bridge engine-runs.mjs): a run
   * that shows running, so the thread reads as working and is not settled meanwhile. None while the
   * thread runs something else; its messages then go in plainly.
   */
  const engineRuns = new Map<string, OrchestrationV2Run>();
  const openEngineRun = (threadId: string, request: { readonly sessionId: string }) => ownRuns.withPermits(1)(Effect.gen(function* () {
    if (Option.isNone(orchestrator) || Option.isNone(importer)) return null;
    const thread = ThreadId.make(threadId);
    const records = yield* orchestrator.value.getThreadRecords(thread, ["runs"]).pipe(
      Effect.mapError(importFailure("Could not read the thread's runs")));
    if (records.runs.some((run) => BUSY_RUN.has(run.status))) return null;
    const shell = yield* orchestrator.value.getThreadShell(thread).pipe(Effect.mapError(importFailure("Could not read the thread")));
    if (shell === null) return null;
    const run = yield* importer.value.openRun({ threadId: thread, thread: records.thread,
      runId: RunId.make(`${ENGINE_RUN_PREFIX}${request.sessionId}:${yield* Clock.currentTimeMillis}`),
      runOrdinal: Math.max(0, ...records.runs.map((one) => one.ordinal)) + 1,
      providerInstanceId: shell.modelSelection.instanceId, modelSelection: shell.modelSelection });
    engineRuns.set(run.id, run);
    return run.id as string;
  }));
  const closeEngineRun = (_threadId: string, runId: string, status: "completed" | "interrupted" | "failed") => Effect.gen(function* () {
    const run = engineRuns.get(runId);
    if (run === undefined || Option.isNone(importer) || Option.isNone(orchestrator)) return;
    engineRuns.delete(runId);
    yield* importer.value.closeRun({ run, status });
    // A message the person sent meanwhile waited behind this run, as behind any run.
    yield* orchestrator.value.resumeQueuedRuns.pipe(Effect.ignore);
  });
  const appendSessionMessage = (threadId: string, item: PiSessionMessage) => Effect.gen(function* () {
    if (Option.isNone(orchestrator) || Option.isNone(importer)) {
      return yield* new RubatoThreadImportError({ detail: "The thread writer is not running" });
    }
    const thread = ThreadId.make(threadId);
    if ((yield* orchestrator.value.getTurnItem({ threadId: thread, itemId: TurnItemId.make(item.id) })) !== null) return;
    const context = Schema.decodeUnknownOption(OrchestrationMessageContext)(item.context);
    const senderSession = senderSessionOf(item.context);
    const senderThreadId = senderSession === null ? null
      : yield* threadOfPiSession(senderSession).pipe(Effect.provideService(SqlClient.SqlClient, sql.value), Effect.orElseSucceed(() => null));
    const ordinal = () => nextTurnItemOrdinal(thread).pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
    const message: SessionMessage = {
      role: "session", id: item.id, text: item.text, createdAt: item.createdAt,
      // A backfilled message stays in the run it followed (bridge backfill.mjs), where T3 orders it.
      ...(typeof item.runId === "string" && item.runId !== "" && item.ownRun !== true ? { runId: RunId.make(item.runId) } : {}),
      ...(Option.isSome(context) ? { context: context.value } : {}),
      ...(senderThreadId === null ? {} : { senderThreadId: ThreadId.make(senderThreadId) }),
    };
    if (item.ownRun === true && (yield* appendOwnRun(thread, message, ordinal))) return;
    yield* importer.value.appendSessionMessage({ threadId: thread, ordinal: yield* ordinal(), message });
  });
  const bind = Effect.gen(function* () {
    for (const instance of yield* registry.value.listInstances) {
      const bridge: PiBridge | undefined = rubatoBridgeFor(instance);
      if (!bridge) continue;
      bridge.boundSession = (threadId: string) =>
        Effect.runPromise(piSessionOfThread(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql.value)));
      bridge.sessionTitle = (threadId: string, title: string) => Effect.runPromise(retitle(threadId, title));
      bridge.checkRewind = (threadId: string, turns: number) => Effect.runPromise(checkRewind(threadId, turns));
      bridge.appendSessionMessage = (threadId: string, item: PiSessionMessage) => Effect.runPromise(appendSessionMessage(threadId, item));
      bridge.openEngineRun = (threadId: string, request: { readonly sessionId: string }) => Effect.runPromise(openEngineRun(threadId, request));
      bridge.closeEngineRun = (threadId: string, runId: string, status: "completed" | "interrupted" | "failed") =>
        Effect.runPromise(closeEngineRun(threadId, runId, status));
      // What a thread shows and when it had no stream: the bridge's backfill compares these with the session.
      bridge.projectedThread = (threadId: string) =>
        Effect.runPromise(threadMessages(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql.value),
          Effect.map((messages) => ({ messages, checkpoints: [] }))));
      bridge.streamGaps = (threadId: string) =>
        Effect.runPromise(threadStreamGaps(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql.value)));
      bridge.rewindConversation = (threadId: string, request: {readonly turns: number}) =>
        Effect.runPromise(rewindConversation(threadId, request.turns));
    }
  });
  yield* bind;
  const changes = yield* registry.value.subscribeChanges;
  yield* Effect.forkScoped(Effect.forever(PubSub.take(changes).pipe(Effect.andThen(bind))));
});

/** The thread that shows a Pi session nothing is bound to (the inventory's id scheme). */
export const importedPiThreadId = (instanceId: string, serverId: string, sessionId: string) =>
  ThreadId.make(`import:${instanceId}:${serverId}:${sessionId}`);

/**
 * The sidebar's "Fork thread": a new Rubato session holding `threadId`'s whole completed
 * history (the engine counts a final failed or interrupted reply as completed), shown as its
 * own thread in the same project with the same model and modes. Works for threads from
 * before V2 too: the source session comes from any of piSessionOfThread's records.
 */
export const forkWholeThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = (yield* orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.mapError(importFailure("Could not read the thread to fork")))).thread;
    const session = yield* piSessionOfThread(threadId).pipe(Effect.mapError(importFailure("Could not find the thread's Rubato session")));
    if (session === null) return yield* new RubatoThreadImportError({ detail: "This thread has no Rubato session to fork" });
    const bridge = yield* rubatoBridge(source.modelSelection.instanceId);
    if (bridge === null) return yield* new RubatoThreadImportError({ detail: "The Rubato provider is not running" });
    const title = `${source.title} (fork)`;
    const forked = yield* Effect.tryPromise({
      try: () => bridge.forkSession(session.sessionId, title),
      catch: importFailure("The engine could not fork the conversation"),
    });
    if (!forked?.sessionId) return yield* new RubatoThreadImportError({ detail: "The engine did not create the fork" });
    bridge.claimed.add(forked.sessionId);
    const transcript = yield* Effect.tryPromise({
      try: () => bridge.transcript(forked.sessionId),
      catch: importFailure("Could not read the forked conversation"),
    });
    const target = importedPiThreadId(source.modelSelection.instanceId, forked.serverId, forked.sessionId);
    const messages = bridge.importedMessages(forked.sessionId, transcript.messages, target)
      // A reply that only called tools has no text; the timeline shows text, not calls.
      .flatMap((message) => message.context === undefined && (message.role === "user" || message.role === "assistant")
        && message.text.trim() !== "" ? [{ role: message.role, text: message.text, createdAt: message.createdAt }] : []);
    const importer = yield* RubatoThreadImporter;
    return yield* importer.importPiSessionThread({
      threadId: target, projectId: source.projectId, title, sessionId: forked.sessionId,
      modelSelection: source.modelSelection, runtimeMode: source.runtimeMode, interactionMode: source.interactionMode,
      createdAt: DateTime.formatIso(yield* DateTime.now), messages,
    });
  });
