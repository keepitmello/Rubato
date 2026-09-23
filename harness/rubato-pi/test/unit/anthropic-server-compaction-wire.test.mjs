import assert from "node:assert/strict";
import test from "node:test";
import { setContextMode } from "../../src/context-notes/config.mjs";
import { hardSafetyLine } from "../../src/context-budget.mjs";
import {
  ANTHROPIC_SERVER_COMPACTION_BETA,
  ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE,
  ANTHROPIC_SERVER_COMPACTION_MODEL_IDS,
} from "../../src/anthropic-server-compaction.mjs";
import { COMPACTION_BRIEFING_GUIDANCE } from "../../src/compaction-guidance.mjs";
import {
  anthropicServerCompactionTrigger,
  applyAnthropicServerCompaction,
  wrapAnthropicServerCompactionFetch,
} from "../../src/anthropic-server-compaction-wire.mjs";

// 노트 모드에서도 서버 컴팩션은 켜진다 — 모드와 무관하다는 것을 여기서 보인다.
setContextMode("history-notes");

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// 단위 테스트는 트랜스폼을 거치지 않으므로 적용 표시를 직접 켠다.
globalThis[Symbol.for("rubato.anthropicServerCompaction.adapter")] = true;
globalThis[Symbol.for("rubato.anthropicServerCompaction.lane")] = true;
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";

// 지원 목록의 현재 세대 id 는 소스가 소유한다 — 여기서 손으로 적으면 세대가 바뀔 때마다 깨진다.
const SERVER_FABLE = ANTHROPIC_SERVER_COMPACTION_MODEL_IDS.find((id) => id.includes("fable"));
const SERVER_OPUS = ANTHROPIC_SERVER_COMPACTION_MODEL_IDS.find((id) => id.includes("opus"));

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

const WINDOW = 1_000_000;

async function send(model, { provider = "anthropic", headers = { "anthropic-beta": OAUTH_BETAS }, extra, contextWindow = WINDOW } = {}) {
  const seen = [];
  const fetchImpl = wrapAnthropicServerCompactionFetch(async (url, init) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  }, { provider, contextWindow });
  const raw = body(model, extra);
  const init = { method: "POST", headers, body: raw };
  await fetchImpl(MESSAGES_URL, init);
  return { raw, init, seen: seen[0] };
}

for (const model of ANTHROPIC_SERVER_COMPACTION_MODEL_IDS) {
  test(`${model} gets compact beta and context_management edit`, async () => {
    const { raw, init, seen } = await send(model);
    assert.notEqual(seen.init.body, raw);
    const payload = JSON.parse(seen.init.body);
    assert.equal(hasCompactEdit(payload), true);
    assert.equal(payload.context_management.edits.length, 1);
    assert.deepEqual(payload.context_management.edits[0], {
      type: ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE,
      instructions: COMPACTION_BRIEFING_GUIDANCE,
      trigger: { type: "input_tokens", value: hardSafetyLine({ contextWindow: WINDOW }) },
    });
    assert.equal(betaOf(seen.init.headers).startsWith(OAUTH_BETAS), true);
    assert.ok(betaOf(seen.init.headers).split(",").map((entry) => entry.trim()).includes(ANTHROPIC_SERVER_COMPACTION_BETA));
    assert.notEqual(seen.init.headers, init.headers);
  });
}

test("server instructions are the same briefing guidance the client compaction uses", () => {
  assert.match(COMPACTION_BRIEFING_GUIDANCE, /next worker/);
  assert.match(COMPACTION_BRIEFING_GUIDANCE, /<summary><\/summary>/);
  const edit = JSON.parse(applyAnthropicServerCompaction(body(SERVER_FABLE), {}, { provider: "anthropic", contextWindow: WINDOW }).bodyText).context_management.edits[0];
  assert.equal(edit.instructions, COMPACTION_BRIEFING_GUIDANCE);
});

test("Claude has no automatic threshold: the trigger is the shared hard safety line, not 65%", async () => {
  // 1M Claude with the current catalog max output (128K). The line is the same rule the
  // notes controller uses for DeepSeek/Gemini: window - output reserve - safety margin.
  const claude = { contextWindow: 1_000_000, maxTokens: 128_000 };
  const line = hardSafetyLine(claude);
  assert.equal(anthropicServerCompactionTrigger(claude.contextWindow, claude).value, line);
  assert.notEqual(line, 650_000);
  assert.ok(line > 900_000 && line < claude.contextWindow);
  assert.equal(line, hardSafetyLine({ contextWindow: 1_000_000, maxTokens: 384_000 }), "DeepSeek-sized max output does not move the line");
  const { seen } = await send(SERVER_FABLE, { contextWindow: claude.contextWindow });
  assert.deepEqual(JSON.parse(seen.init.body).context_management.edits[0].trigger, { type: "input_tokens", value: line });
});

test("no window means no edit at all: an edit without trigger would compact at the 150K default", async () => {
  const raw = body(SERVER_OPUS);
  assert.deepEqual(applyAnthropicServerCompaction(raw, {}, { provider: "anthropic" }), { bodyText: raw, headers: {}, rewritten: false });
});

test("trigger never drops below the Anthropic 50k floor and is omitted without a window", () => {
  assert.deepEqual(anthropicServerCompactionTrigger(40_000), { type: "input_tokens", value: 50_000 });
  assert.equal(anthropicServerCompactionTrigger(undefined), undefined);
  assert.equal(anthropicServerCompactionTrigger(0), undefined);
  assert.equal(anthropicServerCompactionTrigger("nope"), undefined);
});

test("the wire stays off when a required transform did not apply", () => {
  const raw = body(SERVER_FABLE);
  const off = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic", contextWindow: WINDOW, armed: false });
  assert.equal(off.rewritten, false);
  assert.equal(off.bodyText, raw);
  const on = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic", contextWindow: WINDOW });
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
  const applied = applyAnthropicServerCompaction(body(SERVER_OPUS), headers, { provider: "anthropic", contextWindow: WINDOW });
  assert.equal(applied.rewritten, true);
  assert.equal(applied.headers["x-app"], "cli");
  assert.equal(applied.headers["anthropic-beta"], `${OAUTH_BETAS},${ANTHROPIC_SERVER_COMPACTION_BETA}`);
});

test("existing context_management edits are merged without a duplicate compact edit", () => {
  const raw = body("claude-sonnet-5", {
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE }] },
  });
  const applied = applyAnthropicServerCompaction(raw, { "anthropic-beta": OAUTH_BETAS }, { provider: "anthropic", contextWindow: WINDOW });
  const payload = JSON.parse(applied.bodyText);
  const types = payload.context_management.edits.map((edit) => edit.type);
  assert.deepEqual(types, ["clear_tool_uses_20250919", ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE]);
});
