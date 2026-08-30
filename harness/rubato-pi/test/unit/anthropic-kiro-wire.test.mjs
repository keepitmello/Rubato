// Anthropic 과 Kiro 가 실제로 만드는 **요청**을 본다. metadata 단정으로는 부족하다:
// Claude Code 신원(user-agent, beta, x-app), system prompt 삽입, tool 이름 규칙은 전부
// `apiKey` 가 `sk-ant-oat` 를 포함하는지에 따라 갈리고(`api/anthropic-messages.js:1396`),
// 그 판정은 descriptor 어디에도 적혀 있지 않다.
//
// vendor 도, 사이드카도 부르지 않는다. `options.fetch` 를 주입해 요청을 가로채고
// Anthropic Messages SSE 를 흉내낸다. 실제 Keychain, `~/.claude`, `~/.rubato-pi`,
// :8990 은 어느 테스트도 건드리지 않는다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_SETUP_TOKEN_FILE_ENV, CLAUDE_SETUP_TOKEN_PREFIX } from "../../src/anthropic-setup-token.mjs";
import { KIRO_API_KEY_ENV } from "../../src/kiro-route.mjs";
import { directProviders } from "../../src/provider-direct.mjs";

/** 실제 token 과 겹칠 수 없는 값. 접두만 진짜와 같게 둔다 — 그 접두가 판정을 만든다. */
const SETUP_TOKEN = `${CLAUDE_SETUP_TOKEN_PREFIX}-test-only-not-a-real-token`;
/** 사이드카 key. `sk-ant-oat` 가 **아니다** — 그래야 Claude Code 규칙이 붙지 않는다. */
const KIRO_KEY = "sk-kiro-local-test-only";

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Anthropic Messages SSE 한 벌. 텍스트 하나와 usage 를 담은 최소 성공 응답이다. */
function textSse(text = "ok", { usage } = {}) {
  const finalUsage = usage ?? { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 };
  return [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: finalUsage.input_tokens, output_tokens: 0, cache_read_input_tokens: finalUsage.cache_read_input_tokens, cache_creation_input_tokens: finalUsage.cache_creation_input_tokens } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: finalUsage.output_tokens } },
    { type: "message_stop" },
  ];
}

