// 직결 경로가 실제로 만드는 **요청 본문**을 본다.
//
// metadata 단정만으로는 부족하다. `serviceTier` 는 model descriptor 가 아니라
// `options.serviceTier` 에서 body 로 들어가고(`openai-codex-responses.js:433-434`),
// `upstreamModelId` 는 provider 가 아니라 ModelRuntime 이 적용한다
// (`model-runtime.js:499-503`). 그래서 descriptor 를 검사하는 것은 "우리가 붙였다"만
// 증명하고 "wire 에 그렇게 나간다"는 증명하지 않는다.
//
// vendor 를 부르지 않는다. `options.fetch` 를 주입해 body 를 가로채고 SSE 를 흉내낸다.
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import { directProviders } from "../../src/provider-direct.mjs";

/** 요청 body 를 문자열로 되돌린다. zstd 로 압축돼 오면 풀어서 읽는다. */
function decodeRequestBody(init) {
  const body = init?.body;
  if (typeof body === "string") return body;
  const encoding = new Headers(init?.headers ?? {}).get("content-encoding");
  const bytes = Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
  if (encoding === "zstd") return zlib.zstdDecompressSync(bytes).toString("utf-8");
  if (encoding === "gzip") return zlib.gunzipSync(bytes).toString("utf-8");
  return bytes.toString("utf-8");
}

/** 요청 본문을 잡아 두고, 주어진 SSE 이벤트를 그대로 흘리는 fetch. */
function capturingFetch(events, captured) {
  return async (url, init) => {
    captured.url = url;
    captured.headers = init?.headers ?? {};
    // pinned Codex builder 는 요청 body 를 **zstd 로 압축**해서 보낸다
    // (`openai-codex-responses.js:114-123`, 공식 Codex client 와 같은 동작).
    // 그래서 바이트를 그냥 UTF-8 로 읽으면 JSON 이 아니다. 이것이 metadata 단정으로는
    // 절대 드러나지 않는 종류의 wire 사실이다.
    captured.raw = decodeRequestBody(init);
    captured.body = JSON.parse(captured.raw);
    const encoder = new TextEncoder();
    // `Uint8Array` 로 넣는다. ArrayBuffer 를 넣으면 reader 쪽에서 문자열화되어
    // "[object ArrayBuffer]" 가 JSON 으로 파싱된다.
    const chunks = events.map((event) =>
      Uint8Array.from(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)),
    );
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    };
  };
}

function textDone(text = "ok") {
  return [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
  ];
}

async function codexProvider() {
  const [codex] = await directProviders();
  return codex;
}

function modelById(provider, id) {
  const model = provider.getModels().find((entry) => entry.id === id);
  assert.ok(model, `${id} 가 catalog 에 없다`);
  // pinned provider 는 요청을 만들 때 model.provider/baseUrl 을 본다.
  return { ...model, provider: provider.id, baseUrl: provider.baseUrl };
}

// pinned provider 는 `options.apiKey` 를 본다(`openai-codex-responses.js:158`).
// vendor 를 부르지 않으므로 값은 의미가 없다 — 자리만 채운다.
const API_KEY = "test-only-not-a-real-token";

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  // 오류를 삼키면 "captured 가 비었다"만 보이고 이유가 안 보인다. 여기서 세운다.
  if (last?.type === "error") {
    throw new Error(`provider stream failed: ${String(last.error?.errorMessage).slice(0, 300)}`);
  }
  return events;
}

// ---------------------------------------------------------------- Fast / tier

