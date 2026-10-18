import assert from "node:assert/strict";
import test from "node:test";
import { fakeSession } from "../helpers/context-notes-fake.mjs";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { messageText } from "../../src/context-notes/protocol.mjs";
import { BYTE_NUDGE_TEXT } from "../../src/context-notes/reminder.mjs";
import { ANTHROPIC_SERVER_COMPACTION_MODEL_IDS } from "../../src/context-budget.mjs";
import { requestByteSize, assertRequestWireBytes, REQUEST_BYTE_WARNING, REQUEST_BYTE_CHECKPOINT,
  REQUEST_BYTE_LIMIT, REQUEST_WIRE_BYTE_LIMIT, REQUEST_BYTE_REFUSAL } from "../../src/context-notes/request-budget.mjs";

const image = (bytes) => ({ type: "image", data: Buffer.alloc(bytes, 7).toString("base64"), mimeType: "image/png" });
function setup(t) {
  const f = fakeSession(t);
  // Claude keeps its token compaction strategy; bytes must work even at low token usage.
  f.ctx.model = { provider: "anthropic", api: "anthropic-messages", id: ANTHROPIC_SERVER_COMPACTION_MODEL_IDS[0], contextWindow: 1000000 };
  f.ctx.getContextUsage = () => ({ tokens: 100 });
  f.addMessage("user", "Inspect the screenshots, then continue.");
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => c.close());
  return { ...f, c };
}
const prepare = (f) => f.c.prepareContext({ messages: f.build().messages }, f.ctx).messages;

test("image additions and text growth preserve every previously prepared block, including beyond the old image cap", (t) => {
  const f = setup(t);
  f.addMessage("user", [image(9 * 1024 * 1024)]);
  const before = prepare(f);
  f.addMessage("user", [image(8 * 1024 * 1024)]);
  const afterImage = prepare(f);
  assert.deepEqual(afterImage.slice(0, before.length), before);
  f.addMessage("user", "text".repeat(10000));
  const afterText = prepare(f);
  assert.deepEqual(afterText.slice(0, afterImage.length), afterImage);
  assert.deepEqual(prepare(f), afterText, "repeated preparation is identical");
  assert.equal(afterText.flatMap((m) => m.content ?? []).filter((p) => p.type === "image").length, 2);
});

test("byte warning is early, anchored once and identical after text growth and controller restart", (t) => {
  const f = setup(t);
  f.addMessage("user", "x".repeat(REQUEST_BYTE_WARNING));
  const before = prepare(f);
  assert.ok(before.some((m) => messageText(m) === BYTE_NUDGE_TEXT));
  assert.ok(f.c.usage().requestBytes < REQUEST_BYTE_CHECKPOINT);
  assert.equal(f.c.usage().target, undefined, "Claude's token compaction stays server-owned");
  f.addMessage("user", "next");
  const after = prepare(f);
  assert.deepEqual(after.slice(0, before.length), before);
  f.c.close();
  f.c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => f.c.close());
  assert.deepEqual(prepare(f), after);
  assert.equal(f.c.store.diagnostics().filter((e) => e.event === "byte_nudge_recorded").length, 1);
});

test("serialized measurement counts escaped system prompt and active tool definitions", (t) => {
  const f = setup(t);
  const prompt = "\u0000".repeat(100);
  const tools = [{ name: "large", description: "\u0001".repeat(200), parameters: { type: "object" } }];
  f.ctx.getSystemPrompt = () => prompt;
  f.pi.getAllTools = () => tools;
  f.pi.getActiveTools = () => ["large"];
  f.c.refresh(f.ctx, true);
  assert.equal(f.c.usage([]).fixedBytes, requestByteSize([], prompt, tools));
  assert.ok(f.c.usage([]).fixedBytes > prompt.length + JSON.stringify(tools).length);
});

test("byte checkpoint line requests one checkpoint turn despite low Claude token usage", async (t) => {
  const f = setup(t);
  f.addMessage("user", "x".repeat(REQUEST_BYTE_CHECKPOINT));
  prepare(f);
  await f.c.turnEnd({}, f.ctx);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.sent.filter(([m]) => m.customType === "rubato-context-checkpoint-request").length, 1);
  f.c.writeNote({ path: "now.md", text: "Goal: inspect screenshots. Next: continue. Original references in history." }, f.ctx);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

test("one oversized paired tool result refuses without projection, then explicitly rolls and preserves images/history/notes", async (t) => {
  const f = setup(t);
  f.c.writeNote({ path: "now.md", text: "Inspect screenshots; continue after reading the result." }, f.ctx);
  f.addMessage("assistant", [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "synthetic.png" } }],
    { stopReason: "toolUse" });
  const original = f.addMessage("toolResult", Array.from({ length: 10 }, () => image(2_300_000)),
    { toolName: "read", toolCallId: "read-1" });
  const old = f.c.window.windowId;
  const snapshot = JSON.stringify(f.build().messages);
  assert.throws(() => prepare(f), new RegExp(REQUEST_BYTE_REFUSAL));
  assert.equal(JSON.stringify(f.build().messages), snapshot, "no retroactive edits or missing results");
  await f.c.turnEnd({ message: { stopReason: "error" } }, f.ctx);
  assert.equal(f.c.window.number, 1);
  assert.equal(f.sent.at(-1)[0].customType, "rubato-context-continue");
  const read = f.c.store.readImage({ window_id: old, item_id: original.id });
  assert.ok(read.data, "the archived original image remains retrievable");
  assert.equal(f.c.store.noteText("now.md"), "Inspect screenshots; continue after reading the result.");
  assert.doesNotThrow(() => prepare(f));
});

test("oversized fixed instructions stop rather than looping through empty contexts", async (t) => {
  const f = setup(t);
  f.ctx.getSystemPrompt = () => "x".repeat(REQUEST_BYTE_CHECKPOINT - 1000);
  f.c.refresh(f.ctx, true);
  assert.throws(() => prepare(f), /프롬프트/);
  await f.c.turnEnd({ message: { stopReason: "error" } }, f.ctx);
  assert.equal(f.c.window.number, 0);
  assert.equal(f.sent.length, 0);
});

test("wire overflow is refused before send and repeated fresh-window overflow cannot loop", async (t) => {
  assert.doesNotThrow(() => assertRequestWireBytes({ x: "small" }));
  const payload = { x: "\u0000".repeat(Math.ceil(REQUEST_WIRE_BYTE_LIMIT / 6)) };
  assert.throws(() => assertRequestWireBytes(payload), new RegExp(REQUEST_BYTE_REFUSAL));
  const f = setup(t);
  const error = { message: { stopReason: "error", errorMessage: `${REQUEST_BYTE_REFUSAL} synthetic wire overflow` } };
  await f.c.turnEnd(error, f.ctx);
  assert.equal(f.c.window.number, 1);
  await f.c.turnEnd(error, f.ctx);
  assert.equal(f.c.window.number, 1);
  assert.match(f.c.paused, /반복/);
});
