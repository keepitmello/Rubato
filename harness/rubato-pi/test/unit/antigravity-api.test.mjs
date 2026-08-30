import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROJECT_ENV,
  antigravityUsage,
  buildAntigravityRequest,
  createAntigravityApi,
  parseAntigravitySse,
  resolveAntigravityWireModel,
  withAntigravityCapabilities,
} from "../../src/antigravity-api.mjs";

const model = Object.freeze({
  id: "gemini-3.7-flash",
  name: "Gemini 3.7 Flash",
  api: ANTIGRAVITY_API,
  provider: "google-antigravity",
  contextWindow: 200_000,
  maxTokens: 65_536,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

function state() {
  return { sessionId: "wire-session", stepIndex: 1, trajectoryId: "trajectory", agentId: "agent" };
}

async function* bytes(chunks) {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}

function responseFor(payload, { chunks } = {}) {
  const text = `data: ${JSON.stringify(payload)}\r\n\r\n`;
  return {
    ok: true,
    body: bytes(chunks ?? [text]),
  };
}

async function eventsOf(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("usage는 cache와 reasoning을 이중 계상하지 않는다", () => {
  assert.deepEqual(antigravityUsage({
    promptTokenCount: 100,
    cachedContentTokenCount: 30,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 5,
    totalTokenCount: 125,
  }), {
    input: 70,
    output: 25,
    cacheRead: 30,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: 125,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(antigravityUsage({ promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 2 }).totalTokens, 12);
});

test("wire model은 reasoning tier를 고정한다", () => {
  assert.equal(resolveAntigravityWireModel("gemini-3.7-flash", "medium"), "gemini-3.7-flash-medium");
  assert.equal(resolveAntigravityWireModel("gemini-3.1-pro", "high"), "gemini-pro-agent");
});

test("request가 project, lineage, image, tool identity와 서명을 보존한다", () => {
  const wire = buildAntigravityRequest(model, {
    systemPrompt: "system",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AQI=", mimeType: "image/png" }], timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "signed", textSignature: "dGV4dC1zaWc=" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" }, thoughtSignature: "dG9vbC1zaWc=" },
      ], api: model.api, provider: model.provider, model: model.id, usage: antigravityUsage(), stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
    ],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  }, {
    env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" },
    reasoning: "high",
  }, state());

  assert.equal(wire.project, "project-a");
  assert.equal(wire.model, "gemini-3.7-flash-high");
  assert.equal(wire.request.sessionId, "wire-session");
  assert.equal(wire.request.labels.last_step_index, "1");
  const flat = wire.request.contents.flatMap((content) => content.parts);
  assert.ok(flat.some((part) => part.inlineData?.mimeType === "image/png"));
  assert.ok(flat.some((part) => part.thoughtSignature === "dGV4dC1zaWc="));
  assert.ok(flat.some((part) => part.functionCall?.id === "call-1" && part.thoughtSignature === "dG9vbC1zaWc="));
  assert.ok(flat.some((part) => part.functionResponse?.id === "call-1"));
  assert.equal(wire.request.tools[0].functionDeclarations[0].parametersJsonSchema.type, "object");
});

test("SSE parser는 CRLF와 decoder 경계는 받고 incomplete tail은 거부한다", async () => {
  const payload = { response: { value: "한글" } };
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  const parsed = [];
  for await (const item of parseAntigravitySse((async function* () {
    yield encoded.slice(0, encoded.length - 3);
    yield encoded.slice(encoded.length - 3);
  })())) parsed.push(item);
  assert.deepEqual(parsed, [payload]);

  await assert.rejects(async () => {
    for await (const _item of parseAntigravitySse(bytes(["data: {\"response\":" ]))) { /* no-op */ }
  }, /incomplete SSE frame/);
});

test("stream은 textSignature와 tool thoughtSignature, canonical tool events를 낸다", async () => {
  const payload = {
    response: {
      candidates: [{
        content: { parts: [
          { text: "hello", thoughtSignature: "text-sig" },
          { functionCall: { id: "call-1", name: "read", args: { path: "a" } }, thoughtSignature: "tool-sig" },
        ] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1 },
    },
  };
  const api = createAntigravityApi({ fetchImpl: async () => responseFor(payload) });
  const stream = api.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "token",
    env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" },
    antigravityState: state(),
  });
  const events = await eventsOf(stream);
  assert.deepEqual(events.filter((event) => event.type.startsWith("toolcall_")).map((event) => event.type), [
    "toolcall_start", "toolcall_delta", "toolcall_end",
  ]);
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.content[0].textSignature, "text-sig");
  assert.equal(result.content[1].thoughtSignature, "tool-sig");
  assert.deepEqual(result.usage, antigravityUsage(payload.response.usageMetadata));
});

