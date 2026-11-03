// Anthropic message threads at the fetch boundary: what goes on the wire, when a request
// continues a thread, and that every thread failure ends in a request that works.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_ROUTE_RATIO,
  MESSAGE_THREADS_BETA,
  MESSAGE_THREADS_SETTING,
  THREAD_COMPACTION_TRIGGER,
  THREAD_PRESUMED_LIFETIME_MS,
  createMessageThreads,
  messageThreadsEnabled,
  threadCompactionEdit,
} from "../../src/anthropic-message-threads.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";

const URL_MESSAGES = "https://api.anthropic.com/v1/messages";
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";
const CC = { type: "ephemeral", ttl: "1h" };
const MODEL = "claude-opus-5-5";

function user(text, { cache = false } = {}) {
  return { role: "user", content: [{ type: "text", text, ...(cache ? { cache_control: CC } : {}) }] };
}
function answer(text, toolIds = []) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hm", signature: "sig" },
      { type: "text", text },
      ...toolIds.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })),
    ],
  };
}

/** A request the way Pi builds it: system and tools breakpoints, and one on the newest user turn. */
function request(messages, extra = {}) {
  const last = messages.length - 1;
  return {
    model: MODEL,
    max_tokens: 32000,
    stream: true,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: "billing" }, { type: "text", text: "You are Claude Code", cache_control: CC }, { type: "text", text: "rubato", cache_control: CC }],
    tools: [{ name: "Read", input_schema: { type: "object" }, cache_control: CC }],
    messages: messages.map((message, index) => (index === last && message.role === "user"
      ? { ...message, content: message.content.map((block, at) => (at === message.content.length - 1 ? { ...block, cache_control: CC } : block)) }
      : message)),
    ...extra,
  };
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function streamed({ id, text = "", toolIds = [], stopReason = "end_turn", model = MODEL, usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 20 } }) {
  const events = [
    { type: "message_start", message: { id, model, usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, 2) } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(2) } },
    { type: "content_block_stop", index: 1 },
    ...toolIds.flatMap((toolId, at) => [
      { type: "content_block_start", index: 2 + at, content_block: { type: "tool_use", id: toolId, name: "Read", input: {} } },
      { type: "content_block_stop", index: 2 + at },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
  return sse(events);
}

function apiError(status, code, message = "thread problem") {
  return new Response(JSON.stringify({ type: "error", error: { type: status === 404 ? "not_found_error" : "invalid_request_error", message, ...(code ? { details: { error_code: code } } : {}) } }), { status, headers: { "content-type": "application/json" } });
}

/** A fake API: answers each call with the next scripted reply and records what was sent. */
function harness(replies, { clock = { now: 1_000_000 }, env = {} } = {}) {
  const sent = [];
  const base = async (_url, init) => {
    sent.push({ body: JSON.parse(init.body), headers: init.headers });
    const reply = replies.shift();
    if (reply instanceof Response) return reply;
    return new Response(reply, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const threads = createMessageThreads({ now: () => clock.now, env });
  const fetchImpl = threads.wrapFetch(base);
  const call = async (body, headers = { authorization: "Bearer sub-a", "anthropic-beta": OAUTH_BETAS }) => {
    const response = await fetchImpl(URL_MESSAGES, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    return { response, text };
  };
  return { sent, call, clock, threads };
}

function betas(headers) {
  const value = typeof headers?.get === "function" ? headers.get("anthropic-beta") : headers?.["anthropic-beta"];
  return String(value ?? "").split(",");
}

function hasCacheControl(value) {
  return JSON.stringify(value).includes("cache_control");
}

test("the first request creates a thread with the whole conversation and one top-level breakpoint", async () => {
  const { sent, call } = harness([streamed({ id: "msg_1", text: "hello" })]);
  const { text } = await call(request([user("hi")]));

  assert.match(text, /message_stop/, "the stream reaches Pi byte for byte");
  const wire = sent[0].body;
  assert.deepEqual(wire.thread, { type: "create" });
  assert.ok(betas(sent[0].headers).includes(MESSAGE_THREADS_BETA));
  assert.ok(betas(sent[0].headers).includes("oauth-2025-04-20"));
  assert.deepEqual(wire.cache_control, CC);
  assert.equal(hasCacheControl(wire.messages), false, "a thread cannot move a message breakpoint, so none is sent");
  assert.equal(wire.system.length, 3);
  assert.equal(wire.tools.length, 1);
});

test("the next turn sends only what is new, without system and tools, from the previous response id", async () => {
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello", toolIds: ["toolu_1"], stopReason: "tool_use" }),
    streamed({ id: "msg_2", text: "done" }),
    streamed({ id: "msg_3", text: "bye" }),
  ]);
  await call(request([user("hi")]));
  const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file" }] };
  await call(request([user("hi"), answer("hello", ["toolu_1"]), toolResult]));
  await call(request([user("hi"), answer("hello", ["toolu_1"]), toolResult, answer("done"), user("next")]));

  const second = sent[1].body;
  assert.deepEqual(second.thread, { type: "continue", previous_message_id: "msg_1" });
  assert.equal(second.system, undefined);
  assert.equal(second.tools, undefined);
  assert.deepEqual(second.messages, [toolResult]);
  assert.deepEqual(second.cache_control, CC, "the top-level breakpoint is a fixed field: same on every request");
  assert.deepEqual(second.thinking, { type: "adaptive" });
  assert.ok(betas(sent[1].headers).includes(MESSAGE_THREADS_BETA));

  const third = sent[2].body;
  assert.deepEqual(third.thread, { type: "continue", previous_message_id: "msg_2" });
  assert.deepEqual(third.messages, [user("next")]);
});

test("a replay whose answer differs from what was streamed starts a new thread", async () => {
  const { sent, call } = harness([streamed({ id: "msg_1", text: "hello" }), streamed({ id: "msg_2", text: "x" })]);
  await call(request([user("hi")]));
  await call(request([user("hi"), answer("hello, edited"), user("next")]));
  assert.deepEqual(sent[1].body.thread, { type: "create" });
  assert.equal(sent[1].body.messages.length, 3);
});

test("an earlier message rewritten, a model switch or another account starts a new thread", async () => {
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello" }),
    streamed({ id: "msg_2", text: "x" }),
    streamed({ id: "msg_3", text: "y" }),
  ]);
  await call(request([user("hi")]));
  await call(request([user("HI"), answer("hello"), user("next")]));
  assert.deepEqual(sent[1].body.thread, { type: "create" });
  await call(request([user("HI"), answer("hello"), user("next"), answer("x"), user("more")]), { authorization: "Bearer sub-b", "anthropic-beta": OAUTH_BETAS });
  assert.deepEqual(sent[2].body.thread, { type: "create" }, "a thread belongs to the account that made it");
});

