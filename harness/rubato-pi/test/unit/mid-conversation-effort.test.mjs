import assert from "node:assert/strict";
import test from "node:test";
import {
  MID_CONVERSATION_EFFORT_BETA,
  appendMidConversationEffortBeta,
  createMidConversationEffort,
  nextEffortSessionState,
} from "../../src/mid-conversation-effort.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function body({ model = "claude-fable-5-1", effort = "high", messages, extra } = {}) {
  return {
    model,
    max_tokens: 64,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: [{ type: "text", text: "sys" }],
    messages: messages ?? [user("hi")],
    stream: true,
    ...extra,
  };
}

function systemMark(effort) {
  return { role: "system", content: [], output_config: { effort } };
}

async function send(fetchImpl, payload, { headers = { "anthropic-beta": OAUTH_BETAS }, url = MESSAGES_URL } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const init = { method: "POST", headers, body: raw };
  const response = await fetchImpl(url, init);
  return { init, raw, response };
}

function createHarness() {
  const seen = [];
  const effort = createMidConversationEffort();
  const fetchImpl = effort.wrapFetch(async (url, init) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  }, { sessionId: "sess-1", provider: "anthropic" });
  return { seen, effort, fetchImpl };
}

test("gate pass-through is byte-identical for body and headers", async () => {
  const cases = [
    { label: "wrong model", payload: body({ model: "claude-fable-5" }) },
    { label: "sonnet", payload: body({ model: "claude-sonnet-5" }) },
    { label: "missing effort", payload: body({ extra: { output_config: { temperature: 1 } } }) },
  ];
  for (const { label, payload } of cases) {
    const { seen, fetchImpl } = createHarness();
    const headers = { "anthropic-beta": OAUTH_BETAS, "x-app": "cli" };
    const { raw, init } = await send(fetchImpl, payload, { headers });
    assert.equal(seen.length, 1, label);
    assert.equal(seen[0].init.body, raw, `${label}: body bytes`);
    assert.equal(seen[0].init.headers, init.headers, `${label}: headers reference`);
    assert.equal(seen[0].init, init, `${label}: init reference`);
  }

  const { seen, fetchImpl } = createHarness();
  const raw = JSON.stringify(body());
  const headers = { "anthropic-beta": OAUTH_BETAS };
  await fetchImpl("https://api.anthropic.com/v1/models", { method: "POST", headers, body: raw });
  assert.equal(seen[0].init.body, raw);
  assert.equal(seen[0].init.headers, headers);

  const kiro = createMidConversationEffort();
  const kiroSeen = [];
  const kiroFetch = kiro.wrapFetch(async (_url, init) => {
    kiroSeen.push(init);
    return new Response("{}");
  }, { sessionId: "s", provider: "kiro" });
  const kiroInit = { method: "POST", headers: { "anthropic-beta": OAUTH_BETAS }, body: JSON.stringify(body()) };
  await kiroFetch(MESSAGES_URL, kiroInit);
  assert.equal(kiroSeen[0], kiroInit);

  for (const provider of ["bedrock", "vertex", "google-antigravity"]) {
    const boxed = createMidConversationEffort();
    const captured = [];
    const wrap = boxed.wrapFetch(async (_url, init) => {
      captured.push(init);
      return new Response("{}");
    }, { sessionId: "s", provider });
    const init = { method: "POST", headers: { "anthropic-beta": OAUTH_BETAS }, body: JSON.stringify(body()) };
    await wrap(MESSAGES_URL, init);
    assert.equal(captured[0], init, provider);
  }
});

test("first request anchors base and leaves the body untouched", async () => {
  const { seen, effort, fetchImpl } = createHarness();
  const payload = body({ effort: "high", messages: [user("hi")] });
  const { raw } = await send(fetchImpl, payload);
  assert.equal(seen[0].init.body, raw);
  const state = effort.store.get("sess-1");
  assert.equal(state.baseEffort, "high");
  assert.deepEqual(state.marks, []);
  assert.ok(state.lineage.startsWith("claude-fable-5-1\n"));
});

