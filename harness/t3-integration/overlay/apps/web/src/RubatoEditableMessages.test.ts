import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRevertTurnCountByUserMessageId, type TimelineEntry } from "./session-logic";
import type { ChatMessage, TurnDiffSummary } from "./types";

// Which of my messages offer the edit pencil (rewind-edits.mjs). Where the edit lands is the
// server's answer (RubatoMessageRewind.ts); the timeline only decides that it is offered.

const run = (ordinal: number) => RunId.make(`run-${ordinal}`);

function message(id: string, ordinal: number, role: ChatMessage["role"]): TimelineEntry {
  const createdAt = new Date(Date.UTC(2026, 9, 17, 0, 0, ordinal)).toISOString();
  const chatMessage: ChatMessage = {
    id: MessageId.make(id),
    role,
    text: id,
    runId: run(ordinal),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...(role === "user" ? { inputIntent: "turn_start" as const } : {}),
  };
  return { id, kind: "message", createdAt, message: chatMessage };
}
const prompt = (ordinal: number) => message(`prompt-${ordinal}`, ordinal, "user");
const reply = (ordinal: number) => message(`reply-${ordinal}`, ordinal, "assistant");

function checkpoint(ordinal: number): TurnDiffSummary {
  return {
    runId: run(ordinal),
    checkpointTurnCount: ordinal,
    checkpointRef: `checkpoint-${ordinal}` as never,
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: new Date(Date.UTC(2026, 9, 17, 0, 1, ordinal)).toISOString(),
  };
}

describe("which messages offer an edit", () => {
  it("offers it on a failed run's message, which T3 left without one", () => {
    const offered = deriveRevertTurnCountByUserMessageId({
      timelineEntries: [prompt(1), reply(1), reply(2), prompt(3)],
      checkpoints: [checkpoint(1), checkpoint(2)],
      failedRunIds: new Set([run(3)]),
    });
    expect(offered.get(MessageId.make("prompt-1"))).toBe(0);
    expect(offered.get(MessageId.make("prompt-3"))).toBe(2);
  });

  it("offers none on a failed first message, before anything was captured", () => {
    const offered = deriveRevertTurnCountByUserMessageId({
      timelineEntries: [prompt(1)],
      checkpoints: [],
      failedRunIds: new Set([run(1)]),
    });
    expect(offered.has(MessageId.make("prompt-1"))).toBe(false);
  });

  it("offers none on a run that neither captured nor failed: queued or still running", () => {
    const offered = deriveRevertTurnCountByUserMessageId({
      timelineEntries: [prompt(1), reply(1), prompt(2)],
      checkpoints: [checkpoint(1)],
    });
    expect(offered.has(MessageId.make("prompt-2"))).toBe(false);
  });
});
