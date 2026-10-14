import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDropped, type StepCut, stepRewindDrops } from "./RubatoStepRewind";

const cut: StepCut = {
  turnId: TurnId.make("turn-2"),
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
