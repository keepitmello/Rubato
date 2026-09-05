import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import {
  ASIDE_CURSOR_API_KEY,
  asideCursorModelId,
  cacheHitRate,
  conversationKey,
  cursorModelStub,
  openaiToPiContext,
  openaiSseChunk,
  resolveCursorModel,
} from "../../src/aside-cursor.mjs";
import { activateCursorProvider, applyAsideModelsLock, createAsideCursorHandler } from "../../src/aside-cursor-server.mjs";
import {
  asideCursorFaceUrl,
  asideModelsUnlocked,
  asideXaiFaceUrl,
  lockAsideModels,
  renderAsideCursorLaunchAgent,
  xaiUpstreamUrl,
} from "../../src/aside-cursor-lock.mjs";

test("Aside Fast id folds onto the pinned Grok 4.6 base", () => {
  assert.equal(asideCursorModelId("cursor/grok-4.6-fast"), "cursor-grok-4.6");
  assert.equal(asideCursorModelId("cursor/grok-4.6"), "cursor-grok-4.6");
  assert.equal(asideCursorModelId("grok-4.6-fast"), "cursor-grok-4.6");
  assert.equal(asideCursorModelId("cursor/claude-fable-5"), "claude-fable-5-1");
  assert.equal(asideCursorModelId("cursor/claude-fable-5-1"), "claude-fable-5-1");
});

test("conversation key prefers Aside session header over message hash", () => {
  const body = { messages: [{ role: "user", content: "hello" }] };
  const fromHeader = conversationKey({
    headers: { "X-Aside-Session-Id": "sess-1" },
    body,
  });
  const fromMessages = conversationKey({ headers: {}, body });
  assert.equal(fromHeader, "sess-1");
  assert.equal(fromMessages.length, 32);
  assert.notEqual(fromHeader, fromMessages);
});

test("same first user and system text share a conversation key", () => {
  const a = conversationKey({
    body: {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
      ],
    },
  });
  const b = conversationKey({
    body: {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
      ],
    },
  });
  assert.equal(a, b);
});

test("OpenAI history becomes last-user-turn plus earlier transcript", () => {
  const context = openaiToPiContext({
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ],
    tools: [{ type: "function", function: { name: "open_tab", description: "open", parameters: {} } }],
  });
  assert.equal(context.systemPrompt, "be brief");
  assert.deepEqual(context.messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]);
  assert.equal(context.tools[0].name, "open_tab");
});

test("tool results become a user turn so Connect still has this-turn text", () => {
  const context = openaiToPiContext({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "x" } }] },
      { role: "tool", name: "x", content: "done" },
    ],
  });
  assert.equal(context.messages.at(-1).role, "user");
  assert.match(context.messages.at(-1).content, /done/);
});

test("cache hit treats exclusive and inclusive input the same", () => {
  assert.equal(cacheHitRate({ input: 490, cacheRead: 27520 }), 27520 / (490 + 27520));
  assert.equal(cacheHitRate({ input: 28010, cacheRead: 27520 }), 27520 / (490 + 27520));
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0 }), null);
});

test("ungrouped bases resolve to a live wire variant", () => {
  const live = [
    { id: "gemini-3.8-flash-high", provider: "cursor", api: "cursor-agent" },
    { id: "claude-fable-5-1-medium", provider: "cursor", api: "cursor-agent" },
  ];
  assert.equal(resolveCursorModel("cursor/gemini-3.8-flash", live).id, "gemini-3.8-flash-high");
  assert.equal(resolveCursorModel("cursor/claude-fable-5-1", live).id, "claude-fable-5-1-medium");
  assert.equal(resolveCursorModel("cursor/gemini-3.8-flash", []).id, "gemini-3.8-flash");
});

test("catalog miss still stubs a cursor-agent Grok Fast model", () => {
  const stub = resolveCursorModel("cursor/grok-4.6-fast", []);
  assert.equal(stub.id, "cursor-grok-4.6");
  assert.equal(stub.api, "cursor-agent");
  assert.equal(stub.provider, "cursor");
  assert.equal(cursorModelStub("cursor/kimi-k3").id, "kimi-k3");
});

test("handler streams OpenAI chunks from a fake Cursor provider", async () => {
  const calls = [];
  const handler = await createAsideCursorHandler({
    credential: { apiKey: "test-key" },
    provider: {
      getModels: () => [],
      streamSimple(model, context, options) {
        calls.push({ modelId: model.id, sessionId: options.sessionId, apiKey: options.apiKey });
        return (async function* () {
          yield { type: "text_delta", delta: "hi" };
          yield { type: "done", usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 0 } };
        })();
      },
    },
  });
  const { status, body } = await request(handler, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "x-aside-session-id": "aside-1" },
    body: {
      model: "cursor/grok-4.6-fast",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  });
  assert.equal(status, 200);
  assert.match(body, /"content":"hi"/);
  assert.match(body, /\[DONE\]/);
  assert.equal(calls[0].modelId, "cursor-grok-4.6");
  assert.equal(calls[0].sessionId, "aside-1");
  assert.equal(calls[0].apiKey, "test-key");
  assert.equal(ASIDE_CURSOR_API_KEY, "rubato-cursor");
});

