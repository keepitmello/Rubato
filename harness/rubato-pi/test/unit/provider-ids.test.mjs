import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

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

// 카탈로그는 **stock Pi** 에서 읽는다. 예전에는 은퇴한 senpi 포크
// (`senpiNested`)에서 읽어서, 0.86.1 이 builtin `meta` 를 추가했을 때
// 감지기가 침묵했다 — 그 사이 `meta` 는 foreign 으로 분류돼 Rubato
// 프로바이더 표면으로 샜다.
const here = dirname(fileURLToPath(import.meta.url));
const STOCK_CATALOG = join(
  here,
  "../../../pi-runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
);

test("frozen builtin ids cover every installed stock pi-ai builtin", async (t) => {
  if (!existsSync(STOCK_CATALOG)) {
    t.skip("harness/pi-runtime is not installed; run `npm ci` there to check catalog drift");
    return;
  }
  const catalog = await import(pathToFileURL(STOCK_CATALOG).href);
  const live = [
    ...new Set([
      ...catalog.getBuiltinProviders(),
      ...catalog.builtinProviders().map((provider) => provider.id),
    ]),
  ].sort();
  // 방향이 하나뿐인 게 요점이다: 스냅샷에 **없는** builtin 이 문제다 —
  // 그건 foreign 으로 분류돼 Rubato 표면으로 샌다. 스냅샷이 실제보다
  // 많이 담고 있는 것은 무해하다 (없는 id 를 제외해도 아무 일이 없다).
  const frozen = new Set(BUILTIN_PROVIDER_IDS);
  const missing = live.filter((id) => !frozen.has(id));
  assert.deepEqual(missing, [], `stock Pi builtins missing from BUILTIN_PROVIDER_IDS: ${missing.join(", ")}`);
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
