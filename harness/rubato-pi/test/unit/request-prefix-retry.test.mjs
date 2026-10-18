import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";
import { REQUEST_WIRE_BYTE_LIMIT, REQUEST_BYTE_REFUSAL } from "../../src/context-notes/request-budget.mjs";

const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);
const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const context = { messages: [{ role: "assistant", content: [
  { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ id: "rs_1", encrypted_content: "synthetic" }) },
] }] };

test("repeated Codex server errors never delete or probe previously sent reasoning", async () => {
  const received = [];
  const decorated = withRubatoStream((_model, ctx) => {
    received.push(JSON.stringify(ctx));
    const message = { role: "assistant", content: [], stopReason: "error",
      errorMessage: "An error occurred while processing your request", timestamp: 1 };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  });
  for (let n = 0; n < 5; n++) {
    const stream = decorated(codex, context, { sessionId: "prefix-retry-test" });
    for await (const _event of stream) { /* drain */ }
    await stream.result();
  }
  assert.deepEqual(received, Array(5).fill(JSON.stringify(context)));
});

test("wire guard checks final async onPayload replacement even without metrics enabled", async () => {
  let captured;
  const decorated = withRubatoStream((_model, _ctx, options) => { captured = options; return {}; });
  decorated(codex, context, { speedIndexStore: false,
    onPayload: async () => ({ input: "x".repeat(REQUEST_WIRE_BYTE_LIMIT) }) });
  await assert.rejects(captured.onPayload({ input: "small" }, codex), new RegExp(REQUEST_BYTE_REFUSAL));
});

test("Cursor guards encoded protobuf bytes without JSON-stringifying BigInt or binary fields", async () => {
  let captured;
  const decorated = withRubatoStream((_model, _ctx, options) => { captured = options; return {}; });
  const cursor = { provider: "cursor", api: "cursor-agent", id: "synthetic" };
  decorated(cursor, context, { speedIndexStore: false });
  assert.doesNotThrow(() => captured.onPayload({ timing: 1n, image: Uint8Array.of(1) }, cursor));
  assert.doesNotThrow(() => captured.onRubatoWireBytes(10));
  assert.throws(() => captured.onRubatoWireBytes(REQUEST_WIRE_BYTE_LIMIT), new RegExp(REQUEST_BYTE_REFUSAL));
});
