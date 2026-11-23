import {
  MessageId, RuntimeRequestId, RunId, ThreadId, TurnItemId,
  type OrchestrationV2ProjectedTurnItem, type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { buildThreadFeed } from "../../lib/threadActivity";
import { feedRoomPreview } from "./roomModel";
import { listPreview } from "./listPreview";

const threadId = ThreadId.make("room");
const runId = RunId.make("r");
function base(id: string, time: number) {
  const at = DateTime.makeUnsafe(time);
  return {
    id: TurnItemId.make(id), threadId, runId, nodeId: null, providerThreadId: null,
    providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: time,
    status: "completed" as const, title: null, startedAt: at, completedAt: at, updatedAt: at,
  };
}
function user(id: string, time: number, text: string) {
  return { ...base(id, time), type: "user_message", messageId: MessageId.make(id),
    text, attachments: [], createdBy: "user", creationSource: "mobile", inputIntent: "turn_start",
  } as const;
}
const project = (item: OrchestrationV2TurnItem, position: number): OrchestrationV2ProjectedTurnItem =>
  ({ visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item, position });

it("agrees with the full feed through streaming, ties, reordering, queueing, folded questions and rewind", () => {
  const requestId = RuntimeRequestId.make("q");
  const sequence: OrchestrationV2TurnItem[] = [
    user("u", 1, "Hi"),
    { ...base("a", 3), type: "assistant_message", messageId: MessageId.make("a"), text: "A\n\nB", streaming: true },
    user("file", 3, "[log](</tmp/log>)"), user("late", 2, "Older"),
    user("blank", 4, " "),
    { ...user("queued", 5, "Not sent"), status: "pending", inputIntent: "queued_turn" },
    user(`async-answer:${requestId}`, 6, "Blue"),
    { ...base("question", 2), type: "user_input_request", requestId, questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} } },
  ];
  for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 8, 2]) {
    const rows = sequence.slice(0, len).map(project);
    expect(listPreview(rows)).toEqual(feedRoomPreview(buildThreadFeed(rows)));
  }
});

it("does not read old message bodies to preview the newest of 2,000 messages", () => {
  let oldTextReads = 0;
  const rows = Array.from({ length: 2_000 }, (_, at) => project({
    ...user(String(at), at, ""),
    get text() { if (at !== 1_999) oldTextReads++; return `line ${at}`; },
  }, at));
  expect(listPreview(rows)?.text).toBe("line 1999");
  expect(oldTextReads).toBe(0);
});