test("a thread idle past its presumed lifetime is recreated instead of continued", async () => {
  const { sent, call, clock } = harness([streamed({ id: "msg_1", text: "hello" }), streamed({ id: "msg_2", text: "x" })]);
  await call(request([user("hi")]));
  clock.now += THREAD_PRESUMED_LIFETIME_MS;
  await call(request([user("hi"), answer("hello"), user("next")]));
  assert.deepEqual(sent[1].body.thread, { type: "create" });
});

test("a continue the API cannot serve is resent as a create in the same call", async () => {
  for (const failure of [
    () => apiError(404, "thread_not_found"),
    () => apiError(400, "thread_already_continued"),
    () => apiError(400, "thread_fingerprint_mismatch"),
    () => apiError(400, undefined, "messages: a thread continue cannot start with this block"),
  ]) {
    const { sent, call } = harness([
      streamed({ id: "msg_1", text: "hello" }),
      streamed({ id: "msg_2", text: "x" }),
      failure(),
      streamed({ id: "msg_3", text: "ok" }),
    ]);
    await call(request([user("hi")]));
    await call(request([user("hi"), answer("hello"), user("next")]));
    const { response, text } = await call(request([user("hi"), answer("hello"), user("next"), answer("x"), user("more")]));
    assert.equal(response.status, 200);
    assert.match(text, /ok/);
    assert.equal(sent[2].body.thread.type, "continue");
    assert.deepEqual(sent[3].body.thread, { type: "create" });
    assert.equal(sent[3].body.messages.length, 5);
    assert.equal(sent[3].body.system.length, 3);
  }
});

