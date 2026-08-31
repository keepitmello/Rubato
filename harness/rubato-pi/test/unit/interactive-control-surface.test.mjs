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
    async submitInput(text, options) { calls.push(["input", text, options]); return { accepted: true }; },
    async executeUserBash(command, excluded) { calls.push(["bash", command, excluded]); },
    respondToUiRequest(id, value) { calls.push(["ui", id, value]); return id === "pending"; },
  };
  const dispatcher = new InteractiveActionDispatcher(
    { getInteractiveControl: () => control },
    { resolveImages: async (ids) => ids.map((id) => ({ type: "image", id })) },
  );
  await dispatcher.dispatch(request("steer", "input.steer", { text: "go", imageIds: ["img"] }));
  await dispatcher.dispatch(request("bash", "bash.execute", { command: "pwd", excludeFromContext: true }));
  await dispatcher.dispatch(request("ui", "ui.respond", { requestId: "pending", value: "yes" }));
  assert.equal(calls[0][2].delivery, "steer");
  assert.equal(calls[0][2].images[0].id, "img");
  assert.deepEqual(calls[1], ["bash", "pwd", true]);
  assert.deepEqual(calls[2], ["ui", "pending", "yes"]);
});
