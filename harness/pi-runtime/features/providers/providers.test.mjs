import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { providersFeature } from "./patches.mjs";

const PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "xai",
  "cursor",
  "anthropic",
  "kiro",
  "google-antigravity",
  "opencode",
]);
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const sourceRuntimeRoot = join(import.meta.dirname, "../..");
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-providers-"));
const stagedRoot = join(scratchRoot, "runtime");
const isolatedHome = join(scratchRoot, "home");
mkdirSync(isolatedHome);

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const staged = await stagePiRuntime({
  sourceRoot: sourceRuntimeRoot,
  outputRoot: stagedRoot,
  features: [providersFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const piAiRoot = runtime.packages["@earendil-works/pi-ai"].dir;
const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
const feature = await import(
  pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/extension.mjs")).href
);
process.env.CURSOR_CONVERSATION_ID_STORE = join(scratchRoot, "cursor-rotation.json");
const cursorApi = await import(pathToFileURL(join(piAiRoot, "dist/api/cursor-agent.js")).href);
const cursorProto = await import(
  pathToFileURL(join(piAiRoot, "dist/api/cursor-agent/gen/agent_pb.js")).href
);
const cursorFactory = await import(pathToFileURL(join(piAiRoot, "dist/providers/cursor.js")).href);
const cursorLazy = await import(
  pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/cursor-lazy.mjs")).href
);
const cursorEventStream = await import(
  pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/cursor-event-stream.mjs")).href
);
const stockLazy = await import(pathToFileURL(join(piAiRoot, "dist/api/lazy.js")).href);
const stockEventStream = await import(pathToFileURL(join(piAiRoot, "dist/utils/event-stream.js")).href);

function environment(extra = {}) {
  return {
    HOME: isolatedHome,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: join(scratchRoot, "never-default-agent"),
    PATH: process.env.PATH,
    ...extra,
  };
}

function model({ provider, id, api, baseUrl, input = ["text"] }) {
  return {
    provider,
    id,
    name: `${provider} fixture`,
    api,
    baseUrl,
    reasoning: true,
    input,
    contextWindow: 64_000,
    maxTokens: 4_096,
    cost: { ...ZERO_COST },
  };
}

function textSse(text) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_local",
        type: "message",
        role: "assistant",
        model: "local",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function authData() {
  return {
    kiro: { type: "api_key", key: "kiro-test-not-real" },
    cursor: {
      type: "oauth",
      access: "cursor-test-not-real",
      refresh: "cursor-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
    },
    "google-antigravity": {
      type: "oauth",
      access: "antigravity-test-not-real",
      refresh: "antigravity-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
      env: { RUBATO_ANTIGRAVITY_PROJECT: "local-project" },
    },
  };
}

async function startSession(t, { selectedModel, env, observers = [] }) {
  const root = mkdtempSync(join(scratchRoot, "session-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(authData(), null, 2)}\n`, { mode: 0o600 });

  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "rubato-providers",
        factory: feature.createProvidersExtension({
          env: { ...env, RUBATO_PI_CODING_AGENT_DIR: agentDir },
          kiro: { ensureKiro: async () => {} },
        }),
      },
      ...observers.map((factory, index) => ({ name: `observer-${index}`, factory })),
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: selectedModel,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    noTools: "all",
  });
  assert.deepEqual(result.extensionsResult.errors, []);
  const extensionErrors = [];
  await result.session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(extensionErrors, []);
  t.after(() => result.session.dispose());
  return result.session;
}

function assistantText(session) {
  const message = session.agent.state.messages.at(-1);
  assert.equal(message?.role, "assistant");
  assert.equal(message.stopReason, "stop");
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
}

function connectFrame(bytes) {
  const frame = Buffer.alloc(5 + bytes.length);
  frame.writeUInt32BE(bytes.length, 1);
  Buffer.from(bytes).copy(frame, 5);
  return frame;
}

function cursorInteraction(caseName, value) {
  return toBinary(
    cursorProto.AgentServerMessageSchema,
    create(cursorProto.AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(cursorProto.InteractionUpdateSchema, {
          message: { case: caseName, value },
        }),
      },
    }),
  );
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test("feature stages one stock-bound closure and its default factory builds the admitted seven", async () => {
  assert.equal(providersFeature.id, "providers");
  assert.equal(providersFeature.patches.length, 9);
  assert.deepEqual(
    providersFeature.patches.map(({ path, preimageSha256 }) => ({ path, preimageSha256 })),
    [
      {
        path: "dist/auth/resolve.js",
        preimageSha256: "82ee45ecec319f59536759312a4de25313a8bb8cb7ce43db43d18edc10fef305",
      },
      {
        path: "dist/models.js",
        preimageSha256: "75fa33149fb608bc4a7b7a0586c8ca8f0024465d580091b0c426c0baf3fbc80a",
      },
      {
        path: "dist/core/model-runtime.js",
        preimageSha256: "bae3c3feb7928c7702c3d98a3454660bee1647064dd449472fc6308c354fbc25",
      },
      {
        path: "dist/core/extensions/loader.js",
        preimageSha256: "81106b07522aaf9197858c4679fecd7fbd23c346376d6e1f2cc3dd5294d543f4",
      },
      {
        path: "dist/core/extensions/runner.js",
        preimageSha256: "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2",
      },
      {
        path: "dist/api/openai-codex-responses.js",
        preimageSha256: "6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7",
      },
      {
        path: "dist/api/transform-messages.js",
        preimageSha256: "9d747a3d64c533f7bfaf2a66e8446dc006086559d364a09d4c51d1c8c9c332e5",
      },
      {
        path: "dist/utils/event-stream.js",
        preimageSha256: "29a6bb6b21387b8c1f2ecfb1ec508b4030aba3727373ab854d28333557f7a68e",
      },
      {
        path: "dist/api/lazy.js",
        preimageSha256: "4b8083fd71cbbe2ed01be00fc6ae9bc67f84aa7bf50ef815f7863e156a3e003c",
      },
    ],
  );
  assert.ok(providersFeature.files.every((entry) =>
    entry.packageName === "@earendil-works/pi-ai"
    || (entry.packageName === "@earendil-works/pi-coding-agent"
      && entry.path === "dist/rubato-features/providers/auth-pool/runtime-pool.mjs")
  ));
  assert.ok(providersFeature.files.every((entry) => !entry.sourcePath.includes("/rubato/node_modules/")));
  assert.match(readFileSync(join(piAiRoot, "dist/rubato-features/providers/THIRD_PARTY_NOTICES.md"), "utf8"), /MIT License/);

  const providers = await feature.createRubatoProviders({
    env: environment(),
    kiro: { ensureKiro: async () => {} },
  });
  assert.deepEqual(providers.map((provider) => provider.id), PROVIDER_IDS);
  assert.ok(providers.every((provider) => typeof provider.streamSimple === "function"));
  assert.equal(providers[2].getModels().length, 0, "Cursor remains account-discovered, not a fake static catalog");
  assert.equal(staged.receipt.addedFiles.length, providersFeature.files.length);
});

test("Cursor adapter restores grouped catalogs and forwards local-work state through lazy setup", async () => {
  const provider = cursorFactory.cursorProvider();
  const legacyModel = (id) => model({
    provider: "cursor",
    id,
    api: "cursor-agent",
    baseUrl: "https://api2.cursor.sh",
  });
  await provider.refreshModels({
    stored: {
      checkedAt: 1,
      models: [legacyModel("grok-4.7-low"), legacyModel("grok-4.7-high")],
    },
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["grok-4.7"]);

  const inner = new cursorEventStream.AssistantMessageEventStream();
  let finishWork;
  const pending = new Promise((resolve) => { finishWork = resolve; });
  const localWork = inner.trackLocalWork(pending);
  const selectedModel = model({ provider: "cursor", id: "lazy", api: "cursor-agent", baseUrl: "http://127.0.0.1:9" });
  const outer = cursorLazy.lazyStream(selectedModel, async () => inner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outer.hasPendingLocalWork(), true);
  finishWork();
  await localWork;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: selectedModel.api,
    provider: selectedModel.provider,
    model: selectedModel.id,
    usage: { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  inner.push({ type: "done", reason: "stop", message });
  const settled = await drain(outer);
  assert.equal(settled.result.stopReason, "stop");
  assert.equal(outer.hasPendingLocalWork(), false);
});

test("stock lazy streams expose inner local-work", async () => {
  const inner = new stockEventStream.AssistantMessageEventStream();
  let finishWork;
  const pending = new Promise((resolve) => { finishWork = resolve; });
  const localWork = inner.trackLocalWork(pending);
  const outer = stockLazy.lazyStream(model({ provider: "openai-codex", id: "lazy", api: "openai-responses" }), async () => inner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outer.hasPendingLocalWork(), true);
  finishWork();
  await localWork;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "lazy",
    usage: { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  inner.push({ type: "done", reason: "stop", message });
  const settled = await drain(outer);
  assert.equal(settled.result.stopReason, "stop");
  assert.equal(outer.hasPendingLocalWork(), false);
});

test("actual stock SDK registers all seven and completes a Kiro Anthropic request", async (t) => {
  const captured = {};
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    captured.url = request.url;
    captured.apiKey = request.headers["x-api-key"];
    captured.body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(textSse("kiro-ok"));
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const selectedModel = model({
    provider: "kiro",
    id: "claude-opus-5",
    api: "anthropic-messages",
    baseUrl,
    input: ["text", "image"],
  });
  const session = await startSession(t, {
    selectedModel,
    env: environment({ KIRO_BASE_URL: baseUrl, KIRO_API_KEY: "kiro-test-not-real" }),
  });

  assert.deepEqual(session.modelRuntime.getRegisteredProviderIds(), PROVIDER_IDS);
  assert.deepEqual(
    session.modelRuntime.getProviders().map((provider) => provider.id).sort(),
    [...PROVIDER_IDS].sort(),
  );
  assert.equal(session.modelRuntime.getProviders().some((provider) => provider.id === "openai"), false);
  await session.prompt("hello Kiro");
  assert.equal(assistantText(session), "kiro-ok");
  assert.equal(captured.url, "/v1/messages?beta=true");
  assert.equal(captured.apiKey, "kiro-test-not-real");
  assert.equal(captured.body.model, "claude-opus-5");
});

test("actual stock SDK preserves Antigravity OAuth env and request/response hooks", async (t) => {
  const captured = {};
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    captured.url = request.url;
    captured.authorization = request.headers.authorization;
    captured.body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "text/event-stream", "x-rubato-mock": "antigravity" });
    response.end(`data: ${JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: "antigravity-ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      },
    })}\n\n`);
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const responses = [];
  const observer = (pi) => {
    pi.on("before_provider_request", (event) => ({
      ...event.payload,
      request: { ...event.payload.request, rubatoHook: "applied" },
    }));
    pi.on("after_provider_response", (event) => responses.push(event));
  };
  const selectedModel = model({
    provider: "google-antigravity",
    id: "gemini-3.8-flash",
    api: "rubato-antigravity",
    baseUrl,
    input: ["text", "image"],
  });
  const session = await startSession(t, {
    selectedModel,
    env: environment({ RUBATO_ANTIGRAVITY_ENDPOINT: baseUrl }),
    observers: [observer],
  });

  await session.prompt("hello Antigravity");
  assert.equal(assistantText(session), "antigravity-ok");
  assert.equal(captured.url, "/v1internal:streamGenerateContent?alt=sse");
  assert.equal(captured.authorization, "Bearer antigravity-test-not-real");
  assert.equal(captured.body.project, "local-project", "stored OAuth env must reach the request");
  assert.equal(captured.body.request.rubatoHook, "applied");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].headers["x-rubato-mock"], "antigravity");
});