test("a thread gone right after its create means the API is not storing this conversation: it stays unthreaded", async () => {
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello" }),
    apiError(404, "thread_not_found"),
    streamed({ id: "msg_2", text: "x" }),
    streamed({ id: "msg_3", text: "y" }),
  ]);
  await call(request([user("hi")]));
  const second = request([user("hi"), answer("hello"), user("next")]);
  const { response } = await call(second);
  assert.equal(response.status, 200);
  assert.deepEqual(sent[2].body, second, "straight to today's request, no create that would 404 again");
  await call(request([user("hi"), answer("hello"), user("next"), answer("x"), user("more")]));
  assert.equal(sent[3].body.thread, undefined);
  assert.equal(sent.length, 4, "no more wasted round trips");
});

test("a 404 for an unknown model is returned as is, not replayed", async () => {
  const { sent, call } = harness([streamed({ id: "msg_1", text: "hello" }), apiError(404, undefined, "model: claude-x not found")]);
  await call(request([user("hi")]));
  const { response } = await call(request([user("hi"), answer("hello"), user("next")]));
  assert.equal(response.status, 404);
  assert.equal(sent.length, 2);
});

test("a create the API refuses for threads goes out unthreaded, and that account and model stay unthreaded", async () => {
  const { sent, call } = harness([
    apiError(400, "thread_unsupported_request"),
    streamed({ id: "msg_1", text: "hello" }),
    streamed({ id: "msg_2", text: "x" }),
  ]);
  const original = request([user("hi")]);
  const { response } = await call(original);
  assert.equal(response.status, 200);
  assert.deepEqual(sent[1].body, original, "the fallback is exactly today's request");
  assert.equal(betas(sent[1].headers).includes(MESSAGE_THREADS_BETA), false);
  await call(request([user("hi"), answer("hello"), user("next")]));
  assert.equal(sent[2].body.thread, undefined);
});

test("any other 400 on a threaded request is resent as today's request, which carries Rubato's compaction", async () => {
  const original = request([user("hi")], { context_management: { edits: [compactEdit(900_000)] } });
  const { sent, call } = harness([
    apiError(400, undefined, "prompt is too long: 1000500 tokens > 1000000 maximum"),
    streamed({ id: "msg_1", text: "compacted" }),
    streamed({ id: "msg_2", text: "x" }),
  ]);
  const { response } = await call(original);
  assert.equal(response.status, 200);
  assert.deepEqual(sent[1].body, original, "the retry is exactly today's request, guidance included");
  await call(request([user("other")], { context_management: { edits: [compactEdit(900_000)] } }));
  assert.deepEqual(sent[2].body.thread, { type: "create" }, "not a thread problem: threads stay on");

  const failing = harness([
    streamed({ id: "msg_1", text: "hello" }),
    apiError(400, undefined, "prompt is too long"),
    apiError(400, undefined, "prompt is too long"),
  ]);
  await failing.call(request([user("hi")]));
  const { response: last, text } = await failing.call(request([user("hi"), answer("hello"), user("next")]));
  assert.equal(last.status, 400);
  assert.match(text, /prompt is too long/, "when today's request fails too, Pi sees that error");
  assert.equal(failing.sent[1].body.thread.type, "continue");
  assert.equal(failing.sent[2].body.thread, undefined, "a non-thread error skips the create");
});

test("the compaction line is judged with the tokens per byte this conversation measured", async () => {
  const trigger = 100_000;
  const body = (messages) => request(messages, { context_management: { edits: [compactEdit(trigger)] } });
  const first = body([user("x".repeat(20_000)), answer("a"), user("b")]);
  // The first request measured dense: as many tokens as the line itself for its bytes.
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello", usage: { input_tokens: 10, cache_read_input_tokens: trigger, cache_creation_input_tokens: 0, output_tokens: 10 } }),
    streamed({ id: "msg_2", text: "x" }),
  ]);
  await call(first);
  assert.equal(sent[0].body.thread.type, "create", "unmeasured, 20 KB reads as about 10k tokens");
  // An earlier message changed, so there is no previous answer to count from: the measured ratio decides.
  await call(body([user("x".repeat(20_000)), answer("a, edited"), user("b"), answer("hello"), user("next")]));
  assert.equal(sent[1].body.thread, undefined, "at the measured density the same bytes reach the line");
});