/** thinking + tool call 을 담은 SSE. reasoning 과 tool 축을 함께 본다. */
function thinkingToolSse() {
  return [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "생각한다" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-test" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_test", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"/a"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
}

/**
 * 요청을 잡아 두고 주어진 SSE 를 흘리는 fetch.
 *
 * Anthropic SDK 는 표준 `Response` 를 기대한다. `Request` 로 올 수도 있으므로 두 모양을
 * 모두 읽는다.
 */
function capturingFetch(events, captured) {
  return async (input, init) => {
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    captured.url = String(request?.url ?? input);
    const headers = new Headers(request?.headers ?? init?.headers ?? {});
    captured.headers = Object.fromEntries(headers.entries());
    const raw = init?.body ?? (request ? await request.text() : undefined);
    captured.raw = typeof raw === "string" ? raw : raw ? Buffer.from(raw).toString("utf-8") : "";
    captured.body = captured.raw ? JSON.parse(captured.raw) : undefined;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  if (last?.type === "error") {
    throw new Error(`provider stream failed: ${String(last.error?.errorMessage).slice(0, 400)}`);
  }
  return events;
}

/** `[codex, xai, cursor, anthropic, kiro]` 순서는 `DIRECT_PROVIDER_IDS` 와 같은 계약이다. */
async function providers(options) {
  const [, , , anthropic, kiro] = await directProviders({
    ...options,
    kiro: { ensureKiro: async () => {}, ...options?.kiro },
  });
  assert.equal(anthropic.id, "anthropic");
  assert.equal(kiro.id, "kiro");
  return { anthropic, kiro };
}

function modelById(provider, id) {
  const model = provider.getModels().find((entry) => entry.id === id);
  assert.ok(model, `${id} 가 ${provider.id} catalog 에 없다`);
  return { ...model, provider: provider.id, baseUrl: provider.baseUrl };
}

/** setup-token 을 임시 파일에 두고 provider 를 만든다. 실제 Keychain 은 부르지 않는다. */
async function anthropicWithSetupToken(t) {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${SETUP_TOKEN}\n`, { mode: 0o600 });
  const { anthropic } = await providers({
    env: {},
    anthropic: {
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
      keychainLookup: async () => {
        throw new Error("실제 Keychain 을 부르면 안 된다");
      },
    },
  });
  return anthropic;
}

// ------------------------------------------------------- Anthropic OAuth wire

test("setup-token 을 apiKey 로 주면 Claude CLI 신원이 정확히 한 번 붙는다", async (t) => {
  const anthropic = await anthropicWithSetupToken(t);
  const captured = {};
  const model = modelById(anthropic, anthropic.getModels()[0].id);

  await drain(anthropic.streamSimple(
    model,
    { systemPrompt: "우리 지침", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse(), captured), apiKey: SETUP_TOKEN, maxRetries: 0, env: {} },
  ));

  // 1) Bearer 로 나간다. `x-api-key` 로 나가면 OAuth 경로가 아니다.
  assert.equal(captured.headers.authorization, `Bearer ${SETUP_TOKEN}`);
  assert.equal(captured.headers["x-api-key"], undefined, "OAuth 경로에서 x-api-key 가 함께 나가면 안 된다");

  // 2) pinned 판이 소유하는 신원. bridge 처럼 로컬 Claude 설치를 읽지 않는다.
  assert.equal(captured.headers["user-agent"], "claude-cli/2.1.75");
  assert.equal(captured.headers["x-app"], "cli");

  // 3) beta 목록. 각 값이 **정확히 한 번**이어야 한다 — 중복은 이중 적용의 신호다.
  const betas = captured.headers["anthropic-beta"].split(",");
  for (const beta of ["claude-code-20250219", "oauth-2025-04-20"]) {
    assert.equal(betas.filter((entry) => entry === beta).length, 1, `${beta} 가 ${betas.join(",")} 에서 한 번이 아니다`);
  }

  // 4) Claude Code system prompt 가 먼저, 우리 지침이 그 다음이다.
  assert.equal(captured.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(captured.body.system[1].text, "우리 지침");
  assert.equal(
    captured.body.system.filter((part) => part.text.includes("official CLI")).length,
    1,
    "Claude Code system prompt 가 두 번 들어갔다",
  );
});

test("OAuth 경로의 tool 이름 규칙은 pinned 대소문자 교정뿐이다", async (t) => {
  const anthropic = await anthropicWithSetupToken(t);
  const captured = {};
  await drain(anthropic.streamSimple(
    modelById(anthropic, anthropic.getModels()[0].id),
    {
      messages: [{ role: "user", content: [{ type: "text", text: "읽어라" }] }],
      tools: [
        { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
        { name: "read", description: "canonical 대상", parameters: { type: "object", properties: {} } },
      ],
    },
    { fetch: capturingFetch(textSse(), captured), apiKey: SETUP_TOKEN, maxRetries: 0, env: {} },
  ));

  const names = captured.body.tools.map((tool) => tool.name);
  // pinned `toClaudeCodeName` 은 **대소문자만** 교정한다(`read` → `Read`).
  assert.ok(names.includes("Read"), `대소문자 교정이 사라졌다: ${names.join(",")}`);
  // bridge 의 `read_file ↔ Read` mapping 은 이 경로에 없다. 있으면 이중 변환이다.
  assert.ok(names.includes("read_file"), `read_file 이 다른 이름으로 바뀌었다: ${names.join(",")}`);
  assert.equal(names.filter((name) => name === "Read").length, 1, "한 이름이 두 tool 로 접혔다");
});

test("setup-token 이 아니면 x-api-key 경로이고 Claude 신원이 붙지 않는다", async () => {
  // 음성 대조. 위 두 테스트가 접두 판정에 기대고 있음을 보인다.
  const { anthropic } = await providers({ env: {}, anthropic: { env: {} } });
  const captured = {};
  await drain(anthropic.streamSimple(
    modelById(anthropic, anthropic.getModels()[0].id),
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "read", description: "d", parameters: { type: "object", properties: {} } }],
    },
    { fetch: capturingFetch(textSse(), captured), apiKey: "sk-ant-api03-test-only", maxRetries: 0, env: {} },
  ));
  assert.equal(captured.headers["x-api-key"], "sk-ant-api03-test-only");
  assert.equal(captured.headers.authorization, undefined);
  assert.notEqual(captured.headers["user-agent"], "claude-cli/2.1.75");
  assert.equal(captured.headers["x-app"], undefined);
  assert.deepEqual(captured.body.tools.map((tool) => tool.name), ["read"], "OAuth 가 아닌 경로에서 이름을 바꿨다");
  assert.equal(captured.body.system?.[0]?.text, undefined, "Claude Code system prompt 가 새어 나갔다");
});

test("pinned Anthropic 모델 metadata 를 다시 적지 않았다", async () => {
  const { anthropic } = await providers({ env: {}, anthropic: { env: {} } });
  const { pathToFileURL } = await import("node:url");
  const { senpiNested } = await import("../../src/engine-paths.mjs");
  const pinned = await import(
    pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/anthropic.js")).href
  );
  const native = pinned.anthropicProvider().getModels();
  assert.deepEqual(
    anthropic.getModels().map((model) => `${model.id}:${model.contextWindow}:${model.maxTokens}`),
    native.map((model) => `${model.id}:${model.contextWindow}:${model.maxTokens}`),
  );
});

// -------------------------------------------------------------- Kiro wire

async function kiroProvider(t, { key = KIRO_KEY } = {}) {
  const dir = box(t);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ apiKey: key, port: 8990 }), { mode: 0o600 });
  const { kiro } = await providers({ env: {}, kiro: { env: { KIRO_CONFIG_PATH: path } } });
  return kiro;
}

test("Kiro 는 x-api-key 로 loopback 사이드카에 붙는다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  await drain(kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));

  assert.match(captured.url, /^http:\/\/127\.0\.0\.1:8990\//, `사이드카가 아닌 곳으로 갔다: ${captured.url}`);
  assert.equal(captured.headers["x-api-key"], KIRO_KEY);
  assert.equal(captured.headers.authorization, undefined, "loopback key 를 Bearer 로 보내면 상류가 모른다");
  // Claude Code 신원이 붙어서는 안 된다. 상대는 AWS Kiro 다.
  assert.notEqual(captured.headers["user-agent"], "claude-cli/2.1.75");
  assert.equal(captured.headers["x-app"], undefined);
  assert.equal(captured.body.model, "claude-opus-5");
  assert.equal(captured.body.system?.[0]?.text, undefined, "Claude Code system prompt 가 새어 나갔다");
});

test("Kiro 에는 Claude Code tool 이름 변환이 걸리지 않는다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  await drain(kiro.streamSimple(
    modelById(kiro, "gpt-5.6-sol"),
    {
      messages: [{ role: "user", content: [{ type: "text", text: "읽어라" }] }],
      tools: [
        { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
        { name: "read", description: "canonical 후보", parameters: { type: "object", properties: {} } },
      ],
    },
    { fetch: capturingFetch(textSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));
  // 이름이 그대로 나가야 한다. 나갈 때만 바꾸면 돌아오는 이름과 짝이 맞지 않아
  // tool loop 이 끊긴다 — 역변환은 OAuth 경로에만 있다.
  assert.deepEqual(captured.body.tools.map((tool) => tool.name), ["read_file", "read"]);
});

test("Kiro: 이미지 입력이 native image block 으로 실린다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  await drain(kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "무엇이 보이나" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }],
    },
    { fetch: capturingFetch(textSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));
  const blocks = captured.body.messages[0].content;
  const image = blocks.find((block) => block.type === "image");
  assert.ok(image, `이미지가 body 에서 사라졌다: ${JSON.stringify(blocks).slice(0, 200)}`);
  assert.equal(image.source.data, "aGVsbG8=");
  assert.equal(image.source.media_type, "image/png");
});

test("Kiro: tool call 과 tool result 신원이 그대로 실린다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  await drain(kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "파일을 읽어라" }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "toolu_abc", name: "read_file", arguments: { path: "/a" } }],
          stopReason: "toolUse",
          api: "anthropic-messages",
          provider: "kiro",
          model: "claude-opus-5",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(),
        },
        { role: "toolResult", toolCallId: "toolu_abc", toolName: "read_file", content: [{ type: "text", text: "file body" }], isError: false },
      ],
      tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    },
    { fetch: capturingFetch(textSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));
  const serialized = JSON.stringify(captured.body);
  assert.match(serialized, /toolu_abc/, "tool call 신원이 사라지면 상류가 결과를 짝지을 수 없다");
  assert.match(serialized, /read_file/);
  assert.match(serialized, /file body/);
  const use = captured.body.messages.flatMap((message) => message.content).find((block) => block?.type === "tool_use");
  assert.equal(use.name, "read_file", "tool_use 이름이 바뀌었다");
  assert.deepEqual(use.input, { path: "/a" });
});

test("Kiro: reasoning·tool·usage 가 이벤트로 그대로 나온다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  const events = await drain(kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    { messages: [{ role: "user", content: [{ type: "text", text: "생각하고 도구를 써라" }] }] },
    { fetch: capturingFetch(thinkingToolSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));
  const types = events.map((event) => event.type);
  for (const expected of ["thinking_start", "thinking_delta", "toolcall_start", "toolcall_end", "done"]) {
    assert.ok(types.includes(expected), `${expected} 이 없다: ${types.join(",")}`);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "toolUse");
  // tool 이름은 변환 없이 그대로다.
  const toolEnd = events.find((event) => event.type === "toolcall_end");
  assert.equal(toolEnd.toolCall.name, "read_file");
  assert.deepEqual(toolEnd.toolCall.arguments, { path: "/a" });
  // usage 가 정착한다. 구독이라 cost 는 0 이다.
  assert.equal(done.message.usage.output, 9);
  assert.equal(done.message.usage.cost.total, 0);
});

test("Kiro: usage 가 done 메시지에 정착한다", async (t) => {
  const kiro = await kiroProvider(t);
  const captured = {};
  const events = await drain(kiro.streamSimple(
    modelById(kiro, "gpt-5.6-sol"),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse("사이드카 응답"), captured), apiKey: KIRO_KEY, maxRetries: 0, env: {} },
  ));
  // 텍스트가 실제로 흐른다. usage 만 보면 본문이 사라진 회귀를 놓친다.
  const delta = events.find((event) => event.type === "text_delta");
  assert.equal(delta.delta, "사이드카 응답");
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(
    done.message.content.find((block) => block.type === "text").text,
    "사이드카 응답",
    "done 메시지에 본문이 정착하지 않았다",
  );
  assert.equal(done.message.usage.input, 11);
  assert.equal(done.message.usage.output, 3);
  assert.equal(done.message.usage.cacheRead, 7);
  assert.equal(done.message.usage.cacheWrite, 5);
  assert.equal(done.message.usage.cost.total, 0, "구독 경로에 과금이 붙었다");
});

test("Kiro: 중단은 중단으로 정착한다", async (t) => {
  const kiro = await kiroProvider(t);
  const controller = new AbortController();
  // 요청이 나가는 그 순간 중단한다. 시간에 기대지 않는다 — fetch 가 불린 시점이 신호다.
  const abortingFetch = async () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  const events = [];
  for await (const event of kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: abortingFetch, apiKey: KIRO_KEY, maxRetries: 0, signal: controller.signal, env: {} },
  )) {
    events.push(event);
  }
  const last = events.at(-1);
  assert.ok(last, "종단 이벤트가 없다");
  const message = last.type === "done" ? last.message : last.error;
  assert.equal(message.stopReason, "aborted", `중단이 다른 종료로 정착했다: ${message.stopReason}`);
});

test("Kiro: temperature 는 wire 에 실리지 않는다", async (t) => {
  const kiro = await kiroProvider(t);
  const model = modelById(kiro, "claude-opus-5");
  assert.equal(model.compat.supportsTemperature, false, "전제: 모델이 temperature 를 끈다");

  const captured = {};
  await drain(kiro.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse(), captured), apiKey: KIRO_KEY, maxRetries: 0, temperature: 0.7, env: {} },
  ));
  assert.ok(!("temperature" in captured.body), "상류가 받지 않는 필드를 보냈다");

  // 양성 대조. pinned 기본값은 `supportsTemperature: true` 이므로, compat 를 켜면 같은
  // 호출이 temperature 를 싣는다. 이것이 없으면 위 단정은 "이 경로가 애초에
  // temperature 를 못 싣는다"와 구별되지 않는다.
  const control = {};
  await drain(kiro.streamSimple(
    { ...model, compat: { ...model.compat, supportsTemperature: true } },
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse(), control), apiKey: KIRO_KEY, maxRetries: 0, temperature: 0.7, env: {} },
  ));
  assert.equal(control.body.temperature, 0.7, "대조군이 실패했다 — 위 단정이 아무것도 증명하지 않는다");
});

test("Kiro: env key 가 config 를 이기는 것이 wire 까지 간다", async (t) => {
  const dir = box(t);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ apiKey: "config-key-should-lose" }), { mode: 0o600 });
  const { kiro } = await providers({
    env: {},
    kiro: { env: { [KIRO_API_KEY_ENV]: KIRO_KEY, KIRO_CONFIG_PATH: path } },
  });
  const resolved = await kiro.auth.apiKey.resolve({});
  assert.equal(resolved.auth.apiKey, KIRO_KEY);

  const captured = {};
  await drain(kiro.streamSimple(
    modelById(kiro, "claude-opus-5"),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textSse(), captured), apiKey: resolved.auth.apiKey, maxRetries: 0, env: {} },
  ));
  assert.equal(captured.headers["x-api-key"], KIRO_KEY);
});
