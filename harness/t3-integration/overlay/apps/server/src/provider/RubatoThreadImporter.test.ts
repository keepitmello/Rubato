// A message another conversation sent into a Rubato session, as the thread stores it: valid V2
// records keyed by its own id (a replay replaces them), authored the way upstream marks a
// message another agent sent, with the sender context and the sending thread when known.
import {
  EventId, ProjectId, type OrchestrationV2AppThread, OrchestrationMessageContext, OrchestrationV2ConversationMessage, OrchestrationV2Run, OrchestrationV2TurnItem,
  ProviderInstanceId, RunId, ThreadId, type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { ENGINE_RUN_PREFIX, RubatoThreadImporter, SAID_RUN_PREFIX, isRubatoRun, isSaidRun, layer as importerLayer, saidRunId, sessionMessageRecords } from "./RubatoThreadImporter.ts";
import { engineRunning } from "./RubatoPiInventory.ts";
import { gapsFromProviderEvents } from "./RubatoPiSessions.ts";

const context = { version: 1 as const, records: [{
  version: 1 as const, contextId: "rubato-session", kind: "rubato-session", label: "Planner",
  payload: { v: 1, kind: "message", messageId: "m1", from: { sessionId: "sender-session", title: "Planner" } },
}] };

describe("session message records", () => {
  it("decode as V2 records and carry the sender", () => {
    const threadId = ThreadId.make("receiving-thread");
    const { message, turnItem } = sessionMessageRecords(threadId, { role: "session", id: "rubato-session:abc",
      text: "Please check the plan.", createdAt: "2026-10-17T01:02:03.000Z",
      context: context as never, senderThreadId: ThreadId.make("sending-thread") }, 7);
    const decodedMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage)(
      Schema.encodeSync(OrchestrationV2ConversationMessage)(message));
    const decodedItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)(Schema.encodeSync(OrchestrationV2TurnItem)(turnItem));
    expect(decodedMessage).toMatchObject({ id: "rubato-session:abc", role: "user", createdBy: "agent",
      creationSource: "provider", senderThreadId: "sending-thread", runId: null, text: "Please check the plan." });
    expect(decodedMessage.context?.records[0]?.label).toBe("Planner");
    expect(decodedItem).toMatchObject({ id: "rubato-session:abc", type: "user_message", messageId: "rubato-session:abc",
      ordinal: 7, runId: null, createdBy: "agent", senderThreadId: "sending-thread" });
  });
  it("write a message Segno sent on Telegram from a hidden run as Segno's own words", () => {
    const threadId = ThreadId.make("segno-thread");
    const echo = { version: 1 as const, records: [{ version: 1 as const, contextId: "rubato-telegram", kind: "rubato-telegram",
      label: "Telegram", payload: { v: 1, toolCallId: "c1" } }] };
    // The live path decodes the context before it gets here (RubatoPiSessions.ts appendSessionMessage).
    expect(Schema.decodeUnknownSync(OrchestrationMessageContext)(echo).records[0]?.kind).toBe("rubato-telegram");
    const { message, turnItem } = sessionMessageRecords(threadId, { role: "session", id: "rubato-session:tg",
      text: "밥은 먹었어?", createdAt: "2026-10-20T03:00:00.000Z", context: echo as never }, 9);
    const decodedMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage)(
      Schema.encodeSync(OrchestrationV2ConversationMessage)(message));
    const decodedItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)(Schema.encodeSync(OrchestrationV2TurnItem)(turnItem));
    expect(decodedMessage).toMatchObject({ id: "rubato-session:tg", role: "assistant", createdBy: "agent", text: "밥은 먹었어?" });
    expect(decodedMessage.context).toBeUndefined();
    expect(decodedItem).toMatchObject({ id: "rubato-session:tg", type: "assistant_message", messageId: "rubato-session:tg", ordinal: 9 });
  });
  it("write a turn the engine ran while the thread had no stream in the role it had in the session", () => {
    const threadId = ThreadId.make("lead-thread");
    const record = (role: string) => ({ version: 1 as const, records: [{ version: 1 as const, contextId: "rubato-backfill",
      kind: "rubato-backfill", label: role, payload: { v: 1, role } }] });
    for (const role of ["assistant", "user"] as const) {
      const { message, turnItem } = sessionMessageRecords(threadId, { role: "session", id: `rubato-session:bf-${role}`,
        text: "본 브랜치에 올라갔어.", createdAt: "2026-10-20T13:12:34.000Z", context: record(role) as never }, 12);
      const decodedMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage)(
        Schema.encodeSync(OrchestrationV2ConversationMessage)(message));
      const decodedItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)(Schema.encodeSync(OrchestrationV2TurnItem)(turnItem));
      expect(decodedMessage).toMatchObject({ role, createdBy: role === "user" ? "user" : "agent", text: "본 브랜치에 올라갔어." });
      expect(decodedMessage.context).toBeUndefined();
      expect(decodedItem).toMatchObject({ type: role === "user" ? "user_message" : "assistant_message", ordinal: 12 });
    }
  });
  it("place a backfilled message in the run it followed, so T3 orders it there", () => {
    const record = { version: 1 as const, records: [{ version: 1 as const, contextId: "rubato-backfill", kind: "rubato-backfill",
      label: "assistant", payload: { v: 1, role: "assistant" } }] };
    const { message, turnItem } = sessionMessageRecords(ThreadId.make("lead-thread"), { role: "session", id: "rubato-session:bf-run",
      text: "세뇨 포팅이 다 끝났어.", createdAt: "2026-10-20T13:17:17.578Z", context: record as never, runId: RunId.make("run-41") }, 3);
    expect(message.runId).toBe("run-41");
    expect(turnItem.runId).toBe("run-41");
  });
});

