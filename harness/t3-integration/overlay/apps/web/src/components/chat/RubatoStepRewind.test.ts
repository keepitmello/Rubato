import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDropped,
  lastStepCutFor,
  replyCutFor,
  type StepCut,
  stepRewindDrops,
} from "./RubatoStepRewind";

const cut: StepCut = {
  kind: "step",
  turnId: TurnId.make("turn-2"),
  anchorId: "pi-tool:s:b",
  toolCallId: "pi-tool:s:b",
  after: "2026-09-04T00:00:05.000Z",
  turnCount: 2,
  label: "bun test",
};
const at = (second: number) => `2026-09-04T00:00:${String(second).padStart(2, "0")}.000Z`;

describe("stepRewindDrops", () => {
  const removed = new Set(["turn-3"]);
  it("drops the step's turn after the step, later turns, and a message steered in after it", () => {
    expect(stepRewindDrops(cut, removed, { turnId: "turn-2", createdAt: at(4) })).toBe(false);
    expect(stepRewindDrops(cut, removed, { turnId: "turn-2", createdAt: at(5) })).toBe(false);
    expect(stepRewindDrops(cut, removed, { turnId: "turn-2", createdAt: at(6) })).toBe(true);
    expect(stepRewindDrops(cut, removed, { turnId: "turn-3", createdAt: at(1) })).toBe(true);
    expect(stepRewindDrops(cut, removed, { turnId: null, createdAt: at(7), role: "user" })).toBe(
      true,
    );
  });

  it("keeps notices that belong to no turn", () => {
    expect(stepRewindDrops(cut, removed, { turnId: null, createdAt: at(9), role: "system" })).toBe(
      false,
    );
  });
});

describe("describeDropped", () => {
  it("names what goes", () => {
    expect(describeDropped({ steps: 2, replies: 1, messages: 0, files: ["a.ts"] })).toBe(
      "2 steps, 1 reply",
    );
    expect(describeDropped({ steps: 0, replies: 0, messages: 0, files: [] })).toBe(
      "Nothing after this step",
    );
  });
});

// A thread as the rewind reads it: its checkpoints, messages and tool rows.
const thread = (input: {
  checkpoints: Array<{ turnId: string; checkpointTurnCount: number }>;
  messages?: Array<{ id: string; role: string; turnId: string | null; createdAt: string }>;
  activities?: Array<{
    id: string;
    kind: string;
    turnId: string | null;
    createdAt: string;
    payload: unknown;
    summary?: string;
  }>;
}) =>
  ({
    checkpoints: input.checkpoints,
    messages: input.messages ?? [],
    activities: (input.activities ?? []).map((activity) => ({
      tone: "tool",
      summary: "tool",
      ...activity,
    })),
  }) as unknown as Parameters<typeof lastStepCutFor>[0];
const tool = (
  call: string,
  turnId: string,
  second: number,
  step: string,
  kind = "tool.completed",
) => ({
  id: `${call}-${kind}`,
  kind,
  turnId,
  createdAt: at(second),
  payload: { toolCallId: `pi-tool:s:${call}`, title: `run ${call}`, data: { rubatoStep: step } },
});

describe("lastStepCutFor", () => {
  const detail = thread({
    checkpoints: [
      { turnId: "turn-1", checkpointTurnCount: 1 },
      { turnId: "turn-2", checkpointTurnCount: 2 },
    ],
    activities: [
      tool("a", "turn-1", 1, "s1"),
      tool("b", "turn-1", 3, "s2"),
      tool("c", "turn-1", 4, "s2"),
      tool("z", "turn-2", 9, "s9"),
    ],
  });

  it("lands after the turn's last finished step when the row names no calls", () => {
    const cut = lastStepCutFor(detail, { turnId: TurnId.make("turn-1") });
    expect(cut).toMatchObject({
      kind: "step",
      toolCallId: "pi-tool:s:c",
      after: at(4),
      turnCount: 1,
      label: "run c",
    });
  });

  it("lands after the last of the calls a tool group shows", () => {
    const cut = lastStepCutFor(detail, {
      turnId: TurnId.make("turn-1"),
      toolCallIds: ["pi-tool:s:a"],
    });
    expect(cut).toMatchObject({ toolCallId: "pi-tool:s:a", after: at(1) });
  });

  it("says why when the turn has no finished step", () => {
    expect(lastStepCutFor(detail, { turnId: TurnId.make("turn-3") })).toMatch(/no finished step/);
  });
});

describe("replyCutFor", () => {
  const detail = thread({
    checkpoints: [
      { turnId: "turn-1", checkpointTurnCount: 1 },
      { turnId: "turn-2", checkpointTurnCount: 2 },
    ],
    messages: [
      { id: "ask", role: "user", turnId: null, createdAt: at(0) },
      { id: "reply-1", role: "assistant", turnId: "turn-1", createdAt: at(2) },
      { id: "reply-2", role: "assistant", turnId: "turn-2", createdAt: at(8) },
    ],
    activities: [tool("a", "turn-1", 3, "s1")],
  });

  it("keeps the reply's whole turn and drops the turns after it", () => {
    const cut = replyCutFor(detail, { turnId: TurnId.make("turn-1"), messageId: "reply-1" });
    expect(cut).toMatchObject({ kind: "turn", anchorId: "reply-1", turnCount: 1, after: at(3) });
  });

  it("offers nothing after the last reply", () => {
    expect(replyCutFor(detail, { turnId: TurnId.make("turn-2"), messageId: "reply-2" })).toMatch(
      /Nothing comes after/,
    );
  });
});