test("an answer the API does not keep (refusal, max_tokens, fallback model) is not continued", async () => {
  for (const reply of [
    { id: "msg_1", text: "hello", stopReason: "refusal" },
    { id: "msg_1", text: "hello", stopReason: "max_tokens" },
    { id: "msg_1", text: "hello", stopReason: "pause_turn" },
    { id: "msg_1", text: "hello", model: "claude-sonnet-5-5" },
  ]) {
    const { sent, call } = harness([streamed(reply), streamed({ id: "msg_2", text: "x" })]);
    await call(request([user("hi")]));
    await call(request([user("hi"), answer("hello"), user("next")]));
    assert.deepEqual(sent[1].body.thread, { type: "create" }, JSON.stringify(reply));
  }
});

test("a stream that ends before message_stop leaves nothing to continue", async () => {
  const cut = streamed({ id: "msg_1", text: "hello" }).split("event: message_stop")[0];
  const { sent, call } = harness([cut, streamed({ id: "msg_2", text: "x" })]);
  await call(request([user("hi")]));
  await call(request([user("hi"), answer("hello"), user("next")]));
  assert.deepEqual(sent[1].body.thread, { type: "create" });
});

test("a response id is continued once: a retry of the same turn creates", async () => {
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello" }),
    new Response("overloaded", { status: 529 }),
    streamed({ id: "msg_2", text: "x" }),
  ]);
  await call(request([user("hi")]));
  const next = request([user("hi"), answer("hello"), user("next")]);
  const { response } = await call(next);
  assert.equal(response.status, 529, "a non-thread error goes back to Pi's own retry");
  await call(next);
  assert.equal(sent[1].body.thread.type, "continue");
  assert.deepEqual(sent[2].body.thread, { type: "create" });
});

test("cache-warming replays and requests that already name a thread pass through untouched", async () => {
  const { sent, call } = harness([streamed({ id: "w", text: "" }), streamed({ id: "t", text: "" })]);
  const warm = request([user("hi")], { max_tokens: 1 });
  await call(warm);
  assert.deepEqual(sent[0].body, warm);
  const own = request([user("hi")], { thread: { type: "create" } });
  await call(own);
  assert.deepEqual(sent[1].body, own);
});

test("the off switch sends today's request", async () => {
  const original = request([user("hi")]);
  const { sent, call } = harness([streamed({ id: "msg_1", text: "hello" })], { env: { RUBATO_MESSAGE_THREADS: "off" } });
  await call(original);
  assert.deepEqual(sent[0].body, original);

  const before = globalThis[MESSAGE_THREADS_SETTING];
  try {
    globalThis[MESSAGE_THREADS_SETTING] = () => false;
    assert.equal(messageThreadsEnabled({}), false, "providers.messageThreads: false");
    assert.equal(messageThreadsEnabled({ RUBATO_MESSAGE_THREADS: "on" }), true, "the environment wins");
    globalThis[MESSAGE_THREADS_SETTING] = () => true;
    assert.equal(messageThreadsEnabled({}), true);
  } finally {
    globalThis[MESSAGE_THREADS_SETTING] = before;
  }
});

function compactEdit(trigger) {
  return { type: "compact_20260112", instructions: "Rubato briefing guidance", trigger: { type: "input_tokens", value: trigger } };
}

test("threaded requests carry the compact edit a thread accepts, which never summarizes", async () => {
  const { sent, call } = harness([streamed({ id: "msg_1", text: "hello" }), streamed({ id: "msg_2", text: "x" })]);
  const management = { context_management: { edits: [compactEdit(900_000)] } };
  await call(request([user("hi")], management));
  await call(request([user("hi"), answer("hello"), user("next")], management));
  for (const { body } of sent) {
    assert.deepEqual(body.context_management, { edits: [threadCompactionEdit()] });
    assert.equal(body.context_management.edits[0].instructions, undefined);
    assert.equal(body.context_management.edits[0].trigger.value, THREAD_COMPACTION_TRIGGER);
  }
  assert.equal(sent[1].body.thread.type, "continue");
});

