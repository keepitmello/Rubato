import { describe, expect, it } from "vite-plus/test";

import {
  describeDropped,
  isStepCutRun,
  lastStepCutFor,
  replyCutFor,
  type RewindThread,
  stepCutFor,
  stepRewindSummary,
} from "./RubatoStepRewind";

const AT = new Date("2026-10-16T10:00:00.000Z");
let position = 0;
const item = (id: string, runId: string, type: string, extra: Record<string, unknown> = {}) =>
  ({
    position: position++,
    visibility: "local",
    sourceThreadId: "t",
    sourceItemId: id,
    item: {
      id,
      threadId: "t",
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: type === "user_message" || type === "assistant_message" || type === "reasoning"
        ? null
        : { driver: "rubato-pi", nativeId: `call-${id}`, strength: "strong" },
      parentItemId: null,
      ordinal: position,
      status: "completed",
      title: id,
      startedAt: AT,
      completedAt: AT,
      updatedAt: AT,
      type,
      ...extra,
    },
  }) as never;

// Run 1: user, thought, two calls made together (a, b), a thought, call c, reply.
// Run 2: user, reply.
const thread: RewindThread = {
  items: [
    item("u1", "r1", "user_message", { messageId: "m-u1" }),
    item("th1", "r1", "reasoning"),
    item("a", "r1", "command_execution"),
    item("b", "r1", "dynamic_tool"),
    item("th2", "r1", "reasoning"),
    item("c", "r1", "file_change"),
    item("rep1", "r1", "assistant_message", { messageId: "m-rep1" }),
    item("u2", "r2", "user_message", { messageId: "m-u2" }),
    item("rep2", "r2", "assistant_message", { messageId: "m-rep2" }),
  ],
  runs: [
    { id: "r1", ordinal: 1, status: "completed" },
    { id: "r2", ordinal: 2, status: "completed" },
  ],
  checkpoints: [
    { runId: "r1", appRunOrdinal: 1, status: "ready" },
    { runId: "r2", appRunOrdinal: 2, status: "ready" },
  ],
};

const dropped = (cut: ReturnType<typeof stepCutFor>) =>
  typeof cut === "string" ? cut : [...cut.droppedItemIds].toSorted();

describe("step rewind on V2 rows", () => {
  it("keeps a step's whole batch: calls made together rewind together", () => {
    // Rewinding to `a` keeps `b`, called in the same model message.
    expect(dropped(stepCutFor(thread, "a", "bun test"))).toEqual(["c", "rep1", "rep2", "th2", "u2"]);
    expect(dropped(stepCutFor(thread, "b", "read"))).toEqual(["c", "rep1", "rep2", "th2", "u2"]);
  });

  it("drops what follows the step in its run and every later run, messages included", () => {
    const cut = stepCutFor(thread, "c", "edit");
    expect(dropped(cut)).toEqual(["rep1", "rep2", "u2"]);
    if (typeof cut === "string") throw new Error(cut);
    expect([...cut.droppedMessageIds].toSorted()).toEqual(["m-rep1", "m-rep2", "m-u2"]);
    expect(describeDropped(stepRewindSummary(thread, cut))).toBe("1 message, 2 replies");
  });

  it("a folded run rewinds after its last step", () => {
    const cut = lastStepCutFor(thread, { runId: "r1" });
    expect(typeof cut !== "string" && cut.itemId).toBe("c");
  });

  it("a reply rewinds to the run boundary through T3's revert", () => {
    const cut = replyCutFor(thread, { runId: "r1", messageId: "m-rep1" });
    if (typeof cut === "string") throw new Error(cut);
    expect([cut.kind, cut.turnCount]).toEqual(["turn", 1]);
    expect([...cut.droppedItemIds].toSorted()).toEqual(["rep2", "u2"]);
    expect(replyCutFor(thread, { runId: "r2", messageId: "m-rep2" })).toBe("Nothing comes after this reply.");
  });

  it("refuses a step that is not a finished Rubato step, or a run still working", () => {
    expect(stepCutFor(thread, "rep1", "x")).toBe("Only a finished Rubato step can be rewound to.");
    const running = { ...thread, runs: [{ id: "r1", ordinal: 1, status: "running" }, thread.runs[1]!] };
    expect(stepCutFor(running, "a", "x")).toBe("This run has not finished yet.");
  });

  it("knows a run a step rewind cut, so upstream's Resume can step aside", () => {
    const runs = [
      { id: "r1", ordinal: 1, status: "interrupted" },
      { id: "r1:rubato-step-cut:1", ordinal: 2, status: "rolled_back" },
    ];
    expect(isStepCutRun(runs, "r1")).toBe(true);
    expect(isStepCutRun([runs[0]!], "r1")).toBe(false);
  });
});
