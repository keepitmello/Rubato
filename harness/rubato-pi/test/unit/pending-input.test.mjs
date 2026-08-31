import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { senpiDir } from "../../src/engine-paths.mjs";
import { injectAgentSession } from "../../src/transforms/core-agent-session.mjs";
import {
  RequestRunTracker,
  createInputRecord,
  pendingInputSummary,
  textPreview,
} from "../../src/transforms/request-run-tracker.mjs";

function user(text, extra = {}) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra };
}

test("duplicate text keeps distinct WeakMap identities", () => {
  const tracker = new RequestRunTracker({ now: () => 1_000 });
  const first = user("same text");
  const second = user("same text");
  const a = createInputRecord({ id: "in-1", delivery: "steer", text: "same text", source: "tui" });
  const b = createInputRecord({ id: "in-2", delivery: "followUp", text: "same text", source: "tui" });
  tracker.attachRecord(first, a);
  tracker.attachRecord(second, b);
  tracker.enqueuePending(a);
  tracker.enqueuePending(b);
  assert.notEqual(first, second);
  assert.equal(tracker.getRecord(first).id, "in-1");
  assert.equal(tracker.getRecord(second).id, "in-2");
  assert.equal(tracker.getRecord(first).delivery, "steer");
  assert.equal(tracker.getRecord(second).delivery, "followUp");
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.pendingInputs.length, 2);
  assert.deepEqual(snapshot.pendingInputs.map((item) => item.id), ["in-1", "in-2"]);
});

test("pending summaries preview text and omit full body", () => {
  const long = "x".repeat(600);
  const record = createInputRecord({
    id: "in-3",
    delivery: "followUp",
    text: long,
    imageCount: 2,
    source: "remote",
    enqueuedAt: Date.parse("2026-08-31T00:00:00.000Z"),
  });
  const summary = pendingInputSummary(record);
  assert.equal(summary.textPreview, textPreview(long));
  assert.equal([...summary.textPreview].length, 500);
  assert.equal(summary.textLength, 600);
  assert.equal(summary.imageCount, 2);
  assert.equal(summary.source, "remote");
  assert.equal(summary.delivery, "followUp");
});

test("clearPendingInputs reports only still-queued ids", () => {
  const tracker = new RequestRunTracker({ now: () => 2_000 });
  const started = user("go");
  const queued = user("later");
  const startedRecord = createInputRecord({ id: "start-1", delivery: "submit", text: "go", source: "tui" });
  const queuedRecord = createInputRecord({ id: "queue-1", delivery: "followUp", text: "later", source: "tui" });
  tracker.attachRecord(started, startedRecord);
  tracker.attachRecord(queued, queuedRecord);
  tracker.enqueuePending(queuedRecord);
  tracker.onUserMessageStart(started, startedRecord);
  const cleared = tracker.clearPendingInputs();
  assert.deepEqual(cleared.clearedIds, ["queue-1"]);
  assert.equal(tracker.snapshot().pendingInputs.length, 0);
  assert.equal(tracker.runs[0].id, "start-1");
});

test("message_start object identity is the queued object", () => {
  const tracker = new RequestRunTracker({ now: () => 3_000 });
  const message = user("queued");
  const record = createInputRecord({ id: "q-1", delivery: "followUp", text: "queued", source: "tui" });
  tracker.attachRecord(message, record);
  tracker.enqueuePending(record);
  const started = tracker.onUserMessageStart(message);
  assert.equal(started.id, "q-1");
  assert.equal(tracker.getRecord(message), record);
  assert.equal(record.processedAt, 3_000);
  assert.equal(tracker.snapshot().pendingInputs.length, 0);
});

test("native clearQueue must not emit stale pendingInputs", () => {
  const tracker = new RequestRunTracker({ now: () => 1 });
  const record = createInputRecord({ id: "q-1", delivery: "followUp", text: "later", source: "tui" });
  tracker.enqueuePending(record);
  const emissions = [];
  const nativeClearQueue = () => {
    emissions.push(tracker.snapshot().pendingInputs.map((item) => item.id));
  };
  // Required order: tracker first so native queue_update sees an empty pending list.
  const cleared = tracker.clearPendingInputs();
  nativeClearQueue();
  assert.deepEqual(cleared.clearedIds, ["q-1"]);
  assert.deepEqual(emissions, [[]]);
});

test("injected clearPendingInteractiveInputs clears tracker before native queue_update", () => {
  const source = readFileSync(`${senpiDir}/dist/core/agent-session.js`, "utf8");
  const injected = injectAgentSession(source);
  const start = injected.indexOf("clearPendingInteractiveInputs()");
  assert.ok(start >= 0, "clearPendingInteractiveInputs missing from injected session");
  const body = injected.slice(start, start + 280);
  const trackerClear = body.indexOf("clearPendingInputs");
  const nativeClear = body.indexOf("clearQueue()");
  assert.ok(trackerClear >= 0, body);
  assert.ok(nativeClear >= 0, body);
  assert.ok(
    trackerClear < nativeClear,
    `tracker must be cleared before native clearQueue emits queue_update:\n${body}`,
  );
});

test("injected observe does not terminalize message_end error", () => {
  const source = readFileSync(`${senpiDir}/dist/core/agent-session.js`, "utf8");
  const injected = injectAgentSession(source);
  const start = injected.indexOf("_observeRequestRunEvent(event) {");
  assert.ok(start >= 0, "observe hook missing from injected session");
  const body = injected.slice(start, start + 1400);
  assert.equal(
    body.includes("onFailed"),
    false,
    `message_end error must not call onFailed:\n${body}`,
  );
});

test("injected session completes the run before emitting agent_settled", () => {
  const source = readFileSync(`${senpiDir}/dist/core/agent-session.js`, "utf8");
  const injected = injectAgentSession(source);
  const start = injected.indexOf("this._requestRunTracker?.onAgentSettled()");
  const emit = injected.indexOf('this._emit({ type: "agent_settled" })');
  assert.ok(start >= 0, "onAgentSettled call missing from injected session");
  assert.ok(emit >= 0, "agent_settled emit missing from injected session");
  assert.ok(
    start < emit,
    "tracker must complete the run before agent_settled so remote snapshot sees the finished request",
  );
});
