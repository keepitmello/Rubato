// 서버 컴팩션을 켠 요청을 **전체 스택**으로 잡아 본다: provider overlay →
// rubato-stream fetch wrapper → 패치된 pi-ai anthropic adapter → 실제 wire body.
// 계획서 6단계(캐시 확인)를 실제 API 없이 검증하는 자리다 — breakpoint 수, system
// cache_control 유지, compaction 블록 재전송, 이전 thinking 생략, 지원 모델 한정.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_SETUP_TOKEN_FILE_ENV, CLAUDE_SETUP_TOKEN_PREFIX } from "../../src/anthropic-setup-token.mjs";
import { directProviders } from "../../src/provider-direct.mjs";
import { ANTHROPIC_SERVER_COMPACTION_MODEL_IDS } from "../../src/anthropic-server-compaction.mjs";

const SETUP_TOKEN = `${CLAUDE_SETUP_TOKEN_PREFIX}-test-only-not-a-real-token`;

// 어댑터 표시는 로더 훅이 패치하며 붙지만, senpi 내장 compaction 확장(lane-policy.js)은
// 이 테스트가 로드하지 않는다. 런타임에서는 startup 에 붙는 표시라 여기서 직접 켠다.
globalThis[Symbol.for("rubato.anthropicServerCompaction.lane")] = true;

function sse(events) {
  return async (input, init, captured) => {
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    const headers = new Headers(request?.headers ?? init?.headers ?? {});
    captured.headers = Object.fromEntries(headers.entries());
    const raw = init?.body ?? (request ? await request.text() : undefined);
    captured.body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8"));
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

/** 서버가 컴팩션을 수행한 응답: compaction 블록 → 텍스트, usage.iterations 포함. */
function compactionSse() {
  return [
    { type: "message_start", message: { id: "msg_c", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: 23000, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } },
    { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } },
    { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "SUMMARY-FROM-SERVER" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "계속" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1000, iterations: [
      { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
      { type: "message", input_tokens: 23000, output_tokens: 1000 },
    ] } },
    { type: "message_stop" },
  ];
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  if (last?.type === "error") throw new Error(String(last.error?.errorMessage).slice(0, 400));
  return events;
}

async function anthropicProvider(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-sc-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "setup-token");
  writeFileSync(path, `${SETUP_TOKEN}\n`, { mode: 0o600 });
  const [, , , anthropic] = await directProviders({
    env: {},
    kiro: { ensureKiro: async () => {} },
    anthropic: { env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path }, keychainLookup: async () => { throw new Error("no keychain"); } },
  });
  return anthropic;
}

function model(provider, id) {
  const found = provider.getModels().find((entry) => entry.id === id);
  assert.ok(found, `${id} 없음`);
  return { ...found, provider: provider.id, baseUrl: provider.baseUrl };
}

const countBreakpoints = (body) => {
  let n = 0;
  for (const part of body.system ?? []) if (part.cache_control) n += 1;
  for (const tool of body.tools ?? []) if (tool.cache_control) n += 1;
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.cache_control) n += 1;
  }
  return n;
};

const tools = [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }];

