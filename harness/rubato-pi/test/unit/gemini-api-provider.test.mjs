import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DIRECT_PROVIDER_IDS, directProviders, gemini4HydrogenModels } from "../../src/provider-direct.mjs";
import { SUPPORTED_PROVIDER_IDS, foreignProviderIds } from "../../src/provider-ids.mjs";
import { GEMINI_API_PICKER_IDS } from "../../src/picker-catalog.mjs";
import { ensureModelsConfig } from "../../src/session-defaults.mjs";
import { kRubatoStream } from "../../src/rubato-stream.mjs";
import {
  GEMINI_KEYCHAIN_SERVICE,
  GEMINI_KEYCHAIN_SOURCE,
  GEMINI_PROVIDER_ID,
  readGeminiKeychainSecret,
  withGeminiKeychain,
} from "../../src/gemini-keychain.mjs";
import { readGeminiRequests } from "../../src/gemini-request-count.mjs";
import { PRODUCT_MODEL_ORDER, productCatalogLabel } from "../../../../packages/model-core/src/product-model-catalog.mjs";

const HYDROGEN_ID = "gemini-4-hydrogen";
const noEnvCtx = { env: async () => undefined, fileExists: async () => false };

// 요청 수는 실제 agent 폴더가 아니라 시험마다 새 폴더에 센다.
const requestsPath = join(mkdtempSync(join(tmpdir(), "rubato-gemini-lane-")), "gemini-requests.json");

async function geminiLane(options = {}) {
  const providers = await directProviders({ gemini: { requestsPath, ...options } });
  const gemini = providers.find((provider) => provider.id === GEMINI_PROVIDER_ID);
  assert.ok(gemini, "google 레인이 없다");
  return { providers, gemini };
}

function hydrogenModel(gemini) {
  const model = gemini.getModels().find((entry) => entry.id === HYDROGEN_ID);
  assert.ok(model, "Hydrogen 행이 없다");
  return model;
}

function fakeSpawn(calls, { stdout = "", code = 0 } = {}) {
  return (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("google 은 지원 레인 맨 뒤이고 foreign 목록과 disabledProviders 에서 빠진다", () => {
  assert.equal(SUPPORTED_PROVIDER_IDS.at(-1), GEMINI_PROVIDER_ID);
  assert.equal(foreignProviderIds().includes(GEMINI_PROVIDER_ID), false);
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({ providers: {}, disabledProviders: [GEMINI_PROVIDER_ID, "vercel-ai-gateway"] }),
    writeFile: () => {},
  });
  assert.ok(!next.disabledProviders.includes(GEMINI_PROVIDER_ID), "예전에 끈 google 을 회수해야 한다");
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"));
});

test("Gemini API 레인은 Hydrogen 한 행만 피커에 올리고 pin 저장분은 그대로 둔다", async () => {
  const { providers, gemini } = await geminiLane();
  assert.deepEqual(providers.map((provider) => provider.id), [...DIRECT_PROVIDER_IDS]);
  assert.equal(gemini[kRubatoStream], true);
  assert.deepEqual([...GEMINI_API_PICKER_IDS], [HYDROGEN_ID]);
  assert.deepEqual(gemini.filterModels(gemini.getModels()).map((model) => model.id), [HYDROGEN_ID]);
  assert.ok(gemini.getModels().some((model) => model.id === "gemini-3.8-flash"));
  assert.equal(gemini.auth.oauth, undefined, "Gemini API 는 OAuth 로그인을 제시하지 않는다");
});