test("Fast 모델의 실제 body 에 canonical model ID 와 service_tier:priority 가 들어간다", async () => {
  const codex = await codexProvider();
  const captured = {};
  const fast = modelById(codex, "gpt-daybreak-blue-latest-fast");

  // ModelRuntime 이 하는 두 가지를 그 자리에서 재현한다: 요청 model 을
  // `upstreamModelId` 로 바꾸고, `serviceTier` 를 stream option 으로 내린다
  // (model-runtime.js:499-503, openai-codex-responses.js:433-434).
  const wireModel = { ...fast, id: fast.upstreamModelId ?? fast.id };
  // `serviceTier` 는 `streamSimple` 로는 통과하지 못한다: 그 경로는
  // `buildBaseOptions()` 의 **고정 allowlist** 로 옵션을 다시 만들고
  // (`simple-options.js:117-143`), 그 목록에 `serviceTier` 가 없다. tier 를 실을 수 있는
  // 것은 하위 `stream` 뿐이다. Senpi 의 service-tier 처리도 이 경로로 내려온다.
  await drain(codex.stream(
    wireModel,
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, serviceTier: fast.serviceTier, env: {} },
  ));

  assert.equal(captured.body.model, "gpt-daybreak-blue-latest", "wire 에는 canonical ID 가 가야 한다");
  assert.ok(!String(captured.body.model).endsWith("-fast"), "alias 가 그대로 나가면 상류가 모른다");
  assert.equal(captured.body.service_tier, "priority");
});

test("base 모델의 body 에는 service_tier 가 없다", async () => {
  const codex = await codexProvider();
  const captured = {};
  const base = modelById(codex, "gpt-daybreak-blue-latest");
  assert.equal(base.serviceTier, undefined, "전제: base descriptor 에 tier 가 없다");

  await drain(codex.stream(
    base,
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, serviceTier: base.serviceTier, env: {} },
  ));

  assert.equal(captured.body.model, "gpt-daybreak-blue-latest");
  assert.ok(!("service_tier" in captured.body), "base 에 tier 가 붙으면 항상 우선 처리로 나간다");
});

test("pinned Sol Fast 도 같은 계약을 지킨다", async () => {
  const codex = await codexProvider();
  const captured = {};
  const fast = modelById(codex, "gpt-5.6-sol-fast");
  const wireModel = { ...fast, id: fast.upstreamModelId ?? fast.id };
  await drain(codex.stream(
    wireModel,
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, serviceTier: fast.serviceTier, env: {} },
  ));
  assert.equal(captured.body.model, "gpt-5.6-sol");
  assert.equal(captured.body.service_tier, "priority");
});

// ------------------------------------------------------------- image and tool

test("이미지 입력이 body 에 native image part 로 실린다", async () => {
  const codex = await codexProvider();
  const captured = {};
  await drain(codex.streamSimple(
    modelById(codex, "gpt-daybreak-blue-latest"),
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "무엇이 보이나" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }],
    },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, env: {} },
  ));
  const serialized = JSON.stringify(captured.body);
  assert.match(serialized, /input_image/, "이미지가 body 에서 사라졌다");
  assert.match(serialized, /aGVsbG8=/, "이미지 데이터가 실리지 않았다");
});

test("tool 정의와 tool result 신원이 body 에 그대로 실린다", async () => {
  const codex = await codexProvider();
  const captured = {};
  await drain(codex.streamSimple(
    modelById(codex, "gpt-daybreak-blue-latest"),
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "파일을 읽어라" }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_abc", name: "read_file", arguments: { path: "/a" } }],
          stopReason: "toolUse",
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-daybreak-blue-latest",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(),
        },
        { role: "toolResult", toolCallId: "call_abc", toolName: "read_file", content: [{ type: "text", text: "file body" }], isError: false },
      ],
      tools: [{ name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, env: {} },
  ));
  const serialized = JSON.stringify(captured.body);
  assert.match(serialized, /read_file/, "tool 이름이 사라졌다");
  assert.match(serialized, /call_abc/, "tool call 신원이 사라지면 상류가 결과를 짝지을 수 없다");
  assert.match(serialized, /file body/, "tool 결과가 실리지 않았다");
});

// -------------------------------------------------- signed reasoning identity

/**
 * signed reasoning 의 `thinkingSignature` 는 **native reasoning item 을 JSON 으로 담은 것**
 * 이다(`openai-responses-shared.js:218` 의 `parseReasoningSignature`, :638 의 재작성).
 * 평범한 문자열을 넣으면 파싱에 실패해 encoder 가 그 블록을 평문 `output_text` 로
 * 강등한다 — PR #5 회귀와 정확히 같은 모양이다. 그래서 fixture 도 실제 모양을 쓴다.
 */
