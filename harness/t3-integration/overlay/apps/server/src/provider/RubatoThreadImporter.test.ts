// A message another conversation sent into a Rubato session, as the thread stores it: valid V2
// records keyed by its own id (a replay replaces them), authored the way upstream marks a
// message another agent sent, with the sender context and the sending thread when known.
import {
  EventId, OrchestrationMessageContext, OrchestrationV2ConversationMessage, OrchestrationV2Run, OrchestrationV2TurnItem,
  ProviderInstanceId, RunId, ThreadId, type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { RubatoThreadImporter, SAID_RUN_PREFIX, isSaidRun, layer as importerLayer, saidRunId, sessionMessageRecords } from "./RubatoThreadImporter.ts";
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
        modelSelection: { instanceId: instance, model: "claude" }, hold: "40 millis",
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
