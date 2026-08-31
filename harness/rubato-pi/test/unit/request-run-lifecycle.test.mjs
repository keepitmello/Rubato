import test from "node:test";
import assert from "node:assert/strict";
import { RequestRunTracker, createInputRecord } from "../../src/transforms/request-run-tracker.mjs";

const commentary = JSON.stringify({ v: 1, id: "c", phase: "commentary" });
const finalAnswer = JSON.stringify({ v: 1, id: "f", phase: "final_answer" });

function user(text, id) {
  return { role: "user", id, content: [{ type: "text", text }], timestamp: 10 };
}

function assistant({ id = "a1", text, phase, stopReason = "stop", tools = [], extra = [] } = {}) {
  const content = [];
  if (text) {
    content.push({
      type: "text",
      text,
      ...(phase === "progress" ? { textSignature: commentary } : {}),
      ...(phase === "final" ? { textSignature: finalAnswer } : {}),
    });
  }
  content.push(...extra);
  for (const tool of tools) content.push({ type: "toolCall", id: tool.id, name: tool.name });
  return { role: "assistant", id, content, stopReason, timestamp: 20 };
}

function submit(tracker, text, id = text) {
  const message = user(text, id);
  const record = createInputRecord({ id, delivery: "submit", text, source: "tui" });
  tracker.attachRecord(message, record);
  return tracker.onUserMessageStart(message, record);
}

test("single run: progress, tool, final, settled", () => {
  const tracker = new RequestRunTracker({ now: () => Date.parse("2026-08-31T00:00:00.000Z") });
  submit(tracker, "fix it", "req-1");
  tracker.onAssistantMessage(assistant({ id: "a1", text: "inspecting", phase: "progress", stopReason: "toolUse", tools: [{ id: "t1", name: "grep" }] }));
  tracker.onTool({ id: "t1", name: "grep", summary: "grep", status: "done" });
  tracker.onAssistantMessage(assistant({ id: "a2", text: "done", phase: "final" }));
  tracker.onAgentSettled();
  const snap = tracker.snapshot();
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0].id, "req-1");
  assert.equal(snap.runs[0].status, "completed");
  assert.equal(snap.runs[0].finalMessageId, "a2:text:0");
  assert.equal(snap.runs[0].progressMessageCount, 1);
  assert.equal(snap.runs[0].toolCount, 1);
  assert.equal(snap.activeRequestRunId, undefined);
});

test("multi-turn stays one run until settled", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "work", "req-2");
  tracker.onAssistantMessage(assistant({ id: "a1", text: "step 1", stopReason: "toolUse", tools: [{ id: "t1", name: "read" }] }));
  tracker.onTool({ id: "t1", name: "read", status: "done" });
  tracker.onAssistantMessage(assistant({ id: "a2", text: "step 2", stopReason: "toolUse", tools: [{ id: "t2", name: "bash" }] }));
  tracker.onTool({ id: "t2", name: "bash", status: "done" });
  assert.equal(tracker.snapshot().runs.length, 1);
  assert.equal(tracker.snapshot().runs[0].status, "running");
  tracker.onAssistantMessage(assistant({ id: "a3", text: "finished" }));
  tracker.onAgentSettled();
  assert.equal(tracker.snapshot().runs[0].status, "completed");
  assert.equal(tracker.snapshot().runs[0].toolCount, 2);
});

test("followUp splits a new run and closes the previous", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "first", "req-a");
  tracker.onAssistantMessage(assistant({ id: "a1", text: "answer one" }));
  const follow = user("second", "req-b");
  const record = createInputRecord({ id: "req-b", delivery: "followUp", text: "second", source: "tui" });
  tracker.attachRecord(follow, record);
  tracker.enqueuePending(record);
  tracker.onUserMessageStart(follow, record);
  const snap = tracker.snapshot();
  assert.equal(snap.runs.length, 2);
  assert.equal(snap.runs[0].status, "completed");
  assert.equal(snap.runs[0].finalMessageId, "a1:text:0");
  assert.equal(snap.runs[1].id, "req-b");
  assert.equal(snap.runs[1].status, "running");
  assert.equal(snap.activeRequestRunId, "req-b");
});

test("steer stays on the same run", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "first", "req-s");
  tracker.onAssistantMessage(assistant({ id: "a1", text: "working", stopReason: "toolUse", tools: [{ id: "t1", name: "read" }] }));
  const steer = user("also this", "steer-1");
  const record = createInputRecord({
    id: "steer-1",
    delivery: "steer",
    text: "also this",
    source: "tui",
    targetRequestRunId: "req-s",
  });
  tracker.attachRecord(steer, record);
  tracker.onUserMessageStart(steer, record);
  const snap = tracker.snapshot();
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0].steeringCount, 1);
  assert.equal(snap.runs[0].status, "running");
  assert.equal(tracker.entries.filter((entry) => entry.role === "user").length, 2);
});