test("a level change marks just before the last message and freezes top-level effort", async () => {
  const { seen, effort, fetchImpl } = createHarness();
  await send(fetchImpl, body({ effort: "high", messages: [user("hi")] }));
  const second = body({
    effort: "low",
    messages: [user("hi"), assistant("yo"), user("again")],
  });
  const keysBefore = Object.keys(second);
  await send(fetchImpl, second);
  const sent = JSON.parse(seen[1].init.body);
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.messages, [
    user("hi"),
    assistant("yo"),
    systemMark("low"),
    user("again"),
  ]);
  assert.deepEqual(Object.keys(sent), keysBefore);
  assert.deepEqual(effort.store.get("sess-1").marks, [{ index: 2, effort: "low" }]);
  assert.equal(seen[1].init.headers["anthropic-beta"], `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}`);
});

test("subsequent requests re-emit the same marks", async () => {
  const { seen, fetchImpl } = createHarness();
  await send(fetchImpl, body({ effort: "high", messages: [user("hi")] }));
  await send(fetchImpl, body({
    effort: "low",
    messages: [user("hi"), assistant("yo"), user("again")],
  }));
  await send(fetchImpl, body({
    effort: "low",
    messages: [user("hi"), assistant("yo"), user("again"), assistant("ok"), user("third")],
  }));
  const sent = JSON.parse(seen[2].init.body);
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.messages, [
    user("hi"),
    assistant("yo"),
    systemMark("low"),
    user("again"),
    assistant("ok"),
    user("third"),
  ]);
  assert.equal(seen[2].init.headers["anthropic-beta"], `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}`);
});

test("a second change adds a second mark", async () => {
  const { seen, effort, fetchImpl } = createHarness();
  await send(fetchImpl, body({ effort: "high", messages: [user("a")] }));
  await send(fetchImpl, body({
    effort: "low",
    messages: [user("a"), assistant("b"), user("c")],
  }));
  await send(fetchImpl, body({
    effort: "medium",
    messages: [user("a"), assistant("b"), user("c"), assistant("d"), user("e")],
  }));
  const sent = JSON.parse(seen[2].init.body);
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.messages, [
    user("a"),
    assistant("b"),
    systemMark("low"),
    user("c"),
    assistant("d"),
    systemMark("medium"),
    user("e"),
  ]);
  assert.deepEqual(effort.store.get("sess-1").marks, [
    { index: 2, effort: "low" },
    { index: 4, effort: "medium" },
  ]);
});

test("lineage change resets the base", async () => {
  const { seen, effort, fetchImpl } = createHarness();
  await send(fetchImpl, body({ effort: "high", messages: [user("hi")] }));
  await send(fetchImpl, body({
    effort: "low",
    messages: [user("hi"), assistant("yo"), user("again")],
  }));
  const compacted = body({
    effort: "low",
    messages: [user("summary"), assistant("ok"), user("next")],
  });
  const { raw } = await send(fetchImpl, compacted);
  assert.equal(seen[2].init.body, raw, "reset request is byte-identical");
  const state = effort.store.get("sess-1");
  assert.equal(state.baseEffort, "low");
  assert.deepEqual(state.marks, []);

  const { seen: modelSeen, fetchImpl: modelFetch } = createHarness();
  await send(modelFetch, body({ model: "claude-fable-5-1", effort: "high", messages: [user("hi")] }));
  const switched = body({ model: "claude-opus-5", effort: "low", messages: [user("hi"), assistant("yo"), user("again")] });
  const switchedSend = await send(modelFetch, switched);
  assert.equal(modelSeen[1].init.body, switchedSend.raw);
});

