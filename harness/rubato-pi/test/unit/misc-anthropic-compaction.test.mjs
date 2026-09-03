import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { senpiNested } from "../../src/engine-paths.mjs";
import { isAnthropicCompactionBlock } from "../../src/anthropic-server-compaction.mjs";
import {
  injectAnthropicCompaction,
  isAnthropicCompactionUrl,
} from "../../src/transforms/misc-anthropic-compaction.mjs";

const ADAPTER = senpiNested("@earendil-works/pi-ai/dist/api/anthropic-messages.js");

test("pristine needles, patched output, second inject throws, URL matcher", () => {
  const source = readFileSync(ADAPTER, "utf8");
  assert.match(source, /const REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES = new Set\(\[/);
  assert.match(source, /subtype: event\.content_block\.type,\n\s+raw: event\.content_block,/);
  assert.match(source, /else if \(event\.delta\.type === "signature_delta"\)/);
  assert.match(source, /isReplayableAnthropicProviderNativeBlock\(block\.raw\)/);
  assert.doesNotMatch(source, /compaction_delta/);
  const next = injectAnthropicCompaction(source);
  assert.match(next, /"compaction",/);
  assert.match(next, /event\.content_block\.type === "compaction"/);
  assert.match(next, /event\.delta\.type === "compaction_delta"/);
  assert.match(next, /applyAnthropicCompactionUsage/);
  assert.match(next, /shouldOmitThinkingBeforeCompaction/);
  assert.match(next, /blocks\.push\(\{ type: "compaction", content \}\)/);
  assert.throws(() => injectAnthropicCompaction(next));
  assert.equal(isAnthropicCompactionUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), true);
  assert.equal(isAnthropicCompactionUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js"), false);
});

function sse(events) {
  const parts = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  parts.push("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
}

function usagePayload({ input = 100, output = 20, cacheRead = 10, cacheWrite = 5, compaction } = {}) {
  const payload = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
  if (compaction) {
    payload.iterations = [
      {
        type: "compaction",
        input_tokens: compaction.input,
        output_tokens: compaction.output,
        cache_read_input_tokens: compaction.cacheRead ?? 0,
        cache_creation_input_tokens: compaction.cacheWrite ?? 0,
        ...(compaction.cacheWrite1h ? { cache_creation: { ephemeral_5m_input_tokens: (compaction.cacheWrite ?? 0) - compaction.cacheWrite1h, ephemeral_1h_input_tokens: compaction.cacheWrite1h } } : {}),
      },
      { type: "message", input_tokens: input, output_tokens: output },
    ];
  }
  return payload;
}

function modelOf(id) {
  return {
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    maxTokens: 128000,
    contextWindow: 1000000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    compat: {},
  };
}

function assistantMeta(id) {
  return { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: id };
}

async function loadAdapter() {
  return import(pathToFileURL(ADAPTER).href);
}

async function runStream(adapter, { model, messages, events, onParams }) {
  const client = {
    messages: {
      create(params) {
        onParams?.(params);
        return { asResponse: async () => sse(events) };
      },
    },
  };
  return adapter.stream(model, { messages, systemPrompt: "sys" }, {
    client,
    apiKey: "test-key",
    thinkingEnabled: true,
    cacheRetention: "none",
    maxTokens: 64,
  }).result();
}

const COMPACTION_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: usagePayload({ compaction: { input: 80000, output: 400 } }),
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "compaction" } },
  { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "summary of earlier turns" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: usagePayload({ compaction: { input: 80000, output: 400 } }),
  },
];

test("patched adapter keeps compaction block, usage.compaction, and cost", async () => {
  const adapter = await loadAdapter();
  const message = await runStream(adapter, {
    model: modelOf("claude-opus-5"),
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    events: COMPACTION_EVENTS,
  });
  const block = message.content.find((item) => item.subtype === "compaction");
  assert.equal(isAnthropicCompactionBlock(block), true);
  assert.deepEqual(block.raw, { type: "compaction", content: "summary of earlier turns" });
  assert.equal(message.usage.input, 100);
  assert.equal(message.usage.output, 20);
  assert.deepEqual(message.usage.compaction, { input: 80000, output: 400, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  const top = (5 * 100 + 25 * 20 + 0.5 * 10 + 6.25 * 5) / 1_000_000;
  const extra = (5 * 80000 + 25 * 400) / 1_000_000;
  assert.ok(Math.abs(message.usage.cost.total - (top + extra)) < 1e-12);
});

test("compaction iteration 1h cache writes are costed at the 1h rate", async () => {
  const adapter = await loadAdapter();
  const compaction = { input: 45, output: 1200, cacheWrite: 181854, cacheWrite1h: 100000 };
  const message = await runStream(adapter, {
    model: modelOf("claude-fable-5-1"),
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    events: [
      { type: "message_start", message: { id: "msg_1h", model: "claude-fable-5-1", usage: usagePayload({ compaction }) } },
      { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "s" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload({ compaction }) },
    ],
  });
  assert.deepEqual(message.usage.compaction, { input: 45, output: 1200, cacheRead: 0, cacheWrite: 181854, cacheWrite1h: 100000 });
  const top = (5 * 100 + 25 * 20 + 0.5 * 10 + 6.25 * 5) / 1_000_000;
  // pinned calculateCost: 5m 쓰기는 cacheWrite 단가, 1h 쓰기는 input 단가의 2 배.
  const extra = (5 * 45 + 25 * 1200 + 6.25 * (181854 - 100000) + 2 * 5 * 100000) / 1_000_000;
  assert.ok(Math.abs(message.usage.cost.total - (top + extra)) < 1e-9, `${message.usage.cost.total} vs ${top + extra}`);
});

test("patched adapter keeps content null and does not throw", async () => {
  const adapter = await loadAdapter();
  const message = await runStream(adapter, {
    model: modelOf("claude-opus-5"),
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    events: [
      { type: "message_start", message: { id: "msg_2", model: "claude-opus-5", usage: usagePayload() } },
      { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } },
      { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: null } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload() },
    ],
  });
  const block = message.content.find((item) => item.subtype === "compaction");
  assert.equal(isAnthropicCompactionBlock(block), true);
  assert.equal(block.raw.content, null);
});

