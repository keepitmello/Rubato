// A message another conversation sent into a Rubato session, as the thread stores it: valid V2
// records keyed by its own id (a replay replaces them), authored the way upstream marks a
// message another agent sent, with the sender context and the sending thread when known.
import { OrchestrationMessageContext, OrchestrationV2ConversationMessage, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { sessionMessageRecords } from "./RubatoThreadImporter.ts";

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
});