test("explicit phase wins over tools on the same message", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "q", "req-e");
  tracker.onAssistantMessage(assistant({
    id: "mix",
    extra: [
      { type: "text", text: "progressing", textSignature: commentary },
      { type: "toolCall", id: "t1", name: "read" },
      { type: "text", text: "the answer", textSignature: finalAnswer },
    ],
    stopReason: "stop",
  }));
  tracker.onAgentSettled();
  const phases = tracker.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.phase);
  assert.deepEqual(phases, ["progress", "final"]);
  assert.equal(tracker.snapshot().runs[0].finalMessageId, "mix:text:1");
});

test("fallback demotes an earlier stop candidate when tools continue", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "q", "req-f");
  tracker.onAssistantMessage(assistant({ id: "maybe", text: "looks done" }));
  tracker.onAssistantMessage(assistant({ id: "more", text: "actually more", stopReason: "toolUse", tools: [{ id: "t1", name: "bash" }] }));
  tracker.onTool({ id: "t1", name: "bash", status: "done" });
  tracker.onAssistantMessage(assistant({ id: "real", text: "real answer" }));
  tracker.onAgentSettled();
  const maybe = tracker.entries.find((entry) => entry.id === "maybe:text:0");
  assert.equal(maybe.phase, "progress");
  assert.equal(tracker.snapshot().runs[0].finalMessageId, "real:text:0");
});

test("abort and error close without inventing a final", () => {
  const aborted = new RequestRunTracker({ now: () => 1 });
  submit(aborted, "q", "req-abort");
  aborted.onAssistantMessage(assistant({ id: "p", text: "halfway", phase: "progress", stopReason: "aborted" }));
  aborted.onInterrupted();
  assert.equal(aborted.snapshot().runs[0].status, "interrupted");
  assert.equal(aborted.snapshot().runs[0].finalMessageId, undefined);

  const failed = new RequestRunTracker({ now: () => 1 });
  submit(failed, "q", "req-fail");
  failed.onAssistantMessage(assistant({ id: "e", text: "boom", stopReason: "error" }));
  failed.onFailed("provider exploded");
  assert.equal(failed.snapshot().runs[0].status, "failed");
  assert.equal(failed.snapshot().runs[0].finalMessageId, undefined);
  assert.equal(failed.snapshot().runs[0].failureMessage, "provider exploded");
});

test("auto retry / awaiting input keep the same run", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "q", "req-retry");
  tracker.onAssistantMessage(assistant({ id: "a1", text: "try", stopReason: "toolUse", tools: [{ id: "t1", name: "read" }] }));
  tracker.setAwaitingInput(true);
  assert.equal(tracker.snapshot().runs[0].status, "awaiting_input");
  tracker.setAwaitingInput(false);
  tracker.onAssistantMessage(assistant({ id: "a2", text: "retrying", stopReason: "toolUse", tools: [{ id: "t2", name: "read" }] }));
  assert.equal(tracker.snapshot().runs.length, 1);
  assert.equal(tracker.snapshot().runs[0].status, "running");
  tracker.onAgentSettled();
  assert.equal(tracker.snapshot().runs[0].status, "completed");
});

test("message_end error keeps the same run; later success + settled recovers", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "q", "req-retry-err");
  tracker.observe({
    type: "message_end",
    message: { ...assistant({ id: "e", text: "boom", stopReason: "error" }), errorMessage: "provider exploded" },
  });
  assert.equal(tracker.snapshot().runs.length, 1);
  assert.equal(tracker.snapshot().runs[0].id, "req-retry-err");
  assert.notEqual(tracker.snapshot().runs[0].status, "failed");
  assert.equal(tracker.activeRequestRunId, "req-retry-err");

  tracker.observe({ type: "compaction_start" });
  tracker.observe({ type: "compaction_end" });
  tracker.observe({
    type: "message_end",
    message: assistant({ id: "ok", text: "recovered" }),
  });
  tracker.onAgentSettled();
  const snap = tracker.snapshot();
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0].id, "req-retry-err");
  assert.equal(snap.runs[0].status, "completed");
  assert.equal(snap.runs[0].finalMessageId, "ok:text:0");
});

test("rebuild keeps one run across intermediate error then success", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  tracker.rebuildFromMessages([
    user("q", "req-rebuild"),
    assistant({ id: "e", text: "boom", stopReason: "error" }),
    assistant({ id: "ok", text: "recovered" }),
  ]);
  const snap = tracker.snapshot();
  assert.equal(snap.runs.length, 1);
  assert.notEqual(snap.runs[0].status, "failed");
});

test("unrecovered message_end error becomes failed only at settled", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  submit(tracker, "q", "req-fatal");
  tracker.observe({
    type: "message_end",
    message: { ...assistant({ id: "e", text: "boom", stopReason: "error" }), errorMessage: "dead" },
  });
  assert.notEqual(tracker.snapshot().runs[0].status, "failed");
  tracker.onAgentSettled();
  assert.equal(tracker.snapshot().runs[0].id, "req-fatal");
  assert.equal(tracker.snapshot().runs[0].status, "failed");
  assert.equal(tracker.snapshot().runs[0].finalMessageId, undefined);
});
