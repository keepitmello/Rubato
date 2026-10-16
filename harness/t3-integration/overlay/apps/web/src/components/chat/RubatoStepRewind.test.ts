import { describe, expect, it } from "vite-plus/test";

import {
  describeDropped,
  isStepCutRun,
  lastStepOf,
  replyCutFor,
  rewindOffered,
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
    // The server answers that `a`'s batch ends at `b`, called in the same model message.
    expect(dropped(stepCutFor(thread, "a", "bun test", "b"))).toEqual(["c", "rep1", "rep2", "th2", "u2"]);
    expect(dropped(stepCutFor(thread, "b", "read", "b"))).toEqual(["c", "rep1", "rep2", "th2", "u2"]);
  });

  it("cuts where the server says the batch ends, not where tool rows stop", () => {
    // Two tool-only model messages back to back: [a2, b2], then [c2], with no row between.
    const adjacent: RewindThread = {
      ...thread,
      items: [
        item("u3", "r1", "user_message", { messageId: "m-u3" }),
        item("a2", "r1", "command_execution"),
        item("b2", "r1", "command_execution"),
        item("c2", "r1", "command_execution"),
        item("rep3", "r1", "assistant_message", { messageId: "m-rep3" }),
      ],
      runs: [thread.runs[0]!],
    };
    expect(dropped(stepCutFor(adjacent, "a2", "ls", "b2"))).toEqual(["c2", "rep3"]);
    expect(dropped(stepCutFor(adjacent, "c2", "ls", "c2"))).toEqual(["rep3"]);
  });

  it("drops what follows the step in its run and every later run, messages included", () => {
    const cut = stepCutFor(thread, "c", "edit", "c");
    expect(dropped(cut)).toEqual(["rep1", "rep2", "u2"]);
    if (typeof cut === "string") throw new Error(cut);
    expect([...cut.droppedMessageIds].toSorted()).toEqual(["m-rep1", "m-rep2", "m-u2"]);
    expect(describeDropped(stepRewindSummary(thread, cut))).toBe("1 message, 2 replies");
  });

  it("a folded run rewinds after its last step", () => {
    expect(lastStepOf(thread, { runId: "r1" })).toEqual({ itemId: "c", label: "c" });
    expect(lastStepOf(thread, { runId: "r1", itemIds: ["a", "b"] })).toEqual({ itemId: "b", label: "b" });
    expect(lastStepOf(thread, { runId: "r2" })).toBe("There is no finished step to rewind to here.");
  });

  it("a failed tool is a finished step too: its result is what the model saw", () => {
    const failed = { ...thread, items: [item("f", "r1", "command_execution", { status: "failed" })] };
    expect(dropped(stepCutFor(failed, "f", "x", "f"))).toEqual([]);
  });

  it("offers a button only where a rewind can land", () => {
    const reply = (runId: string) => ({ kind: "reply", runId, messageId: `m-rep-${runId}` }) as const;
    expect(rewindOffered(thread, reply("r1"))).toBe(true);
    // The last reply has nothing after it.
    expect(rewindOffered(thread, reply("r2"))).toBe(false);
    expect(rewindOffered(thread, { kind: "last-step", runId: "r1" })).toBe(true);
    // A run with no Rubato step, or a group of rows none of which is one.
    expect(rewindOffered(thread, { kind: "last-step", runId: "r2" })).toBe(false);
    expect(rewindOffered(thread, { kind: "last-step", runId: "r1", itemIds: ["th1", "rep1"] })).toBe(false);
    const step = thread.items[2]!.item;
    const codex = { ...step, nativeItemRef: { driver: "codex", nativeId: "x", strength: "strong" } };
    expect(rewindOffered(null, { kind: "step", itemId: "a", runId: "r1" }, codex as never)).toBe(false);
    expect(rewindOffered(null, { kind: "step", itemId: "a", runId: "r1" }, step)).toBe(true);
  });

  it("a reply rewinds to the run boundary through T3's revert", () => {
    const cut = replyCutFor(thread, { runId: "r1", messageId: "m-rep1" });
    if (typeof cut === "string") throw new Error(cut);
    expect([cut.kind, cut.turnCount]).toEqual(["turn", 1]);
    expect([...cut.droppedItemIds].toSorted()).toEqual(["rep2", "u2"]);
    expect(replyCutFor(thread, { runId: "r2", messageId: "m-rep2" })).toBe("Nothing comes after this reply.");
  });

  it("refuses a step that is not a finished Rubato step, or a run still working", () => {
    expect(stepCutFor(thread, "rep1", "x", "rep1")).toBe("Only a finished Rubato step can be rewound to.");
    const running = { ...thread, runs: [{ id: "r1", ordinal: 1, status: "running" }, thread.runs[1]!] };
    expect(stepCutFor(running, "a", "x", "b")).toBe("This run has not finished yet.");
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
