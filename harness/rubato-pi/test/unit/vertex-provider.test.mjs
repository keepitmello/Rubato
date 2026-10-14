import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DIRECT_PROVIDER_IDS, directProviders, gemini4ArgonModels } from "../../src/provider-direct.mjs";
import { SUPPORTED_PROVIDER_IDS, foreignProviderIds } from "../../src/provider-ids.mjs";
import { VERTEX_PICKER_IDS } from "../../src/picker-catalog.mjs";
import { ensureModelsConfig } from "../../src/session-defaults.mjs";
import { kRubatoStream } from "../../src/rubato-stream.mjs";
import {
  VERTEX_KEYCHAIN_ACCOUNT_ENV,
  VERTEX_KEYCHAIN_SERVICE,
  VERTEX_KEYCHAIN_SOURCE,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
  decodeKeychainValue,
  readVertexKeychainSecret,
  vertexAuthFromSecret,
  withVertexKeychain,
} from "../../src/vertex-keychain.mjs";
import { PRODUCT_MODEL_ORDER, productCatalogLabel } from "../../../../packages/model-core/src/product-model-catalog.mjs";

const ARGON_ID = "gemini-4-argon";

// 형태만 맞춘 가짜 서비스 계정. private_key 는 PEM 이 아니라서 서명 단계에서 로컬로 실패한다.
const SERVICE_ACCOUNT = Object.freeze({
  type: "service_account",
  project_id: "demo-project-123",
  private_key_id: "0000",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
  client_email: "rubato@demo-project-123.iam.gserviceaccount.com",
  client_id: "1",
  token_uri: "https://oauth2.googleapis.com/token",
});
const SERVICE_ACCOUNT_TEXT = JSON.stringify(SERVICE_ACCOUNT, null, 2);

const noEnvCtx = { env: async () => undefined, fileExists: async () => false };

async function vertexLane(options = {}) {
  const providers = await directProviders({ vertex: options });
  const vertex = providers.find((provider) => provider.id === "google-vertex");
  assert.ok(vertex, "google-vertex 레인이 없다");
  return { providers, vertex };
}

function argonModel(vertex) {
  const model = vertex.getModels().find((entry) => entry.id === ARGON_ID);
  assert.ok(model, "Argon 행이 없다");
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

test("google-vertex 는 지원 레인 맨 뒤이고 foreign 목록과 disabledProviders 에서 빠진다", () => {
  assert.equal(SUPPORTED_PROVIDER_IDS.at(-1), "google-vertex");
  assert.equal(foreignProviderIds().includes("google-vertex"), false);
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({ providers: {}, disabledProviders: ["google-vertex", "vercel-ai-gateway"] }),
    writeFile: () => {},
  });
  assert.ok(!next.disabledProviders.includes("google-vertex"), "예전에 끈 google-vertex 를 회수해야 한다");
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"));
});

test("Vertex 레인은 Argon 한 행만 피커에 올리고 pin 저장분은 그대로 둔다", async () => {
  const { providers, vertex } = await vertexLane();
  assert.deepEqual(providers.map((provider) => provider.id), [...DIRECT_PROVIDER_IDS]);
  assert.equal(vertex[kRubatoStream], true);
  assert.deepEqual([...VERTEX_PICKER_IDS], [ARGON_ID]);
  assert.deepEqual(vertex.filterModels(vertex.getModels()).map((model) => model.id), [ARGON_ID]);
  assert.ok(vertex.getModels().some((model) => model.id === "gemini-3.8-flash"));
  assert.equal(vertex.auth.oauth, undefined, "Vertex 는 OAuth 로그인을 제시하지 않는다");
});