describe("stream gaps", () => {
  it("run from T3 stopping the provider session to it being attached or ready again, or to now", () => {
    const row = (event_type: string, occurred_at: string, status: string) => ({ event_type, occurred_at, payload_json: JSON.stringify({ status }) });
    const gaps = gapsFromProviderEvents([
      row("provider-session.updated", "2026-10-20T12:41:10.809Z", "ready"),
      row("provider-session.updated", "2026-10-20T13:11:10.864Z", "stopped"),
      row("provider-session.attached", "2026-10-20T14:42:09.147Z", "ready"),
      row("provider-session.updated", "2026-10-20T14:42:19.229Z", "running"),
      row("provider-session.updated", "2026-10-20T15:20:00.000Z", "stopped"),
    ]);
    expect(gaps).toEqual([
      { from: Date.parse("2026-10-20T13:11:10.864Z"), to: Date.parse("2026-10-20T14:42:09.147Z") },
      { from: Date.parse("2026-10-20T15:20:00.000Z"), to: Number.MAX_SAFE_INTEGER },
    ]);
  });
});

describe("Segno's own run (tell_user from a hidden run)", () => {
  const said = { version: 1 as const, records: [{ version: 1 as const, contextId: "rubato-said", kind: "rubato-said", label: "Segno",
    payload: { v: 1, toolCallId: "t1" } }] };
  const threadId = ThreadId.make("segno-thread");
  const instance = ProviderInstanceId.make("rubato-pi");
  const run = (writes: Array<{ at: number; events: ReadonlyArray<OrchestrationV2DomainEvent> }>, opened?: OrchestrationV2Run) => {
    let next = 0;
    const sink = Layer.succeed(EventSink.EventSinkV2, { write: ({ events }: { events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
      Effect.map(Clock.currentTimeMillis, (at) => { writes.push({ at, events }); return []; }) } as never);
    const ids = Layer.succeed(IdAllocator.IdAllocatorV2, { allocate: { event: () => Effect.succeed(EventId.make(`e${next++}`)) } } as never);
    return Effect.runPromise(Effect.gen(function* () {
      const importer = yield* RubatoThreadImporter;
      return yield* importer.appendOwnRun({ threadId, runOrdinal: 4, itemOrdinal: 11, providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "claude" }, whileRunning: Effect.sleep("40 millis"),
        message: { role: "session", id: "rubato-session:said", text: "좋은 아침! 3시에 회의 있어.", createdAt: "2026-10-21T00:00:00.000Z",
          context: said as never }, ...(opened === undefined ? {} : { opened }) });
    }).pipe(Effect.provide(importerLayer.pipe(Layer.provide(Layer.mergeAll(sink, ids))))));
  };

  it("opens as running, and after the hold writes Segno's words in it and completes it", async () => {
    const writes: Array<{ at: number; events: ReadonlyArray<OrchestrationV2DomainEvent> }> = [];
    const runId = await run(writes);
    expect(runId).toBe(`${SAID_RUN_PREFIX}rubato-session:said`);
    expect(isSaidRun(runId)).toBe(true);
    expect(writes.map((write) => write.events.map((event) => event.type))).toEqual([
      ["run.created"], ["message.updated", "turn-item.updated", "run.updated"]]);
    expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(35);
    const opened = writes[0]!.events[0]!.payload as OrchestrationV2Run;
    const decodedOpen = Schema.decodeUnknownSync(OrchestrationV2Run)(Schema.encodeSync(OrchestrationV2Run)(opened));
    expect(decodedOpen).toMatchObject({ id: runId, status: "running", ordinal: 4, userMessageId: "rubato-session:said",
      providerThreadId: null, checkpointId: null, completedAt: null });
    const [message, item, closed] = writes[1]!.events.map((event) => event.payload);
    expect(Schema.decodeUnknownSync(OrchestrationV2ConversationMessage)(Schema.encodeSync(OrchestrationV2ConversationMessage)(message as never)))
      .toMatchObject({ id: "rubato-session:said", role: "assistant", runId, text: "좋은 아침! 3시에 회의 있어." });
    expect(item).toMatchObject({ id: "rubato-session:said", type: "assistant_message", runId, ordinal: 11 });
    expect(Schema.decodeUnknownSync(OrchestrationV2Run)(Schema.encodeSync(OrchestrationV2Run)(closed as never)))
      .toMatchObject({ id: runId, status: "completed", ordinal: 4 });
  });

  it("completes a run an earlier attempt opened and never finished, without opening another", async () => {
    const first: Array<{ at: number; events: ReadonlyArray<OrchestrationV2DomainEvent> }> = [];
    await run(first);
    const opened = first[0]!.events[0]!.payload as OrchestrationV2Run;
    const writes: Array<{ at: number; events: ReadonlyArray<OrchestrationV2DomainEvent> }> = [];
    await run(writes, { ...opened, ordinal: 7 });
    expect(writes.map((write) => write.events.map((event) => event.type))).toEqual([["message.updated", "turn-item.updated", "run.updated"]]);
    expect(writes[0]!.events[2]!.payload).toMatchObject({ id: saidRunId("rubato-session:said"), status: "completed", ordinal: 7 });
  });
});

describe("a turn the engine runs while T3 holds no stream (bridge engine-runs.mjs)", () => {
  const threadId = ThreadId.make("lead-thread");
  const instance = ProviderInstanceId.make("rubato-pi");
  const at = DateTime.makeUnsafe("2026-10-20T16:00:29.852Z");
  const appThread = (overrides: Partial<OrchestrationV2AppThread>): OrchestrationV2AppThread => ({
    createdBy: "system", creationSource: "server", id: threadId, projectId: ProjectId.make("hash-game"), title: "lead",
    providerInstanceId: instance, modelSelection: { instanceId: instance, model: "claude" }, runtimeMode: "full-access",
    interactionMode: "default", branch: null, worktreePath: null, linkedPullRequest: null, branchPullRequest: null,
    activeProviderThreadId: null, historyOrigin: "v1_import", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, unsettledAt: null,
    snoozedUntil: null, snoozedAt: null, pinnedAt: null, pinOrderKey: null, activeOrderKey: null, lastVisitedAt: null, deletedAt: null,
    ...overrides,
  } as OrchestrationV2AppThread);
  const openOn = async (thread: OrchestrationV2AppThread) => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let next = 0;
    const sink = Layer.succeed(EventSink.EventSinkV2, { write: ({ events }: { events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
      Effect.sync(() => { writes.push(events); return []; }) } as never);
    const ids = Layer.succeed(IdAllocator.IdAllocatorV2, { allocate: { event: () => Effect.succeed(EventId.make(`e${next++}`)) } } as never);
    await Effect.runPromise(Effect.gen(function* () {
      const importer = yield* RubatoThreadImporter;
      yield* importer.openRun({ threadId, runId: RunId.make(`${ENGINE_RUN_PREFIX}s:1`), runOrdinal: 2, providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "claude" }, thread });
    }).pipe(Effect.provide(importerLayer.pipe(Layer.provide(Layer.mergeAll(sink, ids))))));
    return writes;
  };
  it("brings a thread the inventory filed as settled (or one snoozed) back before its run opens, as a T3 run would", async () => {
    const writes = await openOn(appThread({ settledOverride: "settled", settledAt: at, snoozedUntil: DateTime.makeUnsafe("2026-10-21T00:00:00Z"), snoozedAt: at }));
    expect(writes.map((events) => events.map((event) => event.type))).toEqual([["thread.unsettled", "thread.unsnoozed", "run.created"]]);
    expect(writes[0]![0]!.payload).toMatchObject({ settledOverride: null, settledAt: null });
    expect(writes[0]![1]!.payload).toMatchObject({ settledOverride: null, snoozedUntil: null });
    expect((await openOn(appThread({}))).map((events) => events.map((event) => event.type))).toEqual([["run.created"]]);
  });
  it("opens as running and ends as completed, as a run T3 does not rewind", async () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let next = 0;
    const sink = Layer.succeed(EventSink.EventSinkV2, { write: ({ events }: { events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
      Effect.sync(() => { writes.push(events); return []; }) } as never);
    const ids = Layer.succeed(IdAllocator.IdAllocatorV2, { allocate: { event: () => Effect.succeed(EventId.make(`e${next++}`)) } } as never);
    const runId = RunId.make(`${ENGINE_RUN_PREFIX}01a15a0a:1760976028137`);
    await Effect.runPromise(Effect.gen(function* () {
      const importer = yield* RubatoThreadImporter;
      const run = yield* importer.openRun({ threadId, runId, runOrdinal: 1, providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "claude" }, thread: appThread({ settledOverride: null }) });
      yield* importer.closeRun({ run, status: "completed" });
    }).pipe(Effect.provide(importerLayer.pipe(Layer.provide(Layer.mergeAll(sink, ids))))));
    expect(writes.map((events) => events.map((event) => event.type))).toEqual([["run.created"], ["run.updated"]]);
    const opened = Schema.decodeUnknownSync(OrchestrationV2Run)(Schema.encodeSync(OrchestrationV2Run)(writes[0]![0]!.payload as never));
    expect(opened).toMatchObject({ id: runId, status: "running", ordinal: 1, providerThreadId: null, checkpointId: null });
    expect(writes[1]![0]!.payload).toMatchObject({ id: runId, status: "completed" });
    expect(isRubatoRun(runId)).toBe(true);
    expect(isSaidRun(runId)).toBe(false);
  });
  it("counts a session as running from the engine's own list status", () => {
    expect(engineRunning({ status: "running" })).toBe(true);
    expect(engineRunning({ status: "starting" })).toBe(true);
    for (const status of ["stored", "idle", "unloading"]) expect(engineRunning({ status })).toBe(false);
  });
});
