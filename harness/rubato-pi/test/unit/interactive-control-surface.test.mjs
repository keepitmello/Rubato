import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveActionDispatcher, RemoteActionError } from "../../src/interactive-control-surface.mjs";

function request(requestId, action, payload = {}, expectedRevision) {
  return { requestId, action, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

test("remote actions dereference the current control and preserve FIFO order", async () => {
  const calls = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  let current = {
    async compact(value) { calls.push(`first:${value}`); await firstDone; },
  };
  const pi = { getInteractiveControl: () => current };
  const dispatcher = new InteractiveActionDispatcher(pi);

  const first = dispatcher.dispatch(request("one", "session.compact", { instructions: "a" }));
  const second = dispatcher.dispatch(request("two", "session.compact", { instructions: "b" }));
  await Promise.resolve();
  assert.deepEqual(calls, ["first:a"]);
  current = { async compact(value) { calls.push(`second:${value}`); } };
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["first:a", "second:b"]);
});

test("duplicate request IDs share one result and stale revisions fail before dispatch", async () => {
  let calls = 0;
  const control = { async abortAgent() { calls += 1; } };
  const dispatcher = new InteractiveActionDispatcher({ getInteractiveControl: () => control }, { getRevision: () => 7 });
  const action = request("same", "agent.abort", {}, 7);
  await Promise.all([dispatcher.dispatch(action), dispatcher.dispatch(action)]);
  assert.equal(calls, 1);

  await assert.rejects(
    dispatcher.dispatch(request("stale", "agent.abort", {}, 6)),
    (error) => error instanceof RemoteActionError && error.code === "stale_revision",
  );
  assert.equal(calls, 1);
});

test("input delivery, images, bash context, and UI responses use native controls", async () => {
  const calls = [];
  const control = {
    async submitInput(text, options) { calls.push(["input", text, options]); return { accepted: true, inputId: options.clientInputId, disposition: "queued-steer" }; },
    clearPendingInputs() { calls.push(["clear"]); return { clearedIds: ["a"] }; },
    async readConversationPage(input) { calls.push(["page", input]); return { entries: [], requestRuns: [] }; },
    async executeUserBash(command, excluded) { calls.push(["bash", command, excluded]); },
    respondToUiRequest(id, value) { calls.push(["ui", id, value]); return id === "pending"; },
  };
  const dispatcher = new InteractiveActionDispatcher(
    { getInteractiveControl: () => control },
    { resolveImages: async (ids) => ids.map((id) => ({ type: "image", id })) },
  );
  const steered = await dispatcher.dispatch(request("steer", "input.steer", { text: "go", imageIds: ["img"] }));
  await dispatcher.dispatch(request("bash", "bash.execute", { command: "pwd", excludeFromContext: true }));
  await dispatcher.dispatch(request("ui", "ui.respond", { requestId: "pending", value: "yes" }));
  const cleared = await dispatcher.dispatch(request("clear", "input.queue.clear"));
  const page = await dispatcher.dispatch(request("page", "conversation.page", { before: "x", limit: 20 }));
  assert.equal(calls[0][2].delivery, "steer");
  assert.equal(calls[0][2].source, "remote");
  assert.equal(calls[0][2].clientInputId, "steer");
  assert.equal(calls[0][2].images[0].id, "img");
  assert.equal(steered.inputId, "steer");
  assert.equal(steered.disposition, "queued-steer");
  assert.deepEqual(calls[1], ["bash", "pwd", true]);
  assert.deepEqual(calls[2], ["ui", "pending", "yes"]);
  assert.deepEqual(calls[3], ["clear"]);
  assert.deepEqual(cleared, { clearedIds: ["a"] });
  assert.deepEqual(calls[4], ["page", { before: "x", limit: 20 }]);
  assert.deepEqual(page, { entries: [], requestRuns: [] });
});

test("busy auto is followUp and snapshot exposes requestTimeline", async () => {
  const calls = [];
  const control = {
    async submitInput(text, options) { calls.push(options); return { accepted: true, inputId: "id-1", disposition: options.delivery === "steer" ? "queued-steer" : "queued-follow-up" }; },
    snapshot() {
      return {
        isStreaming: true,
        pendingMessageCount: 1,
        requestTimeline: { schemaVersion: 1, runs: [], pendingInputs: [], hasOlder: false },
      };
    },
  };
  const dispatcher = new InteractiveActionDispatcher({ getInteractiveControl: () => control });
  const result = await dispatcher.dispatch(request("auto-1", "input.submit", { text: "later" }));
  assert.equal(calls[0].delivery, "auto");
  assert.equal(calls[0].source, "remote");
  assert.equal(calls[0].clientInputId, "auto-1");
  assert.equal(result.disposition, "queued-follow-up");
  assert.equal(control.snapshot().requestTimeline.schemaVersion, 1);
});