test("signature-only part는 빈 signed content로 남는다", async () => {
  const api = createAntigravityApi({ fetchImpl: async () => responseFor({
    response: {
      candidates: [{ content: { parts: [{ thoughtSignature: "only-signature" }] }, finishReason: "STOP" }],
    },
  }) });
  const stream = api.stream(model, { messages: [] }, {
    apiKey: "token",
    env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" },
    antigravityState: state(),
  });
  await eventsOf(stream);
  const result = await stream.result();
  assert.deepEqual(result.content, [{ type: "text", text: "", textSignature: "only-signature" }]);
});

test("finish reason 없는 EOF와 출력 후 malformed SSE는 error로 닫는다", async () => {
  const noFinish = createAntigravityApi({ fetchImpl: async () => responseFor({
    response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
  }) });
  const a = noFinish.stream(model, { messages: [] }, {
    apiKey: "token", env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" }, antigravityState: state(),
  });
  const aEvents = await eventsOf(a);
  assert.equal(aEvents.at(-1).type, "error");
  assert.match((await a.result()).errorMessage, /without a finish reason/);

  const malformed = createAntigravityApi({ fetchImpl: async () => ({
    ok: true,
    body: bytes([
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] } })}\n\n`,
      "data: {bad-json}\n\n",
    ]),
  }) });
  const b = malformed.stream(model, { messages: [] }, {
    apiKey: "token", env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" }, antigravityState: state(),
  });
  const bEvents = await eventsOf(b);
  assert.equal(bEvents.at(-1).type, "error");
  assert.match((await b.result()).errorMessage, /Malformed Antigravity SSE JSON/);
});

test("abort는 fetch signal을 그대로 전달하고 aborted assistant로 끝난다", async () => {
  const controller = new AbortController();
  const api = createAntigravityApi({ fetchImpl: async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  } });
  const stream = api.stream(model, { messages: [] }, {
    apiKey: "token", env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" }, antigravityState: state(), signal: controller.signal,
  });
  const events = await eventsOf(stream);
  assert.equal(events.at(-1).type, "error");
  assert.equal((await stream.result()).stopReason, "aborted");
});

test("stateful wrapper는 inner error 뒤 terminal event를 하나만 낸다", async () => {
  const api = createAntigravityApi({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "failed" }),
    runStateful: async (_options, work) => work(state()),
  });
  const stream = api.stream(model, { messages: [] }, {
    apiKey: "token",
    env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" },
  });
  const events = await eventsOf(stream);
  assert.deepEqual(events.filter((event) => event.type === "done" || event.type === "error").map((event) => event.type), ["error"]);
  assert.match((await stream.result()).errorMessage, /HTTP 500/);
});

// pinned encoder 의 `toolResult` 분기는 `model.input.includes("image")` 를 가드 없이 읽는다
// (`api/google-shared.js:206`). catalog 가 `input` 없는 descriptor 를 주면 **도구 결과를 실을
// 때만** TypeError 가 나서 턴이 통째로 빈다 — 도구 왕복이 없는 시험은 전부 통과하므로 오래
// 안 보였다. 실 검증에서 3턴이 다 빈 응답으로 나온 원인이 이것이었다.
test("input 없는 descriptor 로도 도구 결과를 실을 수 있다", () => {
  const stripped = { ...model, input: undefined };
  const wire = buildAntigravityRequest(stripped, {
    systemPrompt: "system",
    messages: [
      { role: "user", content: [{ type: "text", text: "read hello.txt" }], timestamp: 1 },
      { role: "assistant", content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "hello.txt" } },
      ], api: model.api, provider: model.provider, model: model.id, usage: antigravityUsage(), stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "KIRO_SMOKE_OK" }], isError: false, timestamp: 3 },
    ],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  }, { env: { [ANTIGRAVITY_PROJECT_ENV]: "project-a" } }, state());

  // 가드가 없으면 여기서 TypeError 로 죽어 턴이 통째로 빈다.
  const roles = wire.request.contents.map((entry) => entry.role);
  assert.ok(roles.includes("user"), `toolResult 가 실리지 않았다: ${JSON.stringify(roles)}`);
});

test("상류가 준 input 은 덮어쓰지 않는다", () => {
  // catalog 가 우리보다 최신일 수 있다. 없을 때만 채운다.
  assert.deepEqual(withAntigravityCapabilities({ ...model, input: ["text"] }).input, ["text"]);
  assert.deepEqual(withAntigravityCapabilities({ ...model, input: undefined }).input, ["text", "image"]);
});
