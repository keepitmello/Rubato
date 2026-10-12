import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  createCodexReasoningReplay,
  FAILURES_BEFORE_DROP,
} from "../../src/codex-reasoning-replay.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";

const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const SERVER_ERROR = "Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 006d190e in your message.";

function turn(timestamp, { thinking = true } = {}) {
  return {
    role: "assistant",
    api: codex.api,
    provider: codex.provider,
    model: codex.id,
    timestamp,
    content: [
      ...(thinking ? [{ type: "thinking", thinking: "plan", thinkingSignature: JSON.stringify({ type: "reasoning", id: `rs_${timestamp}`, encrypted_content: "gAAAA" }) }] : []),
      { type: "toolCall", id: `call_${timestamp}`, name: "read", arguments: { path: "a.md" } },
    ],
  };
}

function context(...turns) {
  return { messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }, ...turns] };
}

const failed = { role: "assistant", stopReason: "error", errorMessage: SERVER_ERROR, content: [] };
const ok = { role: "assistant", stopReason: "toolUse", content: [] };
const thinkingOf = (ctx) => ctx.messages.filter((m) => m.role === "assistant")
  .map((m) => m.content.some((block) => block.type === "thinking"));

test("one server error keeps the reasoning; consecutive ones drop the reasoning sent so far", () => {
  const replay = createCodexReasoningReplay();
  const sent = context(turn(10), turn(20));

  replay.observe(codex, sent, "s1", failed);
  assert.equal(replay.prepare(codex, sent, "s1"), sent, "a single failure can be transient");

  for (let i = 1; i < FAILURES_BEFORE_DROP; i += 1) replay.observe(codex, sent, "s1", failed);
  const next = replay.prepare(codex, context(turn(10), turn(20), turn(30)), "s1");
  assert.deepEqual(thinkingOf(next), [false, false, true], "reasoning after the failure is sent again");
  assert.deepEqual(next.messages[1].content.map((block) => block.type), ["toolCall"], "tool calls stay");
});

test("the dropped reasoning stays dropped, so the request prefix stays the same", () => {
  const replay = createCodexReasoningReplay();
  const sent = context(turn(10));
  for (let i = 0; i < FAILURES_BEFORE_DROP; i += 1) replay.observe(codex, sent, "s1", failed);
  replay.observe(codex, sent, "s1", ok);

  const later = replay.prepare(codex, context(turn(10), turn(20)), "s1");
  assert.deepEqual(thinkingOf(later), [false, true]);
});

test("a success in between resets the count, and other errors, sessions and providers do not count", () => {
  const replay = createCodexReasoningReplay();
  const sent = context(turn(10));

  replay.observe(codex, sent, "s1", failed);
  replay.observe(codex, sent, "s1", ok);
  replay.observe(codex, sent, "s1", failed);
  replay.observe(codex, sent, "s1", { ...failed, errorMessage: "WebSocket closed 1000" });
  replay.observe(codex, sent, "s2", failed);
  replay.observe({ ...codex, api: "anthropic-messages" }, sent, "s1", failed);
  assert.equal(replay.prepare(codex, sent, "s1"), sent);

  for (let i = 0; i < FAILURES_BEFORE_DROP; i += 1) replay.observe(codex, sent, "s1", failed);
  assert.equal(replay.prepare(codex, sent, "s2"), sent, "another session keeps its reasoning");
  assert.equal(replay.prepare({ ...codex, api: "anthropic-messages" }, sent, "s1"), sent);
});

test("through the stream decorator, the retry after consecutive server errors goes out without old reasoning", async () => {
  const replay = createCodexReasoningReplay();
  const received = [];
  const results = [failed, failed, ok];
  const inner = (_model, ctx) => {
    received.push(ctx);
    const message = { ...results[received.length - 1], timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push(message.stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  const decorated = withRubatoStream(inner);
  const sent = context(turn(10), turn(20));

  for (let i = 0; i < results.length; i += 1) {
    const stream = decorated(codex, sent, { sessionId: "s1", codexReasoningReplay: replay });
    for await (const _event of stream) { /* drain */ }
    await stream.result();
  }

  assert.deepEqual(received.map(thinkingOf), [[true, true], [true, true], [false, false]]);
});
