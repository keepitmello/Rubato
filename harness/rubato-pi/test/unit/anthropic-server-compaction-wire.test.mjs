import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_SERVER_COMPACTION_BETA,
  ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE,
} from "../../src/anthropic-server-compaction.mjs";
import {
  applyAnthropicServerCompaction,
  wrapAnthropicServerCompactionFetch,
} from "../../src/anthropic-server-compaction-wire.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// 단위 테스트는 트랜스폼을 거치지 않으므로 적용 표시를 직접 켠다.
globalThis[Symbol.for("rubato.anthropicServerCompaction.adapter")] = true;
globalThis[Symbol.for("rubato.anthropicServerCompaction.lane")] = true;
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";

function body(model, extra = {}) {
  return JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
    ...extra,
  });
}

function betaOf(headers) {
  if (headers && typeof headers.get === "function") return headers.get("anthropic-beta") ?? "";
  const key = headers && Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta");
  return key ? String(headers[key]) : "";
}

function hasCompactEdit(payload) {
  return Array.isArray(payload?.context_management?.edits)
    && payload.context_management.edits.some((edit) => edit?.type === ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE);
}

async function send(model, { provider = "anthropic", headers = { "anthropic-beta": OAUTH_BETAS }, extra } = {}) {
  const seen = [];
  const fetchImpl = wrapAnthropicServerCompactionFetch(async (url, init) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  }, { provider });
  const raw = body(model, extra);
  const init = { method: "POST", headers, body: raw };
  await fetchImpl(MESSAGES_URL, init);
  return { raw, init, seen: seen[0] };
}

for (const model of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
  test(`${model} gets compact beta and context_management edit`, async () => {
    const { raw, init, seen } = await send(model);
    assert.notEqual(seen.init.body, raw);
    const payload = JSON.parse(seen.init.body);
    assert.equal(hasCompactEdit(payload), true);
    assert.equal(payload.context_management.edits.length, 1);
    assert.deepEqual(payload.context_management.edits[0], { type: ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE });
    assert.ok(!("trigger" in payload.context_management.edits[0]));
    assert.equal(betaOf(seen.init.headers).startsWith(OAUTH_BETAS), true);
    assert.ok(betaOf(seen.init.headers).split(",").map((entry) => entry.trim()).includes(ANTHROPIC_SERVER_COMPACTION_BETA));
    assert.notEqual(seen.init.headers, init.headers);
  });
}

test("the wire stays off when a required transform did not apply", () => {
  const raw = body("claude-fable-5-1");
  const off = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic", armed: false });
  assert.equal(off.rewritten, false);
  assert.equal(off.bodyText, raw);
  const on = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic" });
  assert.equal(on.rewritten, true);
});

test("haiku 4.5 is untouched", async () => {
  const { raw, init, seen } = await send("claude-haiku-4-5");
  assert.equal(seen.init.body, raw);
  assert.equal(seen.init.headers, init.headers);
  assert.equal(JSON.parse(seen.init.body).context_management, undefined);
  assert.equal(betaOf(seen.init.headers).includes(ANTHROPIC_SERVER_COMPACTION_BETA), false);
});

test("non-Anthropic provider is untouched", async () => {
  const { raw, init, seen } = await send("grok-4", { provider: "xai" });
  assert.equal(seen.init.body, raw);
  assert.equal(seen.init.headers, init.headers);
});

test("existing anthropic-beta is preserved and compact beta is appended", () => {
  const headers = { "anthropic-beta": OAUTH_BETAS, "x-app": "cli" };
  const applied = applyAnthropicServerCompaction(body("claude-opus-5"), headers, { provider: "anthropic" });
  assert.equal(applied.rewritten, true);
  assert.equal(applied.headers["x-app"], "cli");
  assert.equal(applied.headers["anthropic-beta"], `${OAUTH_BETAS},${ANTHROPIC_SERVER_COMPACTION_BETA}`);
});

test("existing context_management edits are merged without a duplicate compact edit", () => {
  const raw = body("claude-sonnet-5", {
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE }] },
  });
  const applied = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic" });
  const payload = JSON.parse(applied.bodyText);
  const types = payload.context_management.edits.map((edit) => edit.type);
  assert.deepEqual(types, ["clear_tool_uses_20250919", ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE]);
});