function nativeReasoningSignature(id, encrypted) {
  return JSON.stringify({ type: "reasoning", id, encrypted_content: encrypted, summary: [] });
}

/**
 * signed reasoning item 을 담은 assistant 턴.
 *
 * `modelId` 를 받는 이유가 중요하다: `transformMessages` 는 `provider`, `api`,
 * `model.id` 가 **셋 다** 요청 모델과 같을 때만 signed reasoning 을 살린다
 * (`transform-messages.js:106-108`). 다르면 foreign provenance 로 보고 떼어낸다.
 * 그래서 3턴 연속성 fixture 는 같은 모델로 이어진 대화여야 한다.
 */
function reasoningTurn(signature, text, modelId = "gpt-daybreak-blue-latest") {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "생각", thinkingSignature: signature },
      { type: "text", text },
    ],
    stopReason: "stop",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: modelId,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

test("signed reasoning 이 3턴 뒤에도 native item 으로 남는다", async () => {
  const codex = await codexProvider();
  const messages = [{ role: "user", content: [{ type: "text", text: "1턴" }] }];
  const encrypted = ["enc-turn-1", "enc-turn-2", "enc-turn-3"];
  const signatures = encrypted;

  for (const [index, secret] of encrypted.entries()) {
    messages.push(reasoningTurn(nativeReasoningSignature(`rs_${index + 1}`, secret), `답 ${index + 1}`, "gpt-daybreak-blue-latest"));
    messages.push({ role: "user", content: [{ type: "text", text: `${index + 2}턴` }] });
  }

  const captured = {};
  // `preserveThinking` 은 **호출자가 주는 옵션이 아니다**. provider 가
  // `reasoningRequested` 에서 파생시킨다(`openai-codex-responses.js:396,407`), 그리고
  // `reasoningRequested` 는 `options.reasoningEffort` 를 본다. 게다가
  // `preserveThinking` 은 `buildBaseOptions` allowlist 에 없어서 `streamSimple` 로는
  // 아예 전달되지 않는다(`serviceTier` 와 같은 부류다). 그래서 signed reasoning 을
  // 유지하려면 `reasoningEffort` 를 주고 하위 `stream` 을 부르는 길뿐이다.
  await drain(codex.stream(
    modelById(codex, "gpt-daybreak-blue-latest"),
    { messages },
    {
      fetch: capturingFetch(textDone(), captured),
      apiKey: API_KEY,
      maxRetries: 0,
      reasoningEffort: "high",
      env: {},
    },
  ));

  // 문자열이 어딘가 있다는 것으로는 부족하다. native `reasoning` item 으로 실렸는지 본다.
  const reasoningItems = captured.body.input.filter((item) => item.type === "reasoning");
  assert.equal(reasoningItems.length, 3, `reasoning item 이 3개여야 한다: ${JSON.stringify(captured.body.input.map((i) => i.type))}`);
  assert.deepEqual(reasoningItems.map((item) => item.encrypted_content), encrypted);
  assert.deepEqual(reasoningItems.map((item) => item.id), ["rs_1", "rs_2", "rs_3"]);
  const serialized = JSON.stringify(captured.body);
  for (const signature of signatures) {
    assert.match(serialized, new RegExp(signature), `${signature} 가 outbound context 에서 사라졌다`);
  }
  // 그리고 평문 output_text 로 강등되지 않았다 — 이것이 PR #5 회귀의 핵심이다.
  assert.match(serialized, /reasoning/, "reasoning item type 이 사라졌다");
  assert.ok(!/anthropic/i.test(serialized), "provider-native item 이 다른 provider 형식으로 표시됐다");
});

