import { describe, expect, it } from "vite-plus/test";

import { messageRewindTarget, type MessageRewindRecords } from "./RubatoMessageRewind.ts";

type Run = MessageRewindRecords["runs"][number];
type Checkpoint = MessageRewindRecords["checkpoints"][number];

const runId = (ordinal: number) => `run-${ordinal}` as Run["id"];
const promptId = (ordinal: number) => `prompt-${ordinal}` as Run["userMessageId"];
const run = (ordinal: number, status: Run["status"] = "completed"): Run => ({
  id: runId(ordinal),
  ordinal,
  status,
  userMessageId: promptId(ordinal),
});
const checkpoint = (ordinal: number, status: Checkpoint["status"] = "ready"): Checkpoint => ({
  id: `checkpoint-${ordinal}` as Checkpoint["id"],
  scopeId: "scope" as Checkpoint["scopeId"],
  runId: runId(ordinal),
  appRunOrdinal: ordinal,
  ordinalWithinScope: ordinal,
  status,
});
// What a later capture fills a gap with: the workspace at that ordinal, tied to no run.
const baseline = (ordinal: number): Checkpoint => ({
  id: `baseline-${ordinal}` as Checkpoint["id"],
  scopeId: "scope" as Checkpoint["scopeId"],
  runId: null,
  appRunOrdinal: null,
  ordinalWithinScope: ordinal,
  status: "ready",
});

function records(runs: Run[], checkpoints: Checkpoint[]): MessageRewindRecords {
  return {
    runs,
    checkpoints,
    messages: runs.map((entry) => ({ id: entry.userMessageId, role: "user", runId: entry.id })),
  };
}

describe("where editing a message rewinds to", () => {
  it("goes back to the turn before the message", () => {
    const thread = records([run(1), run(2)], [baseline(0), checkpoint(1), checkpoint(2)]);
    expect(messageRewindTarget(thread, promptId(2))).toEqual({
      turnCount: 1,
      checkpointId: "checkpoint-1",
      scopeId: "scope",
    });
    expect(messageRewindTarget(thread, promptId(1))).toMatchObject({
      turnCount: 0,
      checkpointId: "baseline-0",
    });
  });

  it("skips the turn a queued message left when it was sent as a steer", () => {
    // The reported failure: turn 24 was queued, its message joined turn 23, and turn 24
    // was cancelled before it started. Editing turn 25 asked for turn 24's checkpoint.
    const thread = records(
      [run(23), run(24, "cancelled"), run(25)],
      [baseline(0), checkpoint(23), baseline(24), checkpoint(25)],
    );
    expect(messageRewindTarget(thread, promptId(25))).toMatchObject({
      turnCount: 23,
      checkpointId: "checkpoint-23",
    });
  });

  it("skips failed turns, and a failed turn's own message rewinds too", () => {
    const thread = records(
      [run(1), run(2, "failed"), run(3, "failed")],
      [baseline(0), checkpoint(1)],
    );
    expect(messageRewindTarget(thread, promptId(3))).toMatchObject({ turnCount: 1 });
    expect(messageRewindTarget(thread, promptId(2))).toMatchObject({ turnCount: 1 });
  });

  it("goes back to a stopped turn, which keeps its checkpoint", () => {
    const thread = records(
      [run(1), run(2, "interrupted"), run(3)],
      [baseline(0), checkpoint(1), checkpoint(2), checkpoint(3)],
    );
    expect(messageRewindTarget(thread, promptId(3))).toMatchObject({ turnCount: 2 });
  });

  it("ignores turns an earlier rewind already removed", () => {
    const thread = records(
      [run(1), run(2, "rolled_back"), run(3)],
      [baseline(0), checkpoint(1), checkpoint(2, "stale"), checkpoint(3)],
    );
    expect(messageRewindTarget(thread, promptId(3))).toMatchObject({ turnCount: 1 });
  });

  it("refuses rather than drop a finished turn that has no checkpoint", () => {
    const thread = records([run(1), run(2), run(3)], [baseline(0), checkpoint(1), checkpoint(3)]);
    expect(messageRewindTarget(thread, promptId(3))).toEqual({
      refused: {
        code: "no-checkpoint",
        message: "Turn 2 before this message has no checkpoint to rewind to.",
      },
    });
  });

  it("refuses while a turn is still going or saving its checkpoint", () => {
    for (const status of ["running", "queued", "waiting"] as const) {
      const thread = records([run(1), run(2), run(3, status)], [baseline(0), checkpoint(1)]);
      expect(messageRewindTarget(thread, promptId(2))).toMatchObject({
        refused: { code: "busy" },
      });
    }
  });

  it("refuses a steer, which joined a turn another message started", () => {
    const thread = records([run(1)], [baseline(0), checkpoint(1)]);
    const steered = {
      ...thread,
      messages: [...thread.messages, { id: "steer" as Run["userMessageId"], role: "user" as const, runId: runId(1) }],
    };
    expect(messageRewindTarget(steered, "steer")).toMatchObject({ refused: { code: "not-a-turn" } });
  });

  it("refuses when the thread start was never captured", () => {
    const thread = records([run(1, "failed")], []);
    expect(messageRewindTarget(thread, promptId(1))).toMatchObject({
      refused: { code: "no-checkpoint" },
    });
  });
});