test("Aside lock seeds Cursor Grok rows on an empty models file", () => {
  const locked = lockAsideModels({});
  assert.deepEqual(locked.providers.cursor.models.map((model) => model.id), [
    "cursor/grok-4.6",
    "cursor/grok-4.6-fast",
    "cursor/gemini-3.8-flash",
  ]);
});

test("Aside lock points Cursor at this process and leaves xAI on default", () => {
  const locked = lockAsideModels({
    providers: {
      cursor: { baseUrl: "http://127.0.0.1:10100/v1", apiKey: "opencodex-loopback" },
      "xai-grok-oauth": {
        models: [
          { id: "grok-4.6", baseUrl: asideXaiFaceUrl(), reasoning: true, contextWindow: 500000, maxTokens: 500000 },
          { id: "grok-4.5", baseUrl: "https://api.x.ai/v1", reasoning: true, contextWindow: 500000, maxTokens: 500000 },
          { id: "grok-composer-2.5-fast", baseUrl: "https://cli-chat-proxy.grok.com/v1", reasoning: false, maxTokens: 32000 },
        ],
      },
    },
  });
  assert.equal(locked.providers.cursor.baseUrl, asideCursorFaceUrl());
  assert.equal(locked.providers.cursor.apiKey, ASIDE_CURSOR_API_KEY);
  assert.equal(locked.providers.cursor.api, "openai-completions");
  assert.deepEqual(locked.providers.cursor.models.map((model) => model.id), [
    "cursor/grok-4.6",
    "cursor/grok-4.6-fast",
    "cursor/gemini-3.8-flash",
  ]);
  assert.equal(locked.providers["xai-grok-oauth"].models[0].baseUrl, "https://api.x.ai/v1");
  assert.equal(locked.providers["xai-grok-oauth"].models[1].baseUrl, "https://api.x.ai/v1");
  // xAI 는 max_output_tokens 를 캐시 키에 넣는다: 카탈로그의 500k 를 상수로 내린다.
  assert.equal(locked.providers["xai-grok-oauth"].models[0].maxTokens, 65_536);
  assert.equal(locked.providers["xai-grok-oauth"].models[1].maxTokens, 65_536);
  assert.equal(locked.providers["xai-grok-oauth"].models[2].maxTokens, 32000);
  assert.equal(asideModelsUnlocked(locked), false);
});

test("Aside catalog rewrite is locked back onto the local faces", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aside-lock-")), "models.json");
  writeFileSync(path, JSON.stringify({
    providers: {
      cursor: { baseUrl: "https://wiped.example/v1", apiKey: "gone" },
      "xai-grok-oauth": { models: [{ id: "grok-4.6", baseUrl: asideXaiFaceUrl() }] },
    },
  }));
  assert.equal(applyAsideModelsLock(path), true);
  const restored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(restored.providers.cursor.baseUrl, asideCursorFaceUrl());
  assert.equal(restored.providers["xai-grok-oauth"].models[0].baseUrl, "https://api.x.ai/v1");
  assert.equal(applyAsideModelsLock(path), false);
});

test("xAI proxy forwards the stripped path without rewriting the body", () => {
  assert.equal(xaiUpstreamUrl("/xai/v1/responses"), "https://api.x.ai/v1/responses");
});

test("catalog refresh failure does not kill the Aside Cursor process", async () => {
  const provider = {
    getModels: () => [],
    refreshModels: async () => {
      throw new Error("Could not load Cursor model catalog from GetUsableModels");
    },
  };
  const activated = await activateCursorProvider({ provider, credential: { apiKey: "test-key" } });
  assert.equal(activated, provider);
  const handler = await createAsideCursorHandler({
    credential: { apiKey: "test-key" },
    provider: activated,
  });
  const { status, body } = await request(handler, {
    method: "GET",
    path: "/v1/models",
  });
  assert.equal(status, 200);
  assert.match(body, /cursor\/grok-4.6/);
  assert.match(body, /cursor\/gemini-3.8-flash/);
});

test("launchd plist keeps the process alive after crash", () => {
  const plist = renderAsideCursorLaunchAgent({
    scriptPath: "/tmp/rubato-aside-cursor.sh",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
    home: "/Users/wy",
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /com.keepitmello.rubato.aside-cursor/);
});

test("xAI face proxies JSON without injecting service_tier", async () => {
  const calls = [];
  const handler = await createAsideCursorHandler({
    credential: { apiKey: "test-key" },
    provider: { getModels: () => [] },
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: init.body, auth: init.headers.get("authorization") });
      return new Response(`{"ok":true}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { status, body } = await request(handler, {
    method: "POST",
    path: "/xai/v1/responses",
    headers: { authorization: "Bearer xai-token" },
    body: { model: "grok-4.6", input: "hi" },
  });
  assert.equal(status, 200);
  assert.equal(body, `{"ok":true}`);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.ok(!("service_tier" in JSON.parse(calls[0].body)));
  assert.equal(calls[0].auth, "Bearer xai-token");
});

test("SSE helper keeps finish_reason on the last chunk", () => {
  const line = openaiSseChunk("id1", {}, "stop", { input: 1, output: 2, cacheRead: 3 });
  assert.match(line, /"finish_reason":"stop"/);
  assert.match(line, /"cached_tokens":3/);
});

async function request(handler, { method, path, headers = {}, body }) {
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