test("a request near the compaction line goes out unthreaded with Rubato's guidance, and so does the compacted conversation", async () => {
  const trigger = 100_000;
  const near = Math.ceil(trigger * COMPACTION_ROUTE_RATIO);
  const { sent, call } = harness([
    streamed({ id: "msg_1", text: "hello", usage: { input_tokens: 10, cache_read_input_tokens: near, cache_creation_input_tokens: 0, output_tokens: 10 } }),
    streamed({ id: "msg_2", text: "summarized" }),
    streamed({ id: "msg_3", text: "fresh" }),
  ]);
  const management = { context_management: { edits: [compactEdit(trigger)] } };
  await call(request([user("hi")], management));
  assert.equal(sent[0].body.thread.type, "create");

  const nearLine = request([user("hi"), answer("hello"), user("next")], management);
  await call(nearLine);
  assert.deepEqual(sent[1].body, nearLine, "exactly today's request: the summary keeps Rubato's guidance");
  assert.equal(betas(sent[1].headers).includes(MESSAGE_THREADS_BETA), false);

  // The server compacted inside that answer. The API never stores a thread that holds a real
  // compaction block, so the conversation goes on as today's requests.
  const compacted = { role: "assistant", content: [{ type: "compaction", content: "summary" }, { type: "text", text: "summarized" }] };
  const after = request([user("hi"), answer("hello"), user("next"), compacted, user("again")], management);
  await call(after);
  assert.deepEqual(sent[2].body, after);
});

test("other context-management edits and too many breakpoints keep today's request", async () => {
  const { sent, call } = harness([streamed({ id: "a" }), streamed({ id: "b" })]);
  const clearing = request([user("hi")], { context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } });
  await call(clearing);
  assert.deepEqual(sent[0].body, clearing);
  const crowded = request([user("hi")]);
  crowded.system = crowded.system.map((block) => ({ ...block, cache_control: CC }));
  crowded.tools.push({ name: "Write", input_schema: { type: "object" }, cache_control: CC });
  await call(crowded);
  assert.deepEqual(sent[1].body, crowded);
});

test("withRubatoStream puts threads under every other Anthropic rewrite", async () => {
  const seen = [];
  const inner = (_model, _context, options) => ({
    async *[Symbol.asyncIterator]() {
      await options.fetch(URL_MESSAGES, { method: "POST", headers: { authorization: "Bearer x", "anthropic-beta": OAUTH_BETAS }, body: JSON.stringify(request([user("hi")])) });
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
    },
    result: async () => ({ role: "assistant", content: [], stopReason: "stop" }),
  });
  const stream = withRubatoStream(inner)(
    { provider: "anthropic", id: MODEL, api: "anthropic-messages" },
    { messages: [] },
    {
      env: {},
      sessionId: "wired",
      measurementRecorder: { startCall: () => ({ callId: "c" }), firstOutput() {}, endCall() {} },
      messageThreads: createMessageThreads({ env: {} }),
      fetch: async (_url, init) => {
        seen.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      },
    },
  );
  for await (const _event of stream) { /* drain */ }
  assert.deepEqual(seen[0].thread, { type: "create" });

  seen.length = 0;
  const off = withRubatoStream(inner)(
    { provider: "anthropic", id: MODEL, api: "anthropic-messages" },
    { messages: [] },
    {
      env: { RUBATO_MESSAGE_THREADS: "off" },
      sessionId: "wired-off",
      measurementRecorder: { startCall: () => ({ callId: "c" }), firstOutput() {}, endCall() {} },
      messageThreads: createMessageThreads({ env: {} }),
      fetch: async (_url, init) => {
        seen.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      },
    },
  );
  for await (const _event of off) { /* drain */ }
  assert.equal(seen[0].thread, undefined, "the session's own environment decides");
});
