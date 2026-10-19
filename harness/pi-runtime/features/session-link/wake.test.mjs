// Rubato's own clock (heartbeat, daily report) reaches the conversation as a system message where
// the model takes one mid-conversation, and as the wrapped envelope everywhere else.
import assert from "node:assert/strict";
import test from "node:test";

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";

import { installSessionLink } from "./extension.mjs";
import { DELIVER_REQUEST, SESSION_MESSAGE_TYPE, SYSTEM_ANCHOR, buildSessionMessage, parseDelivery, projectWakes } from "./message.mjs";

const HEARTBEAT = "Heartbeat. Look over the conversations you follow.";
const PROMPT = { role: "system", content: "You are Segno.", timestamp: 1 };
const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const answer = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages",
  provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const wake = (what, text, timestamp) => ({ role: "custom", timestamp,
  ...buildSessionMessage(parseDelivery({ v: 1, messageId: `w${timestamp}`, kind: "wake", what, text })) });
const anchor = (timestamp) => ({ role: "user", content: [{ type: "text", text: SYSTEM_ANCHOR }], timestamp });
const system = (text, timestamp) => ({ role: "system", content: [{ type: "text", text }], timestamp });

test("a wake is Rubato's clock, not shown, and its envelope says so for models that read it as a user message", () => {
  const message = wake("heartbeat", HEARTBEAT, 5);
  assert.equal(message.display, false);
  assert.equal(message.details.kind, "wake");
  assert.equal(message.details.from.sessionId, "rubato");
  assert.equal(message.content, `<rubato_wake what="heartbeat">\nRubato's own clock, not the user and not another conversation.\n${HEARTBEAT}\n</rubato_wake>`);
  assert.throws(() => parseDelivery({ v: 1, messageId: "w", kind: "wake", what: "lunch", text: "x" }), /unknown wake/);
  assert.throws(() => parseDelivery({ v: 1, messageId: "w", kind: "wake", what: "heartbeat", text: " " }), /text/);
});

test("for a model that takes system messages, a wake after an answer is the anchor and a system message", () => {
  const messages = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  assert.deepEqual(projectWakes(messages, { native: true }), [PROMPT, user("hi", 2), answer("hello", 3), anchor(4), system(HEARTBEAT, 4)]);
});

test("a wake that already has a user-side message before it needs no anchor; one right after the prompt does", () => {
  const afterUser = [PROMPT, user("hi", 2), wake("daily-report", "Daily report time.", 3)];
  assert.deepEqual(projectWakes(afterUser, { native: true }), [PROMPT, user("hi", 2), system("Daily report time.", 3)]);
  const first = [PROMPT, wake("heartbeat", HEARTBEAT, 2)];
  assert.deepEqual(projectWakes(first, { native: true }), [PROMPT, anchor(2), system(HEARTBEAT, 2)]);
  const twice = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4), wake("heartbeat", HEARTBEAT, 5)];
  assert.deepEqual(projectWakes(twice, { native: true }).slice(3), [anchor(4), system(HEARTBEAT, 4), system(HEARTBEAT, 5)]);
});

test("other models get the context untouched, so they read the wrapped envelope as before", () => {
  const messages = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  assert.equal(projectWakes(messages, { native: false }), messages);
  const plain = [PROMPT, user("hi", 2)];
  assert.equal(projectWakes(plain, { native: true }), plain);
});

test("a turn's projection never changes when the conversation goes on, so the cached prefix holds", () => {
  const then = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  const later = [...then, answer("Nothing new.", 5), user("thanks", 6), answer("any time", 7), wake("heartbeat", HEARTBEAT, 8)];
  const before = projectWakes(then, { native: true });
  const after = projectWakes(later, { native: true });
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(JSON.stringify(after.slice(0, before.length)), JSON.stringify(before));
});

test("the extension projects a request's context by the model it goes to", async () => {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler), registerMessageRenderer() {}, registerTool() {},
    rpc: { handle() {}, emit() {} }, sendMessage() {} };
  installSessionLink(pi);
  const project = handlers.get("context_with_system");
  const messages = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  const native = await project({ messages }, { model: { compat: { supportsMidConvoSystemMessages: true } } });
  assert.deepEqual(native.messages.slice(-2), [anchor(4), system(HEARTBEAT, 4)]);
  assert.equal(await project({ messages }, { model: { compat: {} } }), undefined);
  assert.equal(await project({ messages }, {}), undefined);
  assert.equal(SESSION_MESSAGE_TYPE, messages[3].customType);
  assert.ok(DELIVER_REQUEST);
});

// The Anthropic request pi-ai builds from the projected context: the payload the provider gets.
const OPUS = { id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "http://127.0.0.1:9", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true } };

async function payloadFor(model, messages) {
  const controller = new AbortController();
  let payload;
  const native = model.compat.supportsMidConvoSystemMessages === true;
  const events = stream(model, { messages: convertToLlm(projectWakes(messages, { native })) }, {
    apiKey: "sk-ant-api-test", signal: controller.signal,
    onPayload: (params) => { payload = structuredClone(params); controller.abort(); return params; } });
  await events.result();
  return payload;
}

test("Anthropic receives a heartbeat after an answer as the anchor and a system message, the prompt unchanged", async () => {
  const messages = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  const payload = await payloadFor(OPUS, messages);
  assert.deepEqual(payload.system.map((block) => block.text), ["You are Segno."]);
  const roles = payload.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "system", "system"]);
  assert.deepEqual(payload.messages[2].content.map((block) => block.text), [SYSTEM_ANCHOR]);
  assert.deepEqual(payload.messages[3].content.map((block) => block.text), [HEARTBEAT]);
  // The last one carries the turn's effort, as on every request to this model.
  assert.deepEqual(payload.messages[4].content, []);
  assert.ok(payload.messages[4].output_config);
});

test("a model without mid-conversation system messages receives the wrapped envelope as a user message", async () => {
  const sonnet = { ...OPUS, id: "claude-sonnet-5", compat: { ...OPUS.compat, supportsMidConvoSystemMessages: false } };
  const messages = [PROMPT, user("hi", 2), answer("hello", 3), wake("heartbeat", HEARTBEAT, 4)];
  const payload = await payloadFor(sonnet, messages);
  assert.deepEqual(payload.system.map((block) => block.text), ["You are Segno."]);
  const last = payload.messages.filter((message) => message.role !== "system").at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content.map((block) => block.text).join(""), /^<rubato_wake what="heartbeat">/);
  assert.ok(!payload.messages.some((message) => message.role === "system" && message.content.length > 0));
});
