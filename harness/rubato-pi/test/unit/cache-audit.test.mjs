import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CACHE_DIAGNOSIS_BETA,
  THINKING_BINDING_BETA,
  anthropicSegments,
  antigravitySegments,
  createCacheAudit,
  firstChangedAnthropicSegment,
  isCacheAuditModel,
  isCodexResponsesModel,
  isXaiResponsesModel,
  parseAnthropicSse,
  parseAntigravitySse,
  parseResponsesSse,
  responsesSegments,
} from "../../src/cache-audit.mjs";

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function okResponse(id, usage, extra = {}) {
  const body = sse([
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-fable-5-1", content: [], usage, ...extra } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  return new Response(body, { status: 200, headers: { "request-id": `req_${id}`, "content-type": "text/event-stream" } });
}

const baseBody = () => ({
  model: "claude-fable-5-1",
  max_tokens: 100,
  thinking: { type: "adaptive" },
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
});

test("segments follow system → tools → messages and detect the first appended message", () => {
  const first = anthropicSegments(baseBody());
  assert.deepEqual(first.map((segment) => segment.section), ["params", "system", "tools", "messages"]);
  const next = baseBody();
  next.messages.push({ role: "assistant", content: [{ type: "text", text: "yo" }] });
  const changed = firstChangedAnthropicSegment(first, anthropicSegments(next));
  assert.deepEqual(changed, { section: "messages", index: 1, kind: "appended", position: 4 });
  const sysChanged = baseBody();
  sysChanged.system[0].text = "sys2";
  assert.equal(firstChangedAnthropicSegment(first, anthropicSegments(sysChanged)).section, "system");
  assert.equal(firstChangedAnthropicSegment(first, first), undefined);
});

test("parseAnthropicSse collects usage, ids, and signature bytes", () => {
  const text = sse([
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, cache_read_input_tokens: 100 }, diagnostics: { cache_miss_reason: { type: "system_changed" } } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abcd" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ]);
  const parsed = parseAnthropicSse(text);
  assert.equal(parsed.messageStart.id, "msg_1");
  assert.equal(parsed.messageStart.diagnostics.cache_miss_reason.type, "system_changed");
  assert.equal(parsed.messageDelta.usage.output_tokens, 3);
  assert.equal(parsed.contentBlocks[0].signatureBytes, 4);
});

test("wrapFetch leaves the body byte-identical without injections and records raw usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir }, now: () => new Date(0) });
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return okResponse(`m${seen.length}`, { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } });
  };
  const fetch = audit.wrapFetch(fake, { sessionId: "sess-1", model: "claude-fable-5-1", provider: "anthropic" });
  const body1 = JSON.stringify(baseBody());
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "anthropic-beta": "interleaved-thinking-2025-05-14", "x-api-key": "secret" }, body: body1 });
  assert.equal(await res.text().then((text) => text.includes("message_start")), true);
  assert.equal(seen[0].init.body, body1);
  assert.equal(seen[0].init.headers["x-api-key"], "secret");

  const second = baseBody();
  second.messages.push({ role: "assistant", content: [{ type: "text", text: "yo" }] });
  await (await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: {}, body: JSON.stringify(second) })).text();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const events = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requests = events.filter((event) => event.type === "anthropic.request");
  const responses = events.filter((event) => event.type === "anthropic.response");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].cacheControl.ttl, "1h");
  assert.equal(requests[0].cacheControl.systemBreakpoint, true);
  assert.deepEqual(requests[1].firstChanged, { section: "messages", index: 1, kind: "appended", position: 4 });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].usage.ephemeral_1h_input_tokens, 900);
  assert.equal(responses[0].requestId, "req_m1");
  const meta = JSON.parse(readFileSync(requests[0].files.meta, "utf8"));
  assert.equal(meta.headers["x-api-key"], "<redacted>");
  assert.equal(readFileSync(requests[0].files.body, "utf8"), body1);
  assert.ok(readdirSync(join(dir, "raw")).some((name) => name.endsWith(".response.sse")));
});

test("injections add betas, previous_message_id, and block_binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir, RUBATO_CACHE_AUDIT_DIAGNOSTICS: "1", RUBATO_CACHE_AUDIT_BLOCK_BINDING: "1" } });
  const seen = [];
  const fake = async (url, init) => {
    seen.push(JSON.parse(init.body));
    seen.at(-1).headers = init.headers;
    return okResponse(`m${seen.length}`, { input_tokens: 1 });
  };
  const fetch = audit.wrapFetch(fake, { sessionId: "s", model: "claude-fable-5-1" });
  await (await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" }, body: JSON.stringify(baseBody()) })).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await (await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" }, body: JSON.stringify(baseBody()) })).text();
  assert.deepEqual(seen[0].diagnostics, { previous_message_id: null });
  assert.deepEqual(seen[1].diagnostics, { previous_message_id: "m1" });
  assert.deepEqual(seen[0].thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  const betas = seen[0].headers["anthropic-beta"].split(",");
  assert.deepEqual(betas, ["interleaved-thinking-2025-05-14", CACHE_DIAGNOSIS_BETA, THINKING_BINDING_BETA]);
});

