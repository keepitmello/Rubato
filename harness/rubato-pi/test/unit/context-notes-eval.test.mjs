import test from "node:test";
import assert from "node:assert/strict";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { fakeSession } from "../helpers/context-notes-fake.mjs";

function setup(t) {
  const f = fakeSession(t);
  f.addMessage("user", "Continue the work without losing the checkpoint");
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false });
  t.after(() => c.close());
  return { ...f, c };
}

function evalCall(f, id = "eval-1") {
  f.addMessage("assistant", [{ type: "toolCall", name: "eval", id, arguments: {} }]);
}

function evalResult(f, names, { id = "eval-1", ...details } = {}) {
  f.addMessage("toolResult", "checkpoint saved", {
    toolName: "eval", toolCallId: id,
    details: {
      toolCallCount: names.length,
      toolCalls: names.map((name) => ({ name, ok: true })),
      cells: [{ status: "complete" }],
      ...details,
    },
  });
}

function save(f) {
  f.c.writeNote({ path: "work.md", text: "Current goal, progress and next steps" }, f.ctx);
}

test("note and new_context in one eval commit after the wrapper result", async (t) => {
  const f = setup(t);
  evalCall(f);
  save(f);
  f.c.requestWindow(f.ctx);
  evalResult(f, ["notes_write_file", "new_context"]);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
  assert.equal(f.c.paused, null);
});

test("a checkpoint-only turn accepts a note written through eval", async (t) => {
  const f = setup(t);
  f.c.requestCheckpoint();
  evalCall(f);
  save(f);
  evalResult(f, ["notes_append_to_file"]);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
  assert.equal(f.c.checkpointRequested, false);
  assert.equal(f.c.paused, null);
});

test("a separate eval may schedule new_context but must finish before commit", async (t) => {
  const f = setup(t);
  evalCall(f);
  save(f);
  evalResult(f, ["notes_write_file"]);
  evalCall(f, "eval-2");
  assert.doesNotThrow(() => f.c.requestWindow(f.ctx));
  await assert.rejects(f.c.roll(f.ctx), /최신 상태/);
  evalResult(f, ["new_context"], { id: "eval-2" });
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

for (const [name, names, details] of [
  ["mixed work", ["notes_write_file", "bash"], {}],
  ["missing receipt", ["notes_write_file"], { toolCallCount: undefined }],
  ["incomplete receipt", ["notes_write_file"], { toolCallCount: 2 }],
  ["failed nested tool", ["notes_write_file"], { toolCalls: [{ name: "notes_write_file", ok: false }] }],
  ["failed cell", ["notes_write_file"], { isError: true }],
  ["detached cell", ["notes_write_file"], { cells: [{ status: "detached" }] }],
  ["missing cell status", ["notes_write_file"], { cells: undefined }],
  ["no nested tools", [], {}],
]) {
  test(`eval with ${name} still blocks a context cut`, async (t) => {
    const f = setup(t);
    evalCall(f);
    save(f);
    f.c.requestWindow(f.ctx);
    evalResult(f, names, details);
    await assert.rejects(f.c.roll(f.ctx), /최신 상태/);
    await f.c.turnEnd({}, f.ctx);
    assert.equal(f.c.window.number, 0);
    assert.equal(f.c.checkpointRequested, true);
    assert.equal(f.abort.signal.aborted, false);
    assert.ok(f.build().messages.some((m) => m.role === "user"));
  });
}

test("work in a separately scheduled eval is checked again at the boundary", async (t) => {
  const f = setup(t);
  save(f);
  evalCall(f);
  f.c.requestWindow(f.ctx);
  evalResult(f, ["new_context", "bash"]);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0);
  assert.equal(f.c.checkpointRequested, true);
  assert.equal(f.abort.signal.aborted, false);
});

test("a new user request is not hidden by an outstanding eval", (t) => {
  const f = setup(t);
  save(f);
  evalCall(f);
  f.addMessage("user", "New requirement");
  assert.throws(() => f.c.requestWindow(f.ctx), /현재 요청/);
});

test("user cancellation above the checkpoint threshold never queues recovery", async (t) => {
  const f = setup(t);
  f.ctx.getContextUsage = () => ({ tokens: 30_000 });
  f.c.refresh(f.ctx);
  f.c.requestCheckpoint();
  const sent = f.sent.length;
  f.ctx.signal = AbortSignal.abort();
  await f.c.turnEnd({ message: { stopReason: "aborted" } }, f.ctx);
  assert.equal(f.sent.length, sent);
  assert.equal(f.c.checkpointRequested, false);
  assert.equal(f.c.window.number, 0);
});

test("a failed durable write is not treated as a repairable checkpoint", async (t) => {
  const f = setup(t);
  f.c.flushJournal = () => { throw new Error("disk failed"); };
  assert.throws(() => save(f), /disk failed/);
  f.c.pending = { sessionId: f.c.sessionId, windowId: f.c.window.windowId, userId: f.c.lastUser };
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.sent.length, 0);
  assert.equal(f.abort.signal.aborted, true);
  assert.equal(f.c.window.number, 0);
});