test("프로세스를 새로 띄운 것과 같은 fresh module 에서도 signature 가 보존된다", async () => {
  // transcript 저장 → 프로세스 종료 → resume 을 흉내낸다. module 캐시를 우회해
  // provider 를 처음부터 다시 만들고, 저장된 턴을 그대로 다시 보낸다.
  const fresh = await import(
    `${pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/openai-codex.js")).href}?fresh=${Date.now()}`
  );
  const provider = fresh.openaiCodexProvider();
  const stored = [
    { role: "user", content: [{ type: "text", text: "1턴" }] },
    // 재개 뒤에도 같은 모델로 이어진다 — 실제 resume 이 그렇다.
    reasoningTurn(nativeReasoningSignature("rs_restart", "enc-restart"), "저장된 답", "gpt-5.6-sol"),
    { role: "user", content: [{ type: "text", text: "재개 후 첫 턴" }] },
  ];
  const captured = {};
  const model = provider.getModels().find((entry) => entry.id === "gpt-5.6-sol");
  await drain(provider.stream(
    { ...model, provider: provider.id, baseUrl: provider.baseUrl },
    { messages: stored },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, reasoningEffort: "high", env: {} },
  ));
  const restored = captured.body.input.filter((item) => item.type === "reasoning");
  assert.equal(restored.length, 1, "재개 뒤 reasoning item 이 사라졌다");
  assert.equal(restored[0].encrypted_content, "enc-restart");
  assert.equal(restored[0].id, "rs_restart");
  // 평문 강등이 아님을 함께 본다 — 이것이 PR #5 회귀의 모양이다.
  const texts = captured.body.input.filter((item) => item.type === "message");
  assert.ok(!JSON.stringify(texts).includes("enc-restart"), "signed reasoning 이 평문 텍스트로 강등됐다");
});

// ------------------------------------------------------------------ xAI xhigh

test("xAI xhigh 가 실제 body 에 실린다", async () => {
  const [, xai] = await directProviders();
  const grok = xai.getModels().find((model) => model.id === "grok-4.6");
  assert.equal(grok.thinkingLevelMap.xhigh, "xhigh", "전제: pinned map 이 xhigh 를 갖는다");

  const captured = {};
  await drain(xai.streamSimple(
    { ...grok, provider: xai.id, baseUrl: xai.baseUrl },
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    {
      fetch: capturingFetch([{ type: "response.completed", response: { usage: {} } }], captured),
      apiKey: API_KEY, maxRetries: 0,
      // picker 가 고른 단계는 `options.reasoning` 으로 내려가고, provider 가
      // `thinkingLevelMap` 을 통해 wire 값으로 바꾼다.
      reasoning: "xhigh",
      env: {},
    },
  ));

  const serialized = JSON.stringify(captured.body);
  assert.match(serialized, /xhigh/, `xhigh 가 wire 에서 사라졌다: ${serialized.slice(0, 300)}`);
});

test("음성 대조: reasoningEffort 없이 보내면 signed reasoning 이 평문으로 강등된다", async () => {
  // 위 두 테스트가 무언가를 실제로 지키고 있음을 보이는 대조군이다. provider 는
  // `preserveThinking` 을 `reasoningRequested` 에서 파생시키므로
  // (`openai-codex-responses.js:396,407`), reasoningEffort 가 없으면 유지되지 않는다.
  // 이 강등이 PR #5 회귀의 모양이고, 그래서 fixture 가 통과했다고 안심하면 안 된다.
  const codex = await codexProvider();
  const captured = {};
  await drain(codex.stream(
    modelById(codex, "gpt-daybreak-blue-latest"),
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "1턴" }] },
        reasoningTurn(nativeReasoningSignature("rs_x", "enc-x"), "답", "gpt-daybreak-blue-latest"),
        { role: "user", content: [{ type: "text", text: "2턴" }] },
      ],
    },
    { fetch: capturingFetch(textDone(), captured), apiKey: API_KEY, maxRetries: 0, env: {} },
  ));
  const reasoningItems = captured.body.input.filter((item) => item.type === "reasoning");
  assert.equal(reasoningItems.length, 0, "대조군이 실패했다 — 이 경로에서도 유지되면 위 테스트는 아무것도 증명하지 않는다");
  assert.ok(!JSON.stringify(captured.body).includes("enc-x"), "encrypted content 가 남았다");
});