test("actual stock SDK completes Cursor HTTP/2 Connect and exposes the request hook", async (t) => {
  const captured = {};
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let input = Buffer.alloc(0);
    let replied = false;
    stream.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (replied || input.length < 5) return;
      const length = input.readUInt32BE(1);
      if (input.length < 5 + length) return;
      replied = true;
      captured.headers = headers;
      captured.request = fromBinary(cursorProto.AgentClientMessageSchema, input.subarray(5, 5 + length));
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(connectFrame(cursorInteraction(
        "textDelta",
        create(cursorProto.TextDeltaUpdateSchema, { text: "cursor-ok" }),
      )));
      stream.write(connectFrame(cursorInteraction(
        "turnEnded",
        create(cursorProto.TurnEndedUpdateSchema, { inputTokens: 2n, outputTokens: 1n }),
      )));
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const payloads = [];
  const observer = (pi) => pi.on("before_provider_request", (event) => {
    payloads.push(event.payload);
    return event.payload;
  });
  const selectedModel = model({ provider: "cursor", id: "cursor-local", api: "cursor-agent", baseUrl });
  const session = await startSession(t, {
    selectedModel,
    env: environment(),
    observers: [observer],
  });

  await session.prompt("hello Cursor");
  assert.equal(assistantText(session), "cursor-ok");
  assert.equal(captured.headers[":path"], "/agent.v1.AgentService/Run");
  assert.equal(captured.headers.authorization, "Bearer cursor-test-not-real");
  assert.equal(captured.request.message.case, "runRequest");
  assert.equal(payloads.length, 1);
});