test("Argon 행은 모델 카드의 창·출력·thinking 단계와 Vertex 정가를 싣는다", async () => {
  const { vertex } = await vertexLane();
  const argon = argonModel(vertex);
  assert.equal(argon.name, "Gemini 4 Argon");
  assert.equal(argon.api, "google-vertex");
  assert.equal(argon.provider, "google-vertex");
  assert.equal(argon.reasoning, true);
  assert.deepEqual(argon.input, ["text", "image"]);
  assert.equal(argon.contextWindow, 1_048_576);
  assert.equal(argon.maxTokens, 65_536);
  assert.deepEqual(argon.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  // MINIMAL 과 thinking_budget 은 400 이다. 고를 수 있는 단계는 low·medium·high 셋뿐이다.
  assert.deepEqual(argon.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
});

test("Argon 파생은 pin 이 앞서면 비고, 틀이 없으면 조용히 넘어가지 않는다", () => {
  assert.deepEqual(gemini4ArgonModels([{ id: ARGON_ID }, { id: "gemini-3.8-flash" }]), []);
  assert.throws(() => gemini4ArgonModels([{ id: "gemini-3.7-flash" }]), /gemini-3\.8-flash/);
});

test("제품 카탈로그는 Vertex 를 Antigravity 다음에 두고 Argon 을 이름 그대로 부른다", () => {
  assert.deepEqual([...PRODUCT_MODEL_ORDER["google-vertex"]], [...VERTEX_PICKER_IDS]);
  assert.equal(productCatalogLabel({ provider: "google-vertex", id: ARGON_ID }), "Gemini 4 Argon");
});

test("Keychain 은 서비스 vertex 로 찾고, 계정을 정하면 -a 를 붙인다", async () => {
  const calls = [];
  const value = await readVertexKeychainSecret({ spawnImpl: fakeSpawn(calls, { stdout: "secret\n" }) });
  assert.equal(value, "secret");
  await readVertexKeychainSecret({ account: "me", spawnImpl: fakeSpawn(calls, { stdout: "secret\n" }) });
  assert.deepEqual(calls, [
    ["security", "find-generic-password", "-s", VERTEX_KEYCHAIN_SERVICE, "-w"],
    ["security", "find-generic-password", "-s", VERTEX_KEYCHAIN_SERVICE, "-a", "me", "-w"],
  ]);
  assert.equal(await readVertexKeychainSecret({ spawnImpl: fakeSpawn([], { code: 44 }) }), undefined);
});

test("security 가 hex 로 찍은 JSON 은 풀고, 다른 값은 그대로 둔다", () => {
  const hex = Buffer.from(SERVICE_ACCOUNT_TEXT, "utf-8").toString("hex");
  assert.equal(decodeKeychainValue(hex), SERVICE_ACCOUNT_TEXT);
  assert.equal(decodeKeychainValue("  AQ.plain-key  "), "AQ.plain-key");
  assert.equal(decodeKeychainValue("deadbeef"), "deadbeef", "JSON 이 안 되는 hex 모양 키는 키 그대로다");
});

test("서비스 계정 JSON 은 project·location·자격증명을 요청 env 로 넘기고 API 키는 비운다", () => {
  const resolved = vertexAuthFromSecret(SERVICE_ACCOUNT_TEXT);
  assert.deepEqual(resolved.auth, {});
  assert.equal(resolved.source, VERTEX_KEYCHAIN_SOURCE);
  assert.equal(resolved.env.GOOGLE_CLOUD_PROJECT, "demo-project-123");
  assert.equal(resolved.env.GOOGLE_CLOUD_LOCATION, "global");
  assert.deepEqual(JSON.parse(resolved.env[VERTEX_SERVICE_ACCOUNT_JSON_ENV]), SERVICE_ACCOUNT);
  assert.equal(vertexAuthFromSecret(SERVICE_ACCOUNT_TEXT, { location: "us" }).env.GOOGLE_CLOUD_LOCATION, "us");

  assert.deepEqual(vertexAuthFromSecret("AQ.express-key"), { auth: { apiKey: "AQ.express-key" }, source: VERTEX_KEYCHAIN_SOURCE });
  assert.equal(vertexAuthFromSecret(JSON.stringify({ type: "authorized_user" })), undefined, "서비스 계정이 아닌 JSON 은 키로 보내지 않는다");
  assert.equal(vertexAuthFromSecret(""), undefined);
});

test("native 자격증명이 먼저고, 없을 때만 Keychain 을 읽는다", async () => {
  let lookups = 0;
  const provider = withVertexKeychain(
    { auth: { apiKey: { resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined) } } },
    { env: {}, keychainLookup: async () => { lookups++; return SERVICE_ACCOUNT_TEXT; } },
  );
  const stored = await provider.auth.apiKey.resolve({ ctx: noEnvCtx, credential: { type: "api_key", key: "stored" } });
  assert.equal(stored.source, "stored credential");
  assert.equal(lookups, 0);
  const fromKeychain = await provider.auth.apiKey.resolve({ ctx: noEnvCtx, credential: undefined });
  assert.equal(fromKeychain.source, VERTEX_KEYCHAIN_SOURCE);
  assert.equal(lookups, 1);
});

test("계정 env 를 Keychain 조회에 넘기고, 조회 실패는 unavailable, 취소는 던진다", async () => {
  const seen = [];
  const native = { auth: { apiKey: { resolve: async () => undefined } } };
  const provider = withVertexKeychain(native, {
    env: { [VERTEX_KEYCHAIN_ACCOUNT_ENV]: "huracan" },
    keychainLookup: async ({ account }) => { seen.push(account); return undefined; },
  });
  assert.equal(await provider.auth.apiKey.resolve({ ctx: noEnvCtx }), undefined);
  assert.deepEqual(seen, ["huracan"]);

  const broken = withVertexKeychain(native, { env: {}, keychainLookup: async () => { throw new Error("locked"); } });
  assert.equal(await broken.auth.apiKey.resolve({ ctx: noEnvCtx }), undefined);

  const controller = new AbortController();
  controller.abort();
  const aborting = withVertexKeychain(native, {
    env: {},
    keychainLookup: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
  });
  await assert.rejects(aborting.auth.apiKey.resolve({ ctx: noEnvCtx, signal: controller.signal }), /aborted/);
});

test("env 가 없어도 Keychain 서비스 계정만으로 directProviders 의 Vertex 가 풀린다", async () => {
  const { vertex } = await vertexLane({ keychainLookup: async () => SERVICE_ACCOUNT_TEXT, env: {} });
  const resolved = await vertex.auth.apiKey.resolve({ ctx: noEnvCtx, credential: undefined, signal: new AbortController().signal });
  assert.equal(resolved?.source, VERTEX_KEYCHAIN_SOURCE);
  assert.equal(resolved.env.GOOGLE_CLOUD_PROJECT, "demo-project-123");
});

async function argonPayload(reasoning) {
  const { vertex } = await vertexLane();
  let payload;
  const events = await collect(vertex.streamSimple(
    argonModel(vertex),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    {
      maxRetries: 0,
      ...(reasoning ? { reasoning } : {}),
      env: vertexAuthFromSecret(SERVICE_ACCOUNT_TEXT).env,
      onPayload: (params) => {
        payload = params;
        throw new Error("payload-only");
      },
    },
  ));
  assert.equal(events.at(-1).type, "error");
  return payload;
}

test("Argon 은 thinking_budget 이 아니라 thinking_level 로 나간다 (budget 은 Vertex 가 400 으로 거절한다)", async () => {
  const high = await argonPayload("high");
  assert.equal(high.model, ARGON_ID);
  assert.deepEqual(high.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "HIGH" });
  // 끔은 고를 수 있는 가장 낮은 단계로 내려간다. MINIMAL 이나 budget 0 은 400 이다.
  const off = await argonPayload(undefined);
  assert.deepEqual(off.config.thinkingConfig, { thinkingLevel: "LOW" });
});

test("요청 env 의 서비스 계정 JSON 으로 인증한다 — ADC 를 찾지 않고 그 키로 서명하다 로컬에서 실패한다", async (t) => {
  const { vertex } = await vertexLane();
  // SDK 는 자격증명을 받을 때마다 console.debug 로 안내를 찍는다. 그 줄이 TUI·엔진 stdout 에 새면 안 된다.
  const debugged = [];
  t.mock.method(console, "debug", (...args) => debugged.push(args.join(" ")));
  const events = await collect(vertex.streamSimple(
    argonModel(vertex),
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { maxRetries: 0, reasoning: "low", env: vertexAuthFromSecret(SERVICE_ACCOUNT_TEXT).env },
  ));
  assert.deepEqual(debugged, []);
  const last = events.at(-1);
  assert.equal(last.type, "error");
  const message = last.error?.errorMessage ?? "";
  assert.doesNotMatch(message, /default credentials|GOOGLE_APPLICATION_CREDENTIALS/i);
  assert.match(message, /DECODER|key|PEM|asymmetric/i);
});
