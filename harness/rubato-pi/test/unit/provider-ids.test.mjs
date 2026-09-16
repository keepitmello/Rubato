import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { senpiNested } from "../../src/engine-paths.mjs";
import {
  BUILTIN_PROVIDER_IDS,
  SUPPORTED_PROVIDER_IDS,
  builtinProviderIds,
  foreignProviderIds,
  installOpenAiApiRefusal,
  refuseOpenAiApiModel,
} from "../../src/provider-ids.mjs";

test("supported ids stay out of the foreign disable list", () => {
  const foreign = foreignProviderIds(builtinProviderIds());
  for (const id of SUPPORTED_PROVIDER_IDS) {
    assert.equal(foreign.includes(id), false, id);
  }
  assert.ok(foreign.includes("vercel-ai-gateway"));
  assert.ok(foreign.includes("alibaba-token-plan"));
  assert.ok(foreign.includes("openai"));
});

test("frozen builtin ids match the installed pi-ai catalog union", async () => {
  const catalog = await import(
    pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/all.js")).href
  );
  const live = [
    ...new Set([
      ...catalog.getBuiltinProviders(),
      ...catalog.builtinProviders().map((provider) => provider.id),
    ]),
  ].sort();
  assert.deepEqual([...BUILTIN_PROVIDER_IDS].sort(), live);
});

test("openai API model selection and requests are refused", () => {
  assert.doesNotThrow(() => refuseOpenAiApiModel({ provider: "openai-codex", id: "gpt-6-astra" }));
  assert.throws(
    () => refuseOpenAiApiModel({ provider: "openai", id: "gpt-6-astra" }),
    /OpenAI API is disabled/,
  );
  const events = [];
  const pi = { on: (name, handler) => events.push([name, handler]) };
  installOpenAiApiRefusal(pi);
  assert.deepEqual(events.map(([name]) => name), ["model_select", "before_provider_request"]);
  const select = events[0][1];
  const request = events[1][1];
  assert.doesNotThrow(() => select({ model: { provider: "openai-codex", id: "gpt-6-astra" } }));
  assert.throws(() => select({ model: { provider: "openai", id: "gpt-5.5" } }), /OpenAI API is disabled/);
  assert.throws(
    () => request({}, { model: { provider: "openai", id: "gpt-6-astra" } }),
    /OpenAI API is disabled/,
  );
});