test("header concat preserves existing OAuth betas", () => {
  const joined = appendMidConversationEffortBeta({ "anthropic-beta": OAUTH_BETAS, "x-app": "cli" });
  assert.equal(joined["anthropic-beta"], `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}`);
  assert.equal(joined["x-app"], "cli");
  const already = appendMidConversationEffortBeta({ "anthropic-beta": `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}` });
  assert.equal(already["anthropic-beta"], `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}`);
  const headers = new Headers({ "anthropic-beta": OAUTH_BETAS });
  const next = appendMidConversationEffortBeta(headers);
  assert.equal(next.get("anthropic-beta"), `${OAUTH_BETAS},${MID_CONVERSATION_EFFORT_BETA}`);
  assert.notEqual(next, headers);
});

test("out-of-range mark resets instead of emitting an invalid body", async () => {
  const boxed = createMidConversationEffort();
  boxed.store.set("sess-1", {
    lineage: nextEffortSessionState(undefined, {
      model: "claude-fable-5-1",
      messages: [user("hi")],
      effort: "high",
    }).lineage,
    baseEffort: "high",
    marks: [{ index: 99, effort: "low" }],
  });
  const seen = [];
  const fetchImpl = boxed.wrapFetch(async (_url, init) => {
    seen.push(init);
    return new Response("{}");
  }, { sessionId: "sess-1", provider: "anthropic" });
  const payload = body({
    effort: "medium",
    messages: [user("hi"), assistant("yo")],
  });
  const { raw } = await send(fetchImpl, payload);
  assert.equal(seen[0].body, raw);
  const state = boxed.store.get("sess-1");
  assert.equal(state.baseEffort, "medium");
  assert.deepEqual(state.marks, []);
});

test("withRubatoStream wires the effort wrapper for anthropic even without cache audit", async () => {
  const seen = [];
  const boxed = createMidConversationEffort();
  const inner = (_model, _context, options) => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        const first = JSON.stringify(body({ effort: "high", messages: [user("hi")] }));
        await options.fetch(MESSAGES_URL, { method: "POST", headers: { "anthropic-beta": OAUTH_BETAS }, body: first });
        const second = JSON.stringify(body({
          effort: "low",
          messages: [user("hi"), assistant("yo"), user("again")],
        }));
        await options.fetch(MESSAGES_URL, { method: "POST", headers: { "anthropic-beta": OAUTH_BETAS }, body: second });
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
      },
      result: async () => ({ role: "assistant", content: [], stopReason: "stop" }),
    };
    return stream;
  };
  const decorated = withRubatoStream(inner);
  const stream = decorated(
    { provider: "anthropic", id: "claude-fable-5-1", api: "anthropic-messages" },
    { messages: [] },
    {
      env: {},
      sessionId: "wired",
      midConversationEffort: boxed,
      measurementRecorder: { startCall: () => ({ callId: "c" }), firstOutput() {}, endCall() {} },
      fetch: async (_url, init) => {
        seen.push(init.body);
        return new Response("{}", { status: 200 });
      },
    },
  );
  for await (const _event of stream) { /* drain */ }
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[0]).output_config.effort, "high");
  assert.equal(JSON.parse(seen[0]).messages.some((message) => message.role === "system"), false);
  const rewritten = JSON.parse(seen[1]);
  assert.equal(rewritten.output_config.effort, "high");
  assert.deepEqual(rewritten.messages[2], systemMark("low"));
});

test("cache_control moving off messages[0] does not reset lineage", async () => {
  const { seen, effort, fetchImpl } = createHarness();
  const first = body({
    effort: "high",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
  });
  await send(fetchImpl, first);
  const second = body({
    effort: "low",
    messages: [user("hi"), assistant("yo"), user("again")],
  });
  await send(fetchImpl, second);
  const sent = JSON.parse(seen[1].init.body);
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.messages[2], systemMark("low"));
  assert.equal(effort.store.get("sess-1").baseEffort, "high");
});