test("non-messages endpoints pass through untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir } });
  let called = 0;
  const fetch = audit.wrapFetch(async () => { called += 1; return new Response("{}"); }, {});
  await fetch("https://api.anthropic.com/v1/models", { method: "GET" });
  assert.equal(called, 1);
  assert.throws(() => readFileSync(join(dir, "audit.jsonl")));
});

const responsesSse = (id, usage, extra = {}) => [
  { type: "response.created", response: { id, model: extra.model ?? "gpt-5.6-sol" } },
  { type: "response.completed", response: { id, model: extra.model ?? "gpt-5.6-sol", usage } },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const codexBody = () => ({
  model: "gpt-5.6-sol",
  store: true,
  prompt_cache_key: "sess-key",
  previous_response_id: "resp_prev",
  instructions: "sys",
  tools: [{ type: "function", name: "read" }],
  input: [{ role: "user", content: "hi" }],
});

const xaiBody = () => ({
  model: "grok-4.6",
  instructions: "sys",
  tools: [{ type: "function", name: "read" }],
  input: [{ role: "user", content: "hi" }],
});

test("responses segments follow params → instructions → tools → input", () => {
  const first = responsesSegments(codexBody());
  assert.deepEqual(first.map((segment) => segment.section), ["params", "instructions", "tools", "input"]);
  const next = codexBody();
  next.input.push({ role: "assistant", content: "yo" });
  assert.deepEqual(firstChangedAnthropicSegment(first, responsesSegments(next)), {
    section: "input",
    index: 1,
    kind: "appended",
    position: 4,
  });
});

test("parseResponsesSse reads created id and completed usage", () => {
  const parsed = parseResponsesSse(responsesSse("resp_1", {
    input_tokens: 40,
    output_tokens: 6,
    input_tokens_details: { cached_tokens: 12 },
  }));
  assert.equal(parsed.created.id, "resp_1");
  assert.equal(parsed.completed.usage.input_tokens_details.cached_tokens, 12);
});

test("hook gate matches Codex and xAI direct models only", () => {
  assert.equal(isCodexResponsesModel({ api: "openai-codex-responses", provider: "openai-codex" }), true);
  assert.equal(isXaiResponsesModel({ api: "openai-responses", provider: "xai" }), true);
  assert.equal(isCacheAuditModel({ api: "openai-responses", provider: "openai" }), false);
  assert.equal(isCacheAuditModel({ api: "anthropic-messages", provider: "anthropic" }), true);
});

test("wrapFetch records a Codex-style responses exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir }, now: () => new Date(0) });
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return new Response(responsesSse(`resp_${seen.length}`, {
      input_tokens: 80,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: seen.length === 1 ? 0 : 40 },
    }), { status: 200, headers: { "request-id": `req_c${seen.length}`, "content-type": "text/event-stream" } });
  };
  const fetch = audit.wrapFetch(fake, { sessionId: "codex-1", model: "gpt-5.6-sol", provider: "openai-codex" });
  const body1 = JSON.stringify(codexBody());
  const res = await fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { authorization: "secret" }, body: body1 });
  assert.equal(await res.text().then((text) => text.includes("response.completed")), true);
  assert.equal(seen[0].init.body, body1);

  const second = codexBody();
  second.input.push({ role: "assistant", content: "yo" });
  await (await fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: {}, body: JSON.stringify(second) })).text();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const events = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requests = events.filter((event) => event.type === "codex.request");
  const responses = events.filter((event) => event.type === "codex.response");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].transport, "sse");
  assert.equal(requests[0].store, true);
  assert.equal(requests[0].prompt_cache_key, "sess-key");
  assert.equal(requests[0].previous_response_id, "resp_prev");
  assert.deepEqual(requests[1].firstChanged, { section: "input", index: 1, kind: "appended", position: 4 });
  assert.equal(responses.length, 2);
  assert.equal(responses[1].usage.cached_tokens, 40);
  assert.equal(responses[0].id, "resp_1");
  const meta = JSON.parse(readFileSync(requests[0].files.meta, "utf8"));
  assert.equal(meta.headers.authorization, "<redacted>");
  assert.equal(meta.transport, "sse");
  assert.equal(readFileSync(requests[0].files.body, "utf8"), body1);
});