test("convertMessages strips thinking before the latest compaction on the same Anthropic model", async () => {
  const adapter = await loadAdapter();
  let captured;
  await runStream(adapter, {
    model: modelOf("claude-opus-5"),
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        ...assistantMeta("claude-opus-5"),
        content: [
          { type: "thinking", thinking: "old plan", thinkingSignature: "sig-old" },
          { type: "text", text: "before compact" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        ...assistantMeta("claude-opus-5"),
        content: [
          { type: "thinking", thinking: "pre-compact thought", thinkingSignature: "sig-pre" },
          { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "kept summary" } },
          { type: "thinking", thinking: "post-compact thought", thinkingSignature: "sig-post" },
          { type: "text", text: "after compact" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
    events: [
      { type: "message_start", message: { id: "msg_3", model: "claude-sonnet-5", usage: usagePayload() } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload() },
    ],
    onParams: (params) => { captured = params; },
  });
  assert.ok(captured);
  const assistants = captured.messages.filter((msg) => msg.role === "assistant");
  assert.equal(assistants.some((msg) => msg.content.some((block) => block.type === "thinking" && block.thinking === "old plan")), false);
  assert.equal(assistants.some((msg) => msg.content.some((block) => block.type === "thinking" && block.thinking === "pre-compact thought")), false);
  const compacted = assistants.find((msg) => msg.content.some((block) => block.type === "compaction"));
  assert.ok(compacted);
  assert.deepEqual(compacted.content.find((block) => block.type === "compaction"), { type: "compaction", content: "kept summary" });
  assert.equal(compacted.content.some((block) => block.type === "thinking" && block.thinking === "post-compact thought"), true);
  assert.equal(compacted.content.some((block) => block.type === "text" && block.text === "after compact"), true);
  assert.equal(JSON.stringify(compacted.content.find((block) => block.type === "compaction")).includes("cache_control"), false);
});

test("convertMessages replays compaction onto a different Anthropic model id", async () => {
  const adapter = await loadAdapter();
  let captured;
  await runStream(adapter, {
    model: modelOf("claude-sonnet-5"),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        ...assistantMeta("claude-opus-5"),
        content: [
          { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "cross-model summary" } },
          { type: "text", text: "after" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
    events: [
      { type: "message_start", message: { id: "msg_3b", model: "claude-sonnet-5", usage: usagePayload() } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload() },
    ],
    onParams: (params) => { captured = params; },
  });
  const assistants = captured.messages.filter((msg) => msg.role === "assistant");
  const compacted = assistants.find((msg) => msg.content.some((block) => block.type === "compaction"));
  assert.ok(compacted);
  assert.deepEqual(compacted.content.find((block) => block.type === "compaction"), { type: "compaction", content: "cross-model summary" });
});

test("convertMessages does not replay the native block onto Haiku 4.5 (unsupported Anthropic model)", async () => {
  const adapter = await loadAdapter();
  let captured;
  await runStream(adapter, {
    model: modelOf("claude-haiku-4-5"),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        ...assistantMeta("claude-fable-5-1"),
        content: [
          { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "fable summary" } },
          { type: "text", text: "after" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
    events: [
      { type: "message_start", message: { id: "msg_h", model: "claude-haiku-4-5", usage: usagePayload() } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload() },
    ],
    onParams: (params) => { captured = params; },
  });
  assert.equal(JSON.stringify(captured.messages).includes('"type":"compaction"'), false);
  assert.equal(captured.messages.some((msg) => msg.role === "assistant" && msg.content.some((block) => block.type === "text" && block.text === "after")), true);
});

test("convertMessages drops compaction with null/empty content", async () => {
  const adapter = await loadAdapter();
  let captured;
  await runStream(adapter, {
    model: modelOf("claude-opus-5"),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        ...assistantMeta("claude-opus-5"),
        content: [
          { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: null } },
          { type: "text", text: "still here" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
    events: [
      { type: "message_start", message: { id: "msg_4", model: "claude-opus-5", usage: usagePayload() } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usagePayload() },
    ],
    onParams: (params) => { captured = params; },
  });
  const assistants = captured.messages.filter((msg) => msg.role === "assistant");
  assert.equal(assistants.some((msg) => msg.content.some((block) => block.type === "compaction")), false);
  assert.equal(assistants.some((msg) => msg.content.some((block) => block.type === "text" && block.text === "still here")), true);
});
