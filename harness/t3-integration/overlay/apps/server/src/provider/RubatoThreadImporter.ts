/**
 * Writes a V2 thread that shows a Rubato session and continues in it. A service inside the V2
 * runtime (runtimeLayer.ts), like upstream's AgentSessionImporter, because it writes through
 * the V2 event sink, which the runtime keeps to its own services.
 */
import {
  EventId, MessageId, ProviderDriverKind, RunId, TurnItemId,
  type ModelSelection, type ProviderInstanceId, type OrchestrationV2AppThread, type OrchestrationV2ConversationMessage,
  type OrchestrationMessageContext, type OrchestrationV2Run,
  type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread, type OrchestrationV2TurnItem,
  type ProjectId, type ProviderInteractionMode, type RuntimeMode, type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";

const DRIVER = "rubato-pi";
/** Item ids of a Pi session's stored history written into a V2 thread (importPiSessionThread). */
export const PI_IMPORT_ITEM = (sessionId: string) => `rubato-pi-import:${sessionId}:`;

export class RubatoThreadImportError extends Schema.TaggedError<RubatoThreadImportError>()(
  "RubatoThreadImportError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}
export const importFailure = (detail: string) => (cause: unknown) =>
  new RubatoThreadImportError({ detail: `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });

export interface PiSessionThreadInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly sessionId: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
  /**
   * Stored history to show; the session keeps it natively, so its first turn replays none. A
   * message another conversation sent carries its id and context (bridge events.mjs sessionMessageFrom).
   */
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string; readonly createdAt: string } | SessionMessage>;
  /** False leaves the thread among the active ones (a fork); true files it as settled (an import). */
  readonly settled?: boolean;
}

/**
 * A V2 thread that shows a Rubato session and continues in it, written the way upstream's
 * AgentSessionImporter writes an imported native thread: the thread, the session's stored
 * user/assistant messages as imported items, and a provider thread bound to the session.
 * Its first turn resumes that session (rpc-connection.mjs switch_session), and T3's import
 * handoff of these items is answered as already delivered (RubatoPiDriver alreadyNative).
 */
/** A message another conversation sent into the session, shown as an agent's message. */
export interface SessionMessage {
  readonly role: "session";
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly context?: OrchestrationMessageContext;
  readonly senderThreadId?: ThreadId;
  /** The run it belongs to: a backfilled message stays in the run it followed. */
  readonly runId?: RunId;
}
/**
 * Records that make a session message one of the thread's own messages, written without the record:
 * `rubato-said`, what Segno said to the person with reply or say (bridge said-echo.mjs), is Segno's
 * words; `rubato-backfill`, a turn the engine ran while T3 held no stream on the thread (bridge
 * backfill.mjs), keeps the role it had in the session.
 */
export const SAID_KIND = "rubato-said";
export const BACKFILL_KIND = "rubato-backfill";
/**
 * The run a reply or say gets (appendOwnRun): `rubato-said:<message id>`. Its message and turn
 * item carry that id too, and the run's userMessageId names the message, so a client that sees the
 * thread's latest run finish can tell Segno spoke and find the words.
 */
export const SAID_RUN_PREFIX = "rubato-said:";
export const saidRunId = (messageId: string) => RunId.make(`${SAID_RUN_PREFIX}${messageId}`);
/**
 * The run of a turn the engine ran while T3 held no stream on the thread (openEngineRun, bridge
 * engine-runs.mjs): `rubato-engine:<session id>:<when it opened>`.
 */
/** Whether a run is one appendOwnRun wrote: Segno's words, not a turn. */
export const isSaidRun = (runId: string) => runId.startsWith(SAID_RUN_PREFIX);
export const ENGINE_RUN_PREFIX = "rubato-engine:";
/** Whether a run is one this overlay wrote (Segno's words, an engine-run turn) rather than a turn T3 ran. */
export const isRubatoRun = (runId: string) => runId.startsWith(SAID_RUN_PREFIX) || runId.startsWith(ENGINE_RUN_PREFIX);
const ownRole = (context: unknown): "assistant" | "user" | null => {
  const records = (context as { readonly records?: ReadonlyArray<{ readonly kind?: unknown; readonly payload?: unknown }> } | undefined)?.records;
  if (!Array.isArray(records)) return null;
  for (const record of records) {
    if (record?.kind === SAID_KIND) return "assistant";
    if (record?.kind === BACKFILL_KIND) {
      const role = (record.payload as { readonly role?: unknown } | undefined)?.role;
      return role === "user" ? "user" : "assistant";
    }
  }
  return null;
};
/** The message and turn item of a session message, both keyed by its id (a replay replaces them). */
export const sessionMessageRecords = (threadId: ThreadId, entry: SessionMessage, ordinal: number) => {
  const at = DateTime.makeUnsafe(entry.createdAt);
  const messageId = MessageId.make(entry.id);
  const own = ownRole(entry.context);
  const runId = entry.runId ?? null;
  if (own !== null) {
    const common = { id: TurnItemId.make(entry.id), threadId, runId, nodeId: null, providerThreadId: null, providerTurnId: null,
      nativeItemRef: null, parentItemId: null, ordinal, status: "completed" as const, title: null, startedAt: at, completedAt: at,
      updatedAt: at };
    if (own === "user") {
      const message: OrchestrationV2ConversationMessage = { createdBy: "user", creationSource: "provider", id: messageId, threadId,
        runId, nodeId: null, role: "user", text: entry.text, attachments: [], streaming: false, createdAt: at, updatedAt: at };
      const turnItem: OrchestrationV2TurnItem = { ...common, createdBy: "user", creationSource: "provider", type: "user_message",
        messageId, inputIntent: "turn_start", text: entry.text, attachments: [] };
      return { message, turnItem, at };
    }
    const message: OrchestrationV2ConversationMessage = { createdBy: "agent", creationSource: "provider", id: messageId, threadId,
      runId, nodeId: null, role: "assistant", text: entry.text, attachments: [], streaming: false, createdAt: at, updatedAt: at };
    const turnItem: OrchestrationV2TurnItem = { ...common, type: "assistant_message", messageId, text: entry.text, streaming: false };
    return { message, turnItem, at };
  }
  // Upstream marks a message another agent sent this way ("Sent by another agent").
  const author = { createdBy: "agent" as const, creationSource: "provider" as const,
    ...(entry.senderThreadId === undefined ? {} : { senderThreadId: entry.senderThreadId }) };
  const context = entry.context === undefined ? {} : { context: entry.context };
  const message: OrchestrationV2ConversationMessage = { ...author, id: messageId, threadId, runId, nodeId: null,
    role: "user", text: entry.text, ...context, attachments: [], streaming: false, createdAt: at, updatedAt: at };
  const turnItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(entry.id), threadId, runId, nodeId: null, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal, status: "completed", title: null, startedAt: at, completedAt: at,
    updatedAt: at, ...author, type: "user_message", messageId, inputIntent: "turn_start", text: entry.text, ...context,
    attachments: [],
  };
  return { message, turnItem, at };
};

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const importPiSessionThread = (input: PiSessionThreadInput) => Effect.gen(function* () {
    const driver = ProviderDriverKind.make(DRIVER);
    const instanceId = input.modelSelection.instanceId;
    const createdAt = DateTime.makeUnsafe(input.createdAt);
    const updatedAt = input.messages.length === 0 ? createdAt : DateTime.makeUnsafe(input.messages.at(-1)!.createdAt);
    const providerThreadId = idAllocator.derive.providerThread({ driver, nativeThreadId: input.sessionId });
    const prefix = PI_IMPORT_ITEM(input.sessionId);
    const settled = input.settled === true;
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system", creationSource: "server", id: input.threadId, projectId: input.projectId,
      title: input.title.trim() === "" ? "Rubato session" : input.title, providerInstanceId: instanceId,
      modelSelection: input.modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode,
      branch: null, worktreePath: null, linkedPullRequest: null, branchPullRequest: null,
      activeProviderThreadId: providerThreadId, historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null, createdAt, updatedAt, archivedAt: null,
      settledOverride: settled ? "settled" : null, settledAt: settled ? updatedAt : null, unsettledAt: null,
      snoozedUntil: null, snoozedAt: null, pinnedAt: null, pinOrderKey: null, activeOrderKey: null,
      lastVisitedAt: null, deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId, driver, providerInstanceId: instanceId, providerSessionId: null,
      appThreadId: input.threadId, ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: input.sessionId, strength: "strong" },
      nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: null, lastRunOrdinal: null,
      handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [], createdAt, updatedAt,
    };
    const messageEvents = input.messages.flatMap((entry, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const suffix = String(index).padStart(6, "0");
      if (entry.role === "session") {
        const { message, turnItem, at } = sessionMessageRecords(input.threadId, entry, index + 1);
        return [
          { id: EventId.make(`${prefix}message:${input.threadId}:${suffix}`), type: "message.updated",
            threadId: input.threadId, occurredAt: at, payload: message },
          { id: EventId.make(`${prefix}turn-item:${input.threadId}:${suffix}`), type: "turn-item.updated",
            threadId: input.threadId, occurredAt: at, payload: turnItem },
        ];
      }
      const messageId = MessageId.make(`${input.threadId}:${suffix}`);
      const at = DateTime.makeUnsafe(entry.createdAt);
      const message: OrchestrationV2ConversationMessage = {
        createdBy: entry.role === "user" ? "user" : "agent", creationSource: "server", id: messageId,
        threadId: input.threadId, runId: null, nodeId: null, role: entry.role, text: entry.text,
        attachments: [], streaming: false, createdAt: at, updatedAt: at,
      };
      const common = {
        id: TurnItemId.make(`${prefix}${input.threadId}:${suffix}`), threadId: input.threadId, runId: null,
        nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
        ordinal: index + 1, status: "completed" as const, title: null, startedAt: at, completedAt: at, updatedAt: at,
      };
      const turnItem: OrchestrationV2TurnItem = entry.role === "user"
        ? { ...common, createdBy: "user", creationSource: "server", type: "user_message", messageId,
            inputIntent: "turn_start", text: entry.text, attachments: [] }
        : { ...common, type: "assistant_message", messageId, text: entry.text, streaming: false };
      return [
        { id: EventId.make(`${prefix}message:${input.threadId}:${suffix}`), type: "message.updated",
          threadId: input.threadId, occurredAt: at, payload: message },
        { id: EventId.make(`${prefix}turn-item:${input.threadId}:${suffix}`), type: "turn-item.updated",
          threadId: input.threadId, occurredAt: at, payload: turnItem },
      ];
    });
    yield* eventSink.write({ events: [
      { id: EventId.make(`${prefix}thread:${input.threadId}:created`), type: "thread.created",
        threadId: input.threadId, providerInstanceId: instanceId, occurredAt: createdAt, payload: appThread },
      ...messageEvents,
      { id: EventId.make(`${prefix}provider-thread:${providerThreadId}`), type: "provider-thread.updated",
        threadId: input.threadId, driver, providerInstanceId: instanceId, occurredAt: updatedAt, payload: providerThread },
    ] }).pipe(Effect.mapError(importFailure("Could not write the Rubato thread")));
    return input.threadId;
  });
  /**
   * A step rewind's cut (RubatoStepRewind.ts): the run ends at the step, as interrupted, so
   * T3's own resume path can continue it; the rows the cut drops move onto a run recorded
   * as rolled back. V2 drops a rolled-back run's rows everywhere (its timeline queries, the
   * web and the phone), so they leave the thread the way a whole-turn rewind's rows do.
   */
  const cutRun = (input: CutRunInput) => Effect.gen(function* () {
    const now = yield* DateTime.now;
    const event = () => idAllocator.allocate.event({ threadId: input.run.threadId }).pipe(
      Effect.mapError(importFailure("Could not number the step rewind's events")));
    const cutRunId = RunId.make(`${input.run.id}:rubato-step-cut:${DateTime.toEpochMillis(now)}`);
    // Ranked before the cut run itself, which T3 must find as the latest run to resume it.
    const cut: OrchestrationV2Run = {
      ...input.run, id: cutRunId, ordinal: input.nextOrdinal, status: "rolled_back", checkpointId: null,
      queuePosition: null, completedAt: input.run.completedAt ?? input.run.startedAt ?? now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [
      { id: yield* event(), type: "run.updated", threadId: input.run.threadId, runId: cutRunId,
        providerInstanceId: input.run.providerInstanceId, occurredAt: now, payload: cut },
      ...(yield* Effect.forEach(input.items, (item) => Effect.map(event(), (id): OrchestrationV2DomainEvent =>
        ({ id, type: "turn-item.updated", threadId: input.run.threadId, occurredAt: now, payload: { ...item, runId: cutRunId } })))),
      ...(yield* Effect.forEach(input.messages, (message) => Effect.map(event(), (id): OrchestrationV2DomainEvent =>
        ({ id, type: "message.updated", threadId: input.run.threadId, occurredAt: now, payload: { ...message, runId: cutRunId } })))),
      { id: yield* event(), type: "run.updated", threadId: input.run.threadId, runId: input.run.id,
        providerInstanceId: input.run.providerInstanceId, occurredAt: now,
        payload: { ...input.run, status: "interrupted", completedAt: now } },
    ];
    yield* eventSink.write({ events }).pipe(Effect.mapError(importFailure("Could not write the step rewind")));
    return cutRunId;
  });
  /**
   * A notice row in a thread outside any turn (the voice service's queued, sent and failed
   * notices). `ordinal` is the thread's next turn-item ordinal; the caller reads it.
   */
  const appendNotice = (input: NoticeInput) => Effect.gen(function* () {
    const now = yield* DateTime.now;
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(input.id), threadId: input.threadId, runId: null, nodeId: null, providerThreadId: null,
      providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: input.ordinal, status: "completed",
      title: null, startedAt: now, completedAt: now, updatedAt: now, type: "system_notice", message: input.message,
    };
    const id = yield* idAllocator.allocate.event({ threadId: input.threadId }).pipe(
      Effect.mapError(importFailure("Could not number the notice")));
    yield* eventSink.write({ events: [{ id, type: "turn-item.updated", threadId: input.threadId, occurredAt: now, payload: item }] })
      .pipe(Effect.mapError(importFailure("Could not write the notice")));
  });
  /** A session message that arrived while the thread was open (bridge rpc-connection.mjs). */
  const appendSessionMessage = (input: { readonly threadId: ThreadId; readonly message: SessionMessage; readonly ordinal: number }) =>
    Effect.gen(function* () {
      const { message, turnItem, at } = sessionMessageRecords(input.threadId, input.message, input.ordinal);
      const event = () => idAllocator.allocate.event({ threadId: input.threadId }).pipe(
        Effect.mapError(importFailure("Could not number the session message")));
      yield* eventSink.write({ events: [
        { id: yield* event(), type: "message.updated", threadId: input.threadId, occurredAt: at, payload: message },
        { id: yield* event(), type: "turn-item.updated", threadId: input.threadId, occurredAt: at, payload: turnItem },
      ] }).pipe(Effect.mapError(importFailure("Could not write the session message")));
    });
  /**
   * A message of Segno's in a run of its own (bridge said-echo.mjs, reply or say).
   * T3 tells the phone about a thread only when its run state changes (AgentAwarenessRelay reads
   * run.created/run.updated, never a message) and buzzes it when a run finishes, so the words come
   * with a run that is first seen running and then completed: the run opens as running, and once
   * `whileRunning` is done — the caller has the relay publish the running state — the message lands
   * in it and the run completes. The caller reads the ordinals and keeps the thread free of other runs meanwhile.
   * `opened` is that run already written by an attempt that stopped before its message (the server
   * went down during the hold): the message lands in it and it completes now.
   */
  const appendOwnRun = (input: OwnRunInput) => Effect.gen(function* () {
    const event = () => idAllocator.allocate.event({ threadId: input.threadId }).pipe(
      Effect.mapError(importFailure("Could not number Segno's message")));
    const runId = saidRunId(input.message.id);
    let run: OrchestrationV2Run;
    if (input.opened !== undefined) run = input.opened;
    else {
      const opened = yield* DateTime.now;
      run = {
        id: runId, threadId: input.threadId, ordinal: input.runOrdinal, providerInstanceId: input.providerInstanceId,
        modelSelection: input.modelSelection, providerThreadId: null, userMessageId: MessageId.make(input.message.id),
        rootNodeId: null, activeAttemptId: null, status: "running", queuePosition: null,
        requestedAt: opened, startedAt: opened, completedAt: null, checkpointId: null, contextHandoffId: null,
      };
      yield* eventSink.write({ events: [
        { id: yield* event(), type: "run.created", threadId: input.threadId, runId, providerInstanceId: input.providerInstanceId,
          occurredAt: opened, payload: run },
      ] }).pipe(Effect.mapError(importFailure("Could not open the run of Segno's message")));
      yield* input.whileRunning;
    }
    const { message, turnItem, at } = sessionMessageRecords(input.threadId, { ...input.message, runId }, input.itemOrdinal);
    const closed = yield* DateTime.now;
    yield* eventSink.write({ events: [
      { id: yield* event(), type: "message.updated", threadId: input.threadId, occurredAt: at, payload: message },
      { id: yield* event(), type: "turn-item.updated", threadId: input.threadId, occurredAt: at, payload: turnItem },
      { id: yield* event(), type: "run.updated", threadId: input.threadId, runId, providerInstanceId: input.providerInstanceId,
        occurredAt: closed, payload: { ...run, status: "completed", completedAt: closed } },
    ] }).pipe(Effect.mapError(importFailure("Could not write Segno's message")));
    return runId;
  });
  /**
   * A turn the engine runs while T3 holds no stream on the thread, as a run that shows running
   * (bridge engine-runs.mjs): what it says arrives into it as session messages, and closeRun ends
   * it. The caller reads the ordinal and checks the thread runs nothing else. Like a run T3 starts
   * (Orchestrator thread.turn.start), it brings a settled or snoozed thread back first: a thread the
   * inventory filed as settled while its session rested must not stay settled once it runs again.
   */
  const openRun = (input: OpenRunInput) => Effect.gen(function* () {
    const now = yield* DateTime.now;
    const event = () => idAllocator.allocate.event({ threadId: input.threadId }).pipe(
      Effect.mapError(importFailure("Could not number the engine's run")));
    const back: Array<OrchestrationV2DomainEvent> = [];
    let thread = input.thread;
    if (thread.settledOverride !== null) {
      thread = { ...thread, settledOverride: null, settledAt: null,
        unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now, updatedAt: now };
      back.push({ id: yield* event(), type: "thread.unsettled", threadId: input.threadId, providerInstanceId: thread.providerInstanceId,
        occurredAt: now, payload: thread });
    }
    if (thread.snoozedUntil != null) {
      thread = { ...thread, snoozedUntil: null, snoozedAt: null, updatedAt: now };
      back.push({ id: yield* event(), type: "thread.unsnoozed", threadId: input.threadId, providerInstanceId: thread.providerInstanceId,
        occurredAt: now, payload: thread });
    }
    const run: OrchestrationV2Run = {
      id: input.runId, threadId: input.threadId, ordinal: input.runOrdinal, providerInstanceId: input.providerInstanceId,
      modelSelection: input.modelSelection, providerThreadId: null, userMessageId: MessageId.make(input.runId),
      rootNodeId: null, activeAttemptId: null, status: "running", queuePosition: null,
      requestedAt: now, startedAt: now, completedAt: null, checkpointId: null, contextHandoffId: null,
    };
    yield* eventSink.write({ events: [...back, { id: yield* event(), type: "run.created", threadId: input.threadId, runId: input.runId,
      providerInstanceId: input.providerInstanceId, occurredAt: now, payload: run }] })
      .pipe(Effect.mapError(importFailure("Could not open the engine's run")));
    return run;
  });
  /** Ends a run openRun wrote: completed when the engine settled, interrupted when it stopped short. */
  const closeRun = (input: { readonly run: OrchestrationV2Run; readonly status: "completed" | "interrupted" | "failed" }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const id = yield* idAllocator.allocate.event({ threadId: input.run.threadId }).pipe(
        Effect.mapError(importFailure("Could not number the end of the engine's run")));
      yield* eventSink.write({ events: [{ id, type: "run.updated", threadId: input.run.threadId, runId: input.run.id,
        providerInstanceId: input.run.providerInstanceId, occurredAt: now,
        payload: { ...input.run, status: input.status, completedAt: now } }] })
        .pipe(Effect.mapError(importFailure("Could not end the engine's run")));
    });
  return { importPiSessionThread, cutRun, appendNotice, appendSessionMessage, appendOwnRun, openRun, closeRun };
});

export interface OpenRunInput {
  readonly threadId: ThreadId;
  /** The thread as it stands: a settled or snoozed one is brought back before the run opens. */
  readonly thread: OrchestrationV2AppThread;
  readonly runId: RunId;
  /** The thread's next free run ordinal (V2 numbers runs 1..n). */
  readonly runOrdinal: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
}

export interface OwnRunInput {
  readonly threadId: ThreadId;
  readonly message: SessionMessage;
  /** The thread's next free run ordinal (V2 numbers runs 1..n). */
  readonly runOrdinal: number;
  /** The thread's next turn-item ordinal. */
  readonly itemOrdinal: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  /** What the run waits on while it shows as running, before the message lands and it completes. */
  readonly whileRunning: Effect.Effect<void>;
  /** The run an earlier attempt opened and never completed; it is completed instead of a new one. */
  readonly opened?: OrchestrationV2Run;
}

/**
 * The thread's next turn-item ordinal, as ProjectionStoreV2.getNextTurnItemOrdinal reads it.
 * Read here because the layers that write notices and session messages do not get that store.
 */
export const nextTurnItemOrdinal = (threadId: ThreadId) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
    FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
  return (rows[0]?.ordinal ?? 0) + 1;
}).pipe(Effect.mapError(importFailure("Could not read the thread's next item")));

export interface NoticeInput {
  readonly threadId: ThreadId;
  /** Stable per notice, so writing it again replaces the same row. */
  readonly id: string;
  readonly message: string;
  readonly ordinal: number;
}

export interface CutRunInput {
  readonly run: OrchestrationV2Run;
  /** The thread's next free run ordinal (V2 numbers runs 1..n). */
  readonly nextOrdinal: number;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

export class RubatoThreadImporter extends Context.Service<RubatoThreadImporter, {
  readonly importPiSessionThread: (input: PiSessionThreadInput) => Effect.Effect<ThreadId, RubatoThreadImportError>;
  readonly cutRun: (input: CutRunInput) => Effect.Effect<RunId, RubatoThreadImportError>;
  readonly appendNotice: (input: NoticeInput) => Effect.Effect<void, RubatoThreadImportError>;
  readonly appendSessionMessage: (input: { readonly threadId: ThreadId; readonly message: SessionMessage; readonly ordinal: number }) =>
    Effect.Effect<void, RubatoThreadImportError>;
  readonly appendOwnRun: (input: OwnRunInput) => Effect.Effect<RunId, RubatoThreadImportError>;
  readonly openRun: (input: OpenRunInput) => Effect.Effect<OrchestrationV2Run, RubatoThreadImportError>;
  readonly closeRun: (input: { readonly run: OrchestrationV2Run; readonly status: "completed" | "interrupted" | "failed" }) =>
    Effect.Effect<void, RubatoThreadImportError>;
}>()("t3/provider/RubatoThreadImporter") {}

export const layer = Layer.effect(RubatoThreadImporter, make);

