// Per-model context strategy on the notes controller (handoff 2026-09-23 §4, §15).
// Notes/history are on for every model; only how the window ends differs.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSession } from "../helpers/context-notes-fake.mjs";
import { ContextNotesController, GUIDANCE, guidanceFor } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { NUDGE_ENTRY, REMINDER_ENTRY, messageText } from "../../src/context-notes/protocol.mjs";
import { NUDGE_TEXT, REMINDER_TEXT } from "../../src/context-notes/reminder.mjs";

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000, maxTokens: 128000 };
const GROK = { provider: "xai", id: "grok-4.7", contextWindow: 500000, maxTokens: 128000 };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1000000, maxTokens: 128000 };
const DEEPSEEK = { provider: "b-ai", id: "deepseek-v4.1-flash", contextWindow: 1000000, maxTokens: 384000 };
const GEMINI = { provider: "google-antigravity", id: "gemini-3.8-flash", contextWindow: 1048576, maxTokens: 65536 };

function setup(t, model, env = {}) {
  const f = fakeSession(t);
  f.ctx.model = model;
  let tokens = 0;
  f.ctx.getContextUsage = () => ({ tokens });
  f.addMessage("user", "Goal: migrate the cache layer without changing the public API.");
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig(env) });
  t.after(() => c.close());
  let call = 0;
  // One completed tool round of real work; the provider meter ends at `at` tokens.
  const work = (at) => {
    tokens = at;
    const id = `work-${++call}`;
    f.addMessage("assistant", [{ type: "toolCall", id, name: "read", arguments: {} }],
      { stopReason: "toolUse", usage: { input: at - 500, output: 500, cacheRead: 0, cacheWrite: 0 } });
    f.addMessage("toolResult", `contents ${call}`, { toolName: "read", toolCallId: id });
    c.refresh(f.ctx);
  };
  // A turn that only saves the note: the note stays fresh at the turn boundary.
  const save = (text = "Goal, decisions, progress, next step; see window/item refs.") => {
    const id = `note-${++call}`;
    f.addMessage("assistant", [{ type: "toolCall", id, name: "notes_write_file", arguments: {} }],
      { stopReason: "toolUse", usage: { input: tokens - 500, output: 500, cacheRead: 0, cacheWrite: 0 } });
    c.writeNote({ path: "work.md", text }, f.ctx, { operationId: id });
    f.addMessage("toolResult", "saved", { toolName: "notes_write_file", toolCallId: id });
    c.refresh(f.ctx);
  };
  const prepare = () => c.prepareContext({ messages: f.build().messages }, f.ctx).messages;
  return { ...f, c, work, save, prepare, setTokens: (n) => { tokens = n; } };
}

const count = (messages, text) => messages.filter((m) => messageText(m) === text).length;

test("Claude: notes are on, nothing rolls over automatically, even near the physical window", async (t) => {
  const f = setup(t, OPUS);
  assert.equal(f.c.usage().strategy, "server-compaction");
  f.work(50_000); f.save(); f.work(990_000);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0);
  assert.equal(f.sent.length, 0, "no checkpoint turn is steered for Claude");
  assert.doesNotThrow(() => f.c.admit(f.build().messages));
  const messages = f.prepare();
  assert.equal(count(messages, REMINDER_TEXT), 0);
  // Model-initiated new_context still works for Claude.
  f.save(); f.c.requestWindow(f.ctx);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

for (const [name, model] of [["DeepSeek", DEEPSEEK], ["Gemini", GEMINI]]) {
  test(`${name}: nudges keep notes fresh but never start a new context below the hard line`, async (t) => {
    const f = setup(t, model);
    const budget = f.c.usage();
    assert.equal(budget.strategy, "hard-safety");
    f.work(20_000); f.save();
    // A fresh note at 70% of the window: still no automatic rollover.
    const deep = Math.floor(model.contextWindow * 0.7);
    f.work(deep); f.save();
    await f.c.turnEnd({}, f.ctx);
    assert.equal(f.c.window.number, 0); assert.equal(f.sent.length, 0);
    f.work(deep + budget.nudgeTokens);
    const messages = f.prepare();
    assert.equal(count(messages, NUDGE_TEXT), 1);
    await f.c.turnEnd({}, f.ctx);
    assert.equal(f.c.window.number, 0); assert.equal(f.sent.length, 0);
  });
}

test("hard-safety models roll only at the computed line, after a checkpoint turn", async (t) => {
  const f = setup(t, DEEPSEEK);
  const { hard, full } = f.c.usage();
  assert.ok(hard < full && hard > 900_000);
  f.work(20_000); f.save(); f.work(hard + 1000);
  assert.throws(() => f.c.admit(f.build().messages), /창 한도/);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.checkpointRequested, true); assert.equal(f.sent.length, 1);
  f.save();
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

test("Grok: no rollover past the 200K price boundary", async (t) => {
  const f = setup(t, GROK);
  f.work(150_000); f.work(260_000); f.save();
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0); assert.equal(f.sent.length, 0);
});

test("Grok: 300-320K rolls at a natural boundary (a turn that ended on a fresh note)", async (t) => {
  const f = setup(t, GROK);
  f.work(200_000); f.work(305_000);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0, "mid-task in the soft zone: keep going");
  assert.equal(f.sent.length, 0, "the soft zone does not steer");
  f.save();
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

test("Grok: from 320K the model is steered to save and roll over", async (t) => {
  const f = setup(t, GROK);
  f.work(200_000); f.save(); f.work(325_000);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.checkpointRequested, true); assert.equal(f.sent.length, 1);
  assert.equal(f.c.window.number, 0);
  f.save();
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

test("Grok: 400K is the hard line", async (t) => {
  const f = setup(t, GROK);
  f.work(200_000); f.save(); f.work(401_000);
  assert.throws(() => f.c.admit(f.build().messages), /400000/);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.checkpointRequested, true);
  assert.doesNotThrow(() => f.c.admit(f.build().messages), "the checkpoint turn itself is admitted");
});

test("Astra: reminder at 238,656, rollover-only from 90%, and a stale note does not roll", async (t) => {
  const f = setup(t, ASTRA);
  f.work(100_000); f.save(); f.work(238_000);
  assert.equal(count(f.prepare(), REMINDER_TEXT), 0);
  f.work(239_000);
  assert.equal(count(f.prepare(), REMINDER_TEXT), 1);
  f.work(245_000);
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0, "work after the note: the note is stale, no cut");
  assert.equal(f.c.checkpointRequested, true);
  f.save();
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
});

test("nudges are append-only: every earlier request is an exact prefix of the next", (t) => {
  const f = setup(t, ASTRA); // 54,400-token interval on a 272K window
  f.work(10_000);
  const first = f.prepare();
  f.work(40_000);
  const second = f.prepare();
  assert.equal(count(second, NUDGE_TEXT), 0);
  f.work(70_000);
  const third = f.prepare();
  assert.equal(count(third, NUDGE_TEXT), 1);
  assert.equal(messageText(third.at(-1)), NUDGE_TEXT, "a new nudge goes after the last message");
  f.work(90_000);
  const fourth = f.prepare();
  assert.equal(count(fourth, NUDGE_TEXT), 1, "one nudge per interval");
  // A note resets the interval; the next nudge again needs a full interval of new work.
  f.save(); f.work(140_000);
  assert.equal(count(f.prepare(), NUDGE_TEXT), 1);
  f.work(150_000);
  const sixth = f.prepare();
  assert.equal(count(sixth, NUDGE_TEXT), 2);
  for (const [earlier, later] of [[first, second], [second, third], [third, fourth], [fourth, sixth]]) {
    assert.deepEqual(later.slice(0, earlier.length), earlier);
  }
  assert.equal(f.branch().filter((e) => e.customType === NUDGE_ENTRY).length, 2);
  // Restarting the controller rebuilds the same request.
  f.c.close();
  const again = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => again.close());
  assert.deepEqual(again.prepareContext({ messages: f.build().messages }, f.ctx).messages, sixth);
});

