import assert from "node:assert/strict";
import test from "node:test";
import { ANTHROPIC_SERVER_COMPACTION_MODEL_IDS } from "./context-budget.mjs";
import { ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE } from "./anthropic-server-compaction.mjs";
import { ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN, anthropicServerCompactionTrigger, applyAnthropicServerCompactionParams, compactNowPayload } from "./anthropic-server-compaction-wire.mjs";
import { COMPACT_CONTEXT_TOOL, COMPACT_NOW_FACTORY_NAME, createCompactNowExtension } from "./compact-now.mjs";
import { createCompactionExtensionFactories } from "./index.mjs";

const CLAUDE = { provider: "anthropic", api: "anthropic-messages", id: ANTHROPIC_SERVER_COMPACTION_MODEL_IDS.at(-1), contextWindow: 1_000_000, maxTokens: 128_000 };
const GROK = { provider: "xai", id: "grok-4.7", contextWindow: 500_000, maxTokens: 128_000 };

function load({ armed = () => true } = {}) {
  const tools = new Map();
  const handlers = new Map();
  createCompactNowExtension({ armed })({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
  });
  const tool = tools.get(COMPACT_CONTEXT_TOOL);
  const call = (model) => tool.execute("call-1", {}, undefined, undefined, { model });
  const send = (payload) => handlers.get("before_provider_request")({ type: "before_provider_request", payload }) ?? payload;
  return { tool, call, send };
}

const request = (model = CLAUDE, extra = {}) => applyAnthropicServerCompactionParams({ model: model.id, max_tokens: 32_000, messages: [], ...extra }, model);
const triggerOf = (payload) => payload.context_management?.edits?.find((edit) => edit.type === ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE)?.trigger;

test("compact_context makes the next request compact on the server, once", async () => {
  const segno = load();
  const safetyLine = anthropicServerCompactionTrigger(CLAUDE.contextWindow, CLAUDE);
  assert.deepEqual(triggerOf(segno.send(request())), safetyLine, "before the call: the safety line");
  const answer = await segno.call(CLAUDE);
  assert.equal(answer.details.compacting, true);
  const compacting = segno.send(request());
  assert.deepEqual(triggerOf(compacting), { type: "input_tokens", value: ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN });
  assert.ok(compacting.betas.includes("compact-2026-01-12"), "the beta the edit needs is still there");
  assert.deepEqual(triggerOf(segno.send(request())), safetyLine, "the request after it is back at the safety line");
});

test("the cache warmer's replay does not take the compaction", async () => {
  const segno = load();
  await segno.call(CLAUDE);
  const warm = segno.send(request(CLAUDE, { max_tokens: 1 }));
  assert.notEqual(triggerOf(warm).value, ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN);
  assert.equal(triggerOf(segno.send(request())).value, ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN, "the next real request does");
});

test("without server compaction the tool says so and no request changes", async () => {
  const other = load();
  const answer = await other.call(GROK);
  assert.equal(answer.details.compacting, false);
  assert.match(answer.content[0].text, /new_context/);
  const payload = { model: GROK.id, max_tokens: 1000, messages: [] };
  assert.equal(other.send(payload), payload);

  const disarmed = load({ armed: () => false });
  assert.equal((await disarmed.call(CLAUDE)).details.compacting, false, "an adapter that would drop the block is not used");
  assert.deepEqual(triggerOf(disarmed.send(request())), anthropicServerCompactionTrigger(CLAUDE.contextWindow, CLAUDE));
});

test("compactNowPayload lowers only an edit that is already there", () => {
  assert.equal(compactNowPayload({ messages: [] }), undefined);
  const payload = request();
  const lowered = compactNowPayload(payload);
  assert.notEqual(lowered, payload, "the request is not changed in place");
  assert.notEqual(triggerOf(payload).value, ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN);
});

test("only the companion gets compact_context", () => {
  const names = (env) => createCompactionExtensionFactories({ settingsManager: {}, env }).map((factory) => factory.name);
  assert.ok(names({ RUBATO_PI_ROLE: "companion" }).includes(COMPACT_NOW_FACTORY_NAME));
  for (const env of [{}, { RUBATO_PI_ROLE: "lead" }, { RUBATO_PI_ROLE: "owner" }]) {
    assert.ok(!names(env).includes(COMPACT_NOW_FACTORY_NAME), JSON.stringify(env));
  }
});