test("Kiro and Antigravity abort with one terminal; Cursor abort and clean EOF do the same", async (t) => {
  const providers = await feature.createRubatoProviders({
    env: environment(),
    kiro: { ensureKiro: async () => {} },
  });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  for (const [id, selectedModel, extraOptions] of [
    [
      "kiro",
      model({ provider: "kiro", id: "claude-opus-5", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9" }),
      {},
    ],
    [
      "google-antigravity",
      model({ provider: "google-antigravity", id: "gemini-3.8-flash", api: "rubato-antigravity", baseUrl: "http://127.0.0.1:9" }),
      { env: { RUBATO_ANTIGRAVITY_PROJECT: "local-project" }, antigravityState: { sessionId: "abort", stepIndex: 0 } },
    ],
  ]) {
    const controller = new AbortController();
    const fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      queueMicrotask(() => controller.abort(new DOMException("Aborted", "AbortError")));
    });
    const stream = byId.get(id).streamSimple(
      selectedModel,
      { messages: [{ role: "user", content: "abort", timestamp: Date.now() }] },
      {
        apiKey: `${id}-test-not-real`,
        fetch,
        signal: controller.signal,
        maxRetries: 0,
        ...extraOptions,
      },
    );
    const settled = await drain(stream);
    assert.equal(settled.result.stopReason, "aborted", `${id} result`);
    assert.equal(
      settled.events.filter((event) => event.type === "done" || event.type === "error").length,
      1,
      `${id} terminal count`,
    );
  }

  async function cursorTerminal(mode) {
    const server = http2.createServer();
    let controller;
    server.on("stream", (stream) => {
      stream.once("data", () => {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        if (mode === "abort") controller.abort(new DOMException("Aborted", "AbortError"));
        else stream.end();
      });
    });
    const baseUrl = await listen(server);
    t.after(() => closeServer(server));
    controller = new AbortController();
    const stream = cursorApi.streamSimple(
      model({ provider: "cursor", id: `cursor-${mode}`, api: "cursor-agent", baseUrl }),
      { messages: [{ role: "user", content: mode, timestamp: Date.now() }] },
      {
        apiKey: "cursor-test-not-real",
        sessionId: `cursor-${mode}`,
        signal: controller.signal,
        streamStallMaxRetries: 0,
      },
    );
    const settled = await drain(stream);
    assert.equal(
      settled.events.filter((event) => event.type === "done" || event.type === "error").length,
      1,
      `cursor ${mode} terminal count`,
    );
    return settled.result;
  }

  assert.equal((await cursorTerminal("abort")).stopReason, "aborted");
  const eof = await cursorTerminal("eof");
  assert.equal(eof.stopReason, "error");
  assert.match(eof.errorMessage, /before turnEnded/);
});