test("a nudge does not make a note stale and does not block new_context", async (t) => {
  const f = setup(t, DEEPSEEK);
  f.work(10_000); f.work(260_000);
  assert.equal(count(f.prepare(), NUDGE_TEXT), 1);
  f.save();
  f.prepare();
  assert.doesNotThrow(() => f.c.requestWindow(f.ctx));
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 1);
  assert.equal(count(f.prepare(), NUDGE_TEXT), 0, "the new window starts without the old nudges");
});

test("the nudge interval follows RUBATO_CONTEXT_NOTE_NUDGE_RATIO and 0 turns it off", (t) => {
  const off = setup(t, DEEPSEEK, { RUBATO_CONTEXT_NOTE_NUDGE_RATIO: "0" });
  off.work(10_000); off.work(900_000);
  assert.equal(count(off.prepare(), NUDGE_TEXT), 0);
  const tight = setup(t, DEEPSEEK, { RUBATO_CONTEXT_NOTE_NUDGE_RATIO: "0.05" });
  tight.work(10_000); tight.work(61_000);
  assert.equal(count(tight.prepare(), NUDGE_TEXT), 1);
});

test("a server compaction that shrinks the context does not hide accumulated work", (t) => {
  const f = setup(t, OPUS); // 200K interval
  f.work(10_000); f.work(150_000);
  f.work(40_000); // provider compacted: the meter drops
  f.work(80_000);
  assert.equal(count(f.prepare(), NUDGE_TEXT), 0, "140K + 40K so far");
  f.work(110_000);
  assert.equal(count(f.prepare(), NUDGE_TEXT), 1);
});

test("system-prompt guidance is a pure function of the model; Astra's text is unchanged", () => {
  assert.equal(guidanceFor(ASTRA), GUIDANCE);
  assert.equal(guidanceFor({ ...ASTRA, id: "gpt-6-astra-sub" }), GUIDANCE);
  for (const model of [GROK, OPUS, DEEPSEEK, GEMINI]) {
    assert.equal(guidanceFor(model), guidanceFor({ ...model }));
    assert.notEqual(guidanceFor(model), GUIDANCE, `${model.id} does not get Astra's 90%/95% text`);
  }
  assert.doesNotMatch(guidanceFor(OPUS), /90%|95%/);
});

test("an existing Claude session with a server compaction block opens in notes and keeps the block", async (t) => {
  const f = fakeSession(t);
  f.ctx.model = OPUS;
  f.ctx.getContextUsage = () => ({ tokens: 120_000 });
  f.addMessage("user", "Long-running task from before notes existed for Claude.");
  const block = { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "<summary>server brief</summary>" } };
  f.addMessage("assistant", [block, { type: "text", text: "continuing" }],
    { stopReason: "stop", provider: "anthropic", api: "anthropic-messages", usage: { input: 60_000, output: 500, cacheRead: 0, cacheWrite: 0 } });
  f.addMessage("user", "next step");
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => c.close());
  const messages = c.prepareContext({ messages: f.build().messages }, f.ctx).messages;
  const assistant = messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.content[0], block, "the provider's compaction block is replayed untouched");
  assert.equal(c.store.readItem({ window_id: c.window.windowId, item_id: f.entries[0].id }).content.includes("before notes existed"), true);
  await c.turnEnd({}, f.ctx);
  assert.equal(c.window.number, 0);
});