test("wrapFetch records an xAI-style responses exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir }, now: () => new Date(0) });
  const seen = [];
  const fake = async (url, init) => {
    seen.push(init.body);
    return new Response(responsesSse(`resp_x${seen.length}`, {
      input_tokens: 30,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: seen.length === 1 ? 0 : 18 },
    }, { model: "grok-4.6" }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const fetch = audit.wrapFetch(fake, { sessionId: "xai-1", model: "grok-4.6", provider: "xai" });
  const first = xaiBody();
  await (await fetch("https://api.x.ai/v1/responses", { method: "POST", body: JSON.stringify(first) })).text();
  const second = xaiBody();
  second.input.push({ role: "assistant", content: "yo" });
  await (await fetch("https://api.x.ai/v1/responses", { method: "POST", body: JSON.stringify(second) })).text();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const events = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requests = events.filter((event) => event.type === "xai.request");
  const responses = events.filter((event) => event.type === "xai.response");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].transport, "sse");
  assert.deepEqual(requests[1].firstChanged, { section: "input", index: 1, kind: "appended", position: 4 });
  assert.equal(responses[1].usage.cached_tokens, 18);
  assert.equal(responses[0].id, "resp_x1");
  assert.equal(seen[0], JSON.stringify(first));
});

const antigravitySse = (usage, extra = {}) => [
  { response: { usageMetadata: { promptTokenCount: 1, cachedContentTokenCount: 0 } } },
  {
    response: {
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: usage,
      ...(extra.responseId ? { responseId: extra.responseId } : {}),
      ...(extra.model ? { model: extra.model } : {}),
    },
  },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const antigravityBody = () => ({
  project: "project-a",
  requestId: "req-1",
  model: "gemini-3.7-flash-medium",
  request: {
    sessionId: "wire-session",
    labels: { trajectory_id: "t", last_step_index: "1" },
    generationConfig: { maxOutputTokens: 65536 },
    systemInstruction: { role: "user", parts: [{ text: "sys" }] },
    tools: [{ functionDeclarations: [{ name: "read", description: "read" }] }],
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  },
});

test("antigravity segments follow params → systemInstruction → tools → contents", () => {
  const first = antigravitySegments(antigravityBody());
  assert.deepEqual(first.map((segment) => segment.section), ["params", "systemInstruction", "tools", "contents"]);
  const next = antigravityBody();
  next.request.contents.push({ role: "model", parts: [{ text: "yo" }] });
  assert.deepEqual(firstChangedAnthropicSegment(first, antigravitySegments(next)), {
    section: "contents",
    index: 1,
    kind: "appended",
    position: 4,
  });
});

test("parseAntigravitySse keeps the last usageMetadata", () => {
  const parsed = parseAntigravitySse(antigravitySse({
    promptTokenCount: 80,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 2,
  }, { responseId: "resp_ag1", model: "gemini-3.7-flash-medium" }));
  assert.equal(parsed.responseId, "resp_ag1");
  assert.equal(parsed.model, "gemini-3.7-flash-medium");
  assert.equal(parsed.usageMetadata.promptTokenCount, 80);
  assert.equal(parsed.usageMetadata.cachedContentTokenCount, 40);
});

test("wrapFetch records an Antigravity exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-audit-"));
  const audit = createCacheAudit({ env: { RUBATO_CACHE_AUDIT_DIR: dir }, now: () => new Date(0) });
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return new Response(antigravitySse({
      promptTokenCount: 80,
      cachedContentTokenCount: seen.length === 1 ? 0 : 40,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 2,
    }, { responseId: `resp_ag${seen.length}`, model: "gemini-3.7-flash-medium" }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const fetch = audit.wrapFetch(fake, { sessionId: "ag-1", model: "gemini-3.7-flash", provider: "google-antigravity" });
  const body1 = JSON.stringify(antigravityBody());
  const res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
    method: "POST",
    headers: { authorization: "secret" },
    body: body1,
  });
  assert.equal(await res.text().then((text) => text.includes("usageMetadata")), true);
  assert.equal(seen[0].init.body, body1);

  const second = antigravityBody();
  second.request.contents.push({ role: "model", parts: [{ text: "yo" }] });
  await (await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
    method: "POST",
    headers: {},
    body: JSON.stringify(second),
  })).text();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const events = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requests = events.filter((event) => event.type === "antigravity.request");
  const responses = events.filter((event) => event.type === "antigravity.response");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].counts, { systemInstruction: 1, tools: 1, contents: 1 });
  assert.deepEqual(requests[0].paramsChanged, []);
  assert.deepEqual(requests[1].paramsChanged, []);
  assert.deepEqual(requests[1].firstChanged, { section: "contents", index: 1, kind: "appended", position: 4 });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].usage.promptTokenCount, 80);
  assert.equal(responses[0].usage.cachedContentTokenCount, 0);
  assert.equal(responses[1].usage.cachedContentTokenCount, 40);
  assert.equal(responses[0].id, "resp_ag1");
  const meta = JSON.parse(readFileSync(requests[0].files.meta, "utf8"));
  assert.equal(meta.headers.authorization, "<redacted>");
  assert.equal(readFileSync(requests[0].files.body, "utf8"), body1);
});