function cursorUpdateHarness() {
  const events = [];
  let currentTextBlock = null;
  let currentThinkingBlock = null;
  return {
    events,
    stream: { push: (event) => events.push(event) },
    state: {
      get currentTextBlock() {
        return currentTextBlock;
      },
      get currentThinkingBlock() {
        return currentThinkingBlock;
      },
      setTextBlock: (block) => {
        currentTextBlock = block;
      },
      setThinkingBlock: (block) => {
        currentThinkingBlock = block;
      },
      openToolCalls: new Map(),
      resolvedMcpToolCallIds: new Set(),
    },
    output: {
      role: "assistant",
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
    usageState: { sawTokenDelta: false, sawTurnEndedUsage: false },
  };
}

function applyCursorUpdate(session, updateCase, value = {}) {
  cursorApi.processInteractionUpdate(
    { message: { case: updateCase, value } },
    session.output,
    session.stream,
    session.state,
    session.usageState,
  );
}

test("Cursor textDelta closes thinking so the answer does not keep the thinking run open", () => {
  const session = cursorUpdateHarness();
  applyCursorUpdate(session, "thinkingDelta", { text: "plan first" });
  applyCursorUpdate(session, "textDelta", { text: "here is the answer" });

  assert.deepEqual(session.events.map((event) => event.type), [
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
  ]);
  const thinking = session.output.content.find((block) => block.type === "thinking");
  assert.equal(thinking.thinking, "plan first");
  assert.equal(typeof thinking.startedAt, "number");
  assert.equal(typeof thinking.endedAt, "number");
  assert.ok(thinking.endedAt >= thinking.startedAt);
  assert.equal(session.state.currentThinkingBlock, null);
});

test("Cursor thinkingCompleted applies thinkingDurationMs", () => {
  const session = cursorUpdateHarness();
  applyCursorUpdate(session, "thinkingDelta", { text: "reason" });
  applyCursorUpdate(session, "thinkingCompleted", { thinkingDurationMs: 1500 });

  const thinking = session.output.content[0];
  assert.equal(thinking.endedAt - thinking.startedAt, 1500);
  assert.equal(session.events.at(-1).type, "thinking_end");
});

test("Cursor interaction queries get an immediate client response so the turn is not held", () => {
  const writes = [];
  cursorApi.handleInteractionQuery(
    create(cursorProto.InteractionQuerySchema, {
      id: 7,
      query: { case: "webSearchRequestQuery", value: create(cursorProto.WebSearchRequestQuerySchema, {}) },
    }),
    { write: (frame) => writes.push(frame) },
  );
  assert.equal(writes.length, 1);
  const length = writes[0].readUInt32BE(1);
  const reply = fromBinary(cursorProto.AgentClientMessageSchema, writes[0].subarray(5, 5 + length));
  assert.equal(reply.message.case, "interactionResponse");
  assert.equal(reply.message.value.id, 7);
  assert.equal(reply.message.value.result.case, "webSearchRequestResponse");
  assert.equal(reply.message.value.result.value.result.case, "rejected");
});

test("Cursor exec abort control trips the in-flight exec controller", () => {
  const controller = new AbortController();
  const state = { execAborts: new Map([[9, controller]]) };
  cursorApi.handleExecServerControlMessage(
    create(cursorProto.ExecServerControlMessageSchema, {
      message: { case: "abort", value: create(cursorProto.ExecServerAbortSchema, { id: 9 }) },
    }),
    state,
  );
  assert.equal(controller.signal.aborted, true);
});

test("Cursor step, shell, and user-append updates are ingested without throwing", () => {
  const session = cursorUpdateHarness();
  applyCursorUpdate(session, "stepStarted", { stepId: 3 });
  applyCursorUpdate(session, "stepCompleted", { stepId: 3, stepDurationMs: 12 });
  applyCursorUpdate(session, "shellOutputDelta", {});
  applyCursorUpdate(session, "userMessageAppended", {
    userMessage: { text: "hi", messageId: "u1", isSimulatedMsg: false },
  });
  applyCursorUpdate(session, "userMessageAppended", {
    userMessage: { text: "sim", messageId: "u2", isSimulatedMsg: true },
  });
  assert.equal(session.usageState.lastStepId, 3);
  assert.equal(session.usageState.lastStepStatus, "completed");
  assert.equal(session.usageState.lastStepDurationMs, 12);
  assert.equal(session.usageState.lastAppendedUserMessageId, "u1");
});

test("Cursor summary frames are kept as cursor-summary, not Anthropic compaction", () => {
  const session = cursorUpdateHarness();
  applyCursorUpdate(session, "thinkingDelta", { text: "still thinking" });
  applyCursorUpdate(session, "summaryStarted", {});
  applyCursorUpdate(session, "summary", { summary: "earlier turns " });
  applyCursorUpdate(session, "summary", { summary: "were folded" });
  applyCursorUpdate(session, "summaryCompleted", {});

  assert.equal(session.usageState.cursorSummary, "earlier turns were folded");
  const block = session.output.content.find((item) => item.type === "providerNative");
  assert.equal(block.subtype, "cursor-summary");
  assert.deepEqual(block.raw, { type: "cursor-summary", content: "earlier turns were folded" });
  assert.notEqual(block.subtype, "compaction");
  assert.equal(session.state.currentThinkingBlock, null);
  assert.ok(session.events.some((event) => event.type === "thinking_end"));
});
