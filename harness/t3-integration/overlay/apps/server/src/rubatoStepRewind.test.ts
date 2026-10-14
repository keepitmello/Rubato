import { EventId, type OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { revertCutFor, stepCheckpointRef } from "./rubatoStepRewind.ts";

const turn = TurnId.make("turn-1");
const at = (second: number) => `2026-09-03T00:00:${String(second).padStart(2, "0")}.000Z`;
const tool = (
  call: string,
  kind: "tool.updated" | "tool.completed",
  second: number,
  step?: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(`${call}-${kind}-${second}`),
  tone: "tool",
  kind,
  summary: call,
  payload: {
    itemType: "dynamic_tool_call",
    toolCallId: call,
    data: step ? { rubatoStep: step } : {},
  },
  turnId: turn,
  createdAt: at(second),
});
const checkpoints = [{ turnId: "turn-1", checkpointTurnCount: 2 }];

describe("revertCutFor", () => {
  const activities = [
    tool("read", "tool.updated", 1, "s1"),
    tool("read", "tool.completed", 2, "s1"),
    tool("grep", "tool.updated", 3, "s2"),
    tool("ls", "tool.updated", 3, "s2"),
    tool("ls", "tool.completed", 4, "s2"),
    tool("grep", "tool.completed", 5, "s2"),
    tool("edit", "tool.completed", 7, "s3"),
  ];

  it("cuts after the whole batch the picked call was made in", () => {
    const resolved = revertCutFor({
      step: { turnId: turn, toolCallId: "ls" },
      turnCount: 2,
      checkpoints,
      activities,
    });
    expect(resolved).toEqual({
      cut: { turnId: turn, toolCallId: "ls", after: at(5) },
      snapshotCall: "grep",
      calls: ["grep", "ls"],
    });
  });

  it("refuses a step that has not finished or is not in the kept turn", () => {
    const running = [...activities, tool("bash", "tool.updated", 8, "s4")];
    expect(
      revertCutFor({
        step: { turnId: turn, toolCallId: "bash" },
        turnCount: 2,
        checkpoints,
        activities: running,
      }),
    ).toMatch(/not finished/);
    expect(
      revertCutFor({
        step: { turnId: turn, toolCallId: "read" },
        turnCount: 1,
        checkpoints,
        activities,
      }),
    ).toMatch(/not in the turn/);
  });

  it("treats a row without a batch tag as its own step", () => {
    const untagged = [tool("old", "tool.completed", 9)];
    expect(
      revertCutFor({
        step: { turnId: turn, toolCallId: "old" },
        turnCount: 2,
        checkpoints,
        activities: untagged,
      }),
    ).toEqual({
      cut: { turnId: turn, toolCallId: "old", after: at(9) },
      snapshotCall: "old",
      calls: ["old"],
    });
  });
});

describe("stepCheckpointRef", () => {
  it("keeps step snapshots beside the thread's turn checkpoints", () => {
    expect(stepCheckpointRef(ThreadId.make("thread-1"), "pi-tool:s:call_1")).toMatch(
      /^refs\/t3\/checkpoints\/[A-Za-z0-9_-]+\/step\/[A-Za-z0-9_-]+$/,
    );
  });
});