test("지원 모델 요청 전체 스택: beta + context_management, system cache_control 유지, breakpoint ≤ 4", async (t) => {
  const anthropic = await anthropicProvider(t);
  for (const id of ANTHROPIC_SERVER_COMPACTION_MODEL_IDS) {
    const captured = {};
    const m = model(anthropic, id);
    const first = await drain(anthropic.streamSimple(
      m,
      { systemPrompt: "우리 지침", tools, messages: [{ role: "user", content: [{ type: "text", text: "긴 작업" }], timestamp: 1 }] },
      { fetch: (i, init) => sse(compactionSse())(i, init, captured), apiKey: SETUP_TOKEN, maxRetries: 0, env: {}, sessionId: "s1" },
    ));
    assert.ok(captured.headers["anthropic-beta"].split(",").includes("compact-2026-01-12"), id);
    assert.deepEqual(captured.body.context_management, { edits: [{ type: "compact_20260112" }] }, id);
    // system 프롬프트 끝의 cache_control 은 그대로다 (compaction 이 시스템 캐시를 깨지 않는 조건).
    assert.ok(captured.body.system.at(-1).cache_control, `${id}: system cache_control`);
    assert.ok(countBreakpoints(captured.body) <= 4, `${id}: breakpoints ${countBreakpoints(captured.body)}`);

    // 응답: 블록 보존 + usage.compaction + cost 가산
    const done = first.find((e) => e.type === "done");
    const message = done.message;
    const block = message.content.find((b) => b.type === "providerNative" && b.subtype === "compaction");
    assert.equal(block?.raw.content, "SUMMARY-FROM-SERVER", id);
    assert.equal(message.usage.input, 23000, `${id}: top-level input stays effective context`);
    assert.deepEqual({ input: message.usage.compaction.input, output: message.usage.compaction.output }, { input: 180000, output: 3500 });
    assert.ok(message.usage.cost.total > 0);

    // 다음 요청: 이전 thinking 은 빠지고 compaction 블록은 native 로 재전송, breakpoint 한도 유지
    const next = {};
    const priorAssistant = {
      role: "assistant", api: m.api, provider: m.provider, model: m.id, usage: message.usage, stopReason: "stop", timestamp: 2,
      content: [{ type: "thinking", thinking: "옛 생각", thinkingSignature: "sig-old" }, { type: "text", text: "옛 답" }],
    };
    await drain(anthropic.streamSimple(
      m,
      {
        systemPrompt: "우리 지침",
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "긴 작업" }], timestamp: 1 },
          priorAssistant,
          { role: "user", content: [{ type: "text", text: "이어서" }], timestamp: 3 },
          { ...message, timestamp: 4 },
          { role: "user", content: [{ type: "text", text: "다음" }], timestamp: 5 },
        ],
      },
      { fetch: (i, init) => sse(compactionSse().filter((e) => !["compaction"].includes(e.content_block?.type) && e.delta?.type !== "compaction_delta"))(i, init, next), apiKey: SETUP_TOKEN, maxRetries: 0, env: {}, sessionId: "s1" },
    ));
    const wire = next.body.messages;
    const compactionIdx = wire.findIndex((msg) => Array.isArray(msg.content) && msg.content.some((b) => b.type === "compaction"));
    assert.ok(compactionIdx > 0, `${id}: compaction 블록이 재전송되지 않았다`);
    assert.deepEqual(wire[compactionIdx].content.find((b) => b.type === "compaction"), { type: "compaction", content: "SUMMARY-FROM-SERVER" });
    for (const msg of wire.slice(0, compactionIdx)) {
      for (const b of msg.content ?? []) assert.notEqual(b.type, "thinking", `${id}: compaction 이전 thinking 이 재전송됐다`);
    }
    assert.ok(countBreakpoints(next.body) <= 4, `${id}: breakpoints ${countBreakpoints(next.body)}`);
    assert.ok(next.body.system.at(-1).cache_control);
  }
});

test("Haiku 4.5 는 전체 스택에서도 서버 컴팩션이 붙지 않는다", async (t) => {
  const anthropic = await anthropicProvider(t);
  const captured = {};
  await drain(anthropic.streamSimple(
    model(anthropic, "claude-haiku-4-5"),
    { systemPrompt: "우리 지침", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
    { fetch: (i, init) => sse(compactionSse().slice(0, 1).concat(compactionSse().slice(4)))(i, init, captured), apiKey: SETUP_TOKEN, maxRetries: 0, env: {}, sessionId: "s2" },
  ));
  assert.ok(!captured.headers["anthropic-beta"].split(",").includes("compact-2026-01-12"));
  assert.equal(captured.body.context_management, undefined);
});
