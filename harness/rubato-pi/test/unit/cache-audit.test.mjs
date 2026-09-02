import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CACHE_DIAGNOSIS_BETA,
  THINKING_BINDING_BETA,
  anthropicSegments,
  createCacheAudit,
  firstChangedAnthropicSegment,
  parseAnthropicSse,
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