test("Hydrogen 행은 API 메타데이터의 창·출력·thinking 단계와 Gemini API 정가를 싣는다", async () => {
  const { gemini } = await geminiLane();
  const hydrogen = hydrogenModel(gemini);
  assert.equal(hydrogen.name, "Gemini 4 Hydrogen");
  assert.equal(hydrogen.api, "google-generative-ai");
  assert.equal(hydrogen.provider, GEMINI_PROVIDER_ID);
  assert.equal(hydrogen.reasoning, true);
  assert.deepEqual(hydrogen.input, ["text", "image"]);
  assert.equal(hydrogen.contextWindow, 1_048_576);
  assert.equal(hydrogen.maxTokens, 65_536);
  assert.deepEqual(hydrogen.cost, { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
  // MINIMAL 은 400 이다. 고를 수 있는 단계는 low·medium·high 셋이다.
  assert.deepEqual(hydrogen.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
});

test("Hydrogen 파생은 pin 이 앞서면 비고, 틀이 없으면 조용히 넘어가지 않는다", () => {
  assert.deepEqual(gemini4HydrogenModels([{ id: HYDROGEN_ID }, { id: "gemini-3.8-flash" }]), []);
  assert.throws(() => gemini4HydrogenModels([{ id: "gemini-3.7-flash" }]), /gemini-3\.8-flash/);
});

test("제품 카탈로그는 google 을 Vertex 다음에 두고 Hydrogen 을 이름 그대로 부른다", () => {
  assert.deepEqual([...PRODUCT_MODEL_ORDER[GEMINI_PROVIDER_ID]], [...GEMINI_API_PICKER_IDS]);
  assert.equal(productCatalogLabel({ provider: GEMINI_PROVIDER_ID, id: HYDROGEN_ID }), "Gemini 4 Hydrogen");
});

test("Keychain 은 서비스 gemini 로 찾고, 없으면 undefined 다", async () => {
  const calls = [];
  assert.equal(await readGeminiKeychainSecret({ spawnImpl: fakeSpawn(calls, { stdout: "secret\n" }) }), "secret");
  assert.deepEqual(calls, [["security", "find-generic-password", "-s", GEMINI_KEYCHAIN_SERVICE, "-w"]]);
  assert.equal(await readGeminiKeychainSecret({ spawnImpl: fakeSpawn([], { code: 44 }) }), undefined);
});

test("native GEMINI_API_KEY 가 먼저고, 없을 때만 Keychain 을 읽는다", async () => {
  let lookups = 0;
  const { gemini } = await geminiLane({ keychainLookup: async () => { lookups++; return "keychain-key"; } });
  const signal = new AbortController().signal;
  const fromEnv = await gemini.auth.apiKey.resolve({
    ctx: { env: async (name) => (name === "GEMINI_API_KEY" ? "env-key" : undefined) },
    credential: undefined,
    signal,
  });
  assert.equal(fromEnv?.auth?.apiKey, "env-key");
  assert.equal(lookups, 0);
  const fromKeychain = await gemini.auth.apiKey.resolve({ ctx: noEnvCtx, credential: undefined, signal });
  assert.deepEqual(fromKeychain, { auth: { apiKey: "keychain-key" }, source: GEMINI_KEYCHAIN_SOURCE });
  assert.equal(lookups, 1);
});

test("Keychain 조회 실패는 unavailable, 취소는 던진다", async () => {
  const native = { auth: { apiKey: { resolve: async () => undefined } } };
  const broken = withGeminiKeychain(native, { keychainLookup: async () => { throw new Error("locked"); } });
  assert.equal(await broken.auth.apiKey.resolve({ ctx: noEnvCtx }), undefined);

  const controller = new AbortController();
  controller.abort();
  const aborting = withGeminiKeychain(native, {
    keychainLookup: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
  });
  await assert.rejects(aborting.auth.apiKey.resolve({ ctx: noEnvCtx, signal: controller.signal }), /aborted/);
});

async function hydrogenPayload(reasoning) {
  const { gemini } = await geminiLane();
  let payload;
  const events = await collect(gemini.streamSimple(
    hydrogenModel(gemini),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    {
      maxRetries: 0,
      apiKey: "test-key",
      ...(reasoning ? { reasoning } : {}),
      onPayload: (params) => {
        payload = params;
        throw new Error("payload-only");
      },
    },
  ));
  assert.equal(events.at(-1).type, "error");
  return payload;
}

test("Hydrogen 은 thinking_budget 이 아니라 thinking_level 로 나간다", async () => {
  const high = await hydrogenPayload("high");
  assert.equal(high.model, HYDROGEN_ID);
  assert.deepEqual(high.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "HIGH" });
  // 끔은 고를 수 있는 가장 낮은 단계로 내려간다. MINIMAL 은 400 이다.
  const off = await hydrogenPayload(undefined);
  assert.deepEqual(off.config.thinkingConfig, { thinkingLevel: "LOW" });
});

test("레인은 Hydrogen 요청이 나갈 때마다 오늘 수를 센다", async () => {
  const before = Number(readGeminiRequests(requestsPath).models[HYDROGEN_ID]) || 0;
  await hydrogenPayload("low");
  assert.equal(readGeminiRequests(requestsPath).models[HYDROGEN_ID], before + 1);
});
