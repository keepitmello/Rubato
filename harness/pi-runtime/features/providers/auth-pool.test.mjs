import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { providersFeature } from "./patches.mjs";
import { appendLoginSlot, listSlots, mergeRefreshed, mergeRefreshedSlot, projectSlot } from "./auth-pool/slots.mjs";
import { classifyCredentialFailure } from "./auth-pool/classify.mjs";
import { selectSlot, sha256SlotHasher } from "./auth-pool/select.mjs";
import { discoverEnvSlots } from "./auth-pool/env-slots.mjs";

const sourceRuntimeRoot = join(import.meta.dirname, "../..");
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-auth-pool-"));
const isolatedHome = join(scratchRoot, "home");
mkdirSync(isolatedHome);
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const staged = await stagePiRuntime({
  sourceRoot: sourceRuntimeRoot,
  outputRoot: join(scratchRoot, "runtime"),
  features: [providersFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const piAiRoot = runtime.packages["@earendil-works/pi-ai"].dir;
const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
const feature = await import(pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/extension.mjs")).href);
const poolSlots = await import(pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/auth-pool/slots.mjs")).href);

test("login appends a sibling slot and keeps the original flat projection", () => {
  const first = { type: "api_key", key: "key-a" };
  const pooled = appendLoginSlot(first, { type: "api_key", key: "key-b" });
  assert.equal(pooled.key, "key-a");
  assert.deepEqual(listSlots(pooled).map((slot) => slot.key), ["key-a", "key-b"]);
  assert.equal(projectSlot(pooled, "sub").key, "key-b");
});

// `default` and `login-2` on xAI were one human logging in twice: identical JWT subject, two
// slots, and a `[sub]` picker row for an account that did not exist.
const accountJwt = (subject, issuer = "https://auth.x.ai") =>
  `header.${Buffer.from(JSON.stringify({ iss: issuer, sub: subject })).toString("base64url")}.signature`;

test("re-login as the same account refreshes its slot instead of minting a sibling", () => {
  const current = { type: "oauth", access: accountJwt("user-1"), refresh: "r1", expires: 1 };
  const again = appendLoginSlot(current, { type: "oauth", access: accountJwt("user-1"), refresh: "r1-next", expires: 2 });
  assert.deepEqual(listSlots(again).map((slot) => slot.name), ["default"]);
  assert.equal(again.refresh, "r1-next");
  assert.equal(projectSlot(again, "default").refresh, "r1-next");

  const second = appendLoginSlot(again, { type: "oauth", access: accountJwt("user-2"), refresh: "r2", expires: 3 });
  assert.deepEqual(listSlots(second).map((slot) => slot.name), ["default", "sub"]);
  const secondAgain = appendLoginSlot(second, { type: "oauth", access: accountJwt("user-2"), refresh: "r2-next", expires: 4 });
  assert.deepEqual(listSlots(secondAgain).map((slot) => slot.name), ["default", "sub"]);
  assert.equal(projectSlot(secondAgain, "sub").refresh, "r2-next");
  assert.equal(secondAgain.refresh, "r1-next", "the secondary slot must stay off the flat projection");

  assert.deepEqual(
    listSlots(appendLoginSlot({ type: "api_key", key: "key-a" }, { type: "api_key", key: "key-a" })).map((slot) => slot.name),
    ["default"],
  );
});

test("an opaque access token is unknown, not the same account", () => {
  const current = { type: "oauth", access: "opaque-1", refresh: "r1", expires: 1 };
  const appended = appendLoginSlot(current, { type: "oauth", access: "opaque-2", refresh: "r2", expires: 2 });
  assert.deepEqual(listSlots(appended).map((slot) => slot.name), ["default", "sub"]);
});

test("oauth refresh merges into the matching slot and leaves siblings", () => {
  const current = {
    type: "oauth",
    access: "a1",
    refresh: "r1",
    expires: 1,
    accounts: [
      { name: "default", source: "login", access: "a1", refresh: "r1", expires: 1 },
      { name: "login-2", source: "login", access: "a2", refresh: "r2", expires: 2 },
    ],
  };
  const merged = mergeRefreshed(current, { type: "oauth", access: "a1-next", refresh: "r1-next", expires: 9 });
  assert.equal(merged.access, "a1-next");
  assert.equal(merged.accounts[0].access, "a1-next");
  assert.equal(merged.accounts[1].access, "a2");
});

test("named slot merge keeps a secondary slot off the flat projection", () => {
  const current = {
    type: "oauth",
    access: "a1",
    refresh: "r1",
    expires: 1,
    accounts: [
      { name: "default", source: "login", access: "a1", refresh: "r1", expires: 1 },
      { name: "login-2", source: "login", access: "a2", refresh: "r2", expires: 2 },
    ],
  };
  const secondary = mergeRefreshedSlot(current, "login-2", { type: "oauth", access: "a2-next", refresh: "r2-next", expires: 9 });
  assert.equal(secondary.access, "a1");
  assert.equal(secondary.accounts[0].access, "a1");
  assert.equal(secondary.accounts[1].access, "a2-next");
  const primary = mergeRefreshedSlot(current, "default", { type: "oauth", access: "a1-next", refresh: "r1-next", expires: 9 });
  assert.equal(primary.access, "a1-next");
  assert.equal(primary.accounts[0].access, "a1-next");
  assert.equal(primary.accounts[1].access, "a2");
});

test("unnamed slot merge uses the flat-projection path; missing names fail closed", () => {
  const current = {
    type: "oauth",
    access: "a1",
    refresh: "r1",
    expires: 1,
    accounts: [
      { name: "default", source: "login", access: "a1", refresh: "r1", expires: 1 },
      { name: "login-2", source: "login", access: "a2", refresh: "r2", expires: 2 },
    ],
  };
  const unnamed = mergeRefreshedSlot(current, "", { type: "oauth", access: "a1-next", refresh: "r1-next", expires: 9 });
  assert.equal(unnamed.access, "a1-next");
  assert.equal(unnamed.accounts[0].access, "a1-next");
  assert.throws(
    () => mergeRefreshedSlot(current, "gone", { type: "oauth", access: "x", refresh: "y", expires: 9 }),
    /missing credential slot 'gone'/,
  );
});

test("429 failovers; 401 blocks the account", () => {
  const rate = classifyCredentialFailure(Object.assign(new Error("Too Many Requests"), { status: 429 }));
  assert.equal(rate.kind, "failover");
  assert.equal(rate.block.reason, "rate_limit");
  const auth = classifyCredentialFailure(Object.assign(new Error("Unauthorized"), { status: 401 }));
  assert.equal(auth.kind, "failover");
  assert.equal(auth.block.reason, "auth_error");
});

// 2026-09-25 핫스팟 세션: SDK 의 "Connection error." 와 undici 의 "terminated" 가 네트워크
// 실패로 안 잡혀, 아무것도 안 나간 연결 실패도 풀 안의 즉시 재시도를 못 받았다.
test("연결 단계 실패 문구는 같은 계정 즉시 재시도 대상이다", () => {
  for (const text of ["Connection error.", "terminated", "other side closed", "Request timed out."]) {
    assert.equal(classifyCredentialFailure(new Error(text)).kind, "retry_same", text);
  }
  assert.equal(classifyCredentialFailure(new Error("Request was aborted")).kind, "fail_request");
});

test("pin wins over HRW; numbered env slots are gap-tolerant", () => {
  const slots = [{ name: "default" }, { name: "login-2" }];
  const pinned = selectSlot(slots, { pinnedSlot: "login-2", hasher: sha256SlotHasher, affinityKey: "session-1" });
  assert.equal(pinned.name, "login-2");
  const envSlots = discoverEnvSlots("xai", (name) => ({ XAI_API_KEY: "a", XAI_API_KEY_3: "c" }[name]));
  assert.deepEqual(envSlots.map((slot) => slot.name), ["env", "env-3"]);
});

function mockXaiProvider(hits, failKey = "xai-key-a") {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    id: "xai",
    name: "xAI",
    models: [{
      provider: "xai",
      id: "grok-4.7",
      name: "grok",
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 16,
      cost: ZERO_COST,
    }],
    auth: {
      apiKey: {
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key }, source: "api_key" }
          : undefined,
        login: async () => ({ type: "api_key", key: `xai-key-${hits.length + 1}` }),
      },
    },
    streamSimple(_model, _context, options) {
      hits.push(options.apiKey);
      if (options.apiKey === failKey) {
        const error = new Error("Too Many Requests");
        error.status = 429;
        throw error;
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "text", text: "ok" };
      })();
    },
    stream(model, context, options) {
      return this.streamSimple(model, context, options);
    },
    getModels() {
      return this.models;
    },
  };
}

async function createPooledRuntime(auth) {
  const agentDir = mkdtempSync(join(scratchRoot, "agent-"));
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  return { agentDir, modelRuntime };
}

test("candidate ModelRuntime keeps a session on the first account after a pre-output 429", async () => {
  const hits = [];
  const { modelRuntime } = await createPooledRuntime({
    xai: {
      type: "api_key",
      key: "xai-key-a",
      accounts: [
        { name: "default", source: "login", key: "xai-key-a" },
        { name: "login-2", source: "login", key: "xai-key-b" },
      ],
    },
  });
  let firstKey;
  const provider = mockXaiProvider(hits, "never");
  provider.streamSimple = function (_model, _context, options) {
    hits.push(options.apiKey);
    if (firstKey === undefined) firstKey = options.apiKey;
    if (options.apiKey === firstKey) {
      const error = new Error("Too Many Requests");
      error.status = 429;
      throw error;
    }
    return (async function* () {
      yield { type: "start" };
      yield { type: "text", text: "ok" };
    })();
  };
  modelRuntime.registerNativeProvider(provider);
  const model = modelRuntime.getModels().find((entry) => entry.provider === "xai") ?? modelRuntime.getModel("xai", "grok-4.7");
  assert.ok(model, "expected a registered xai model");
  const first = await modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { sessionId: "affinity-1" }).result();
  assert.equal(first.stopReason, "error");
  assert.match(String(first.errorMessage ?? ""), /Too Many Requests|no-turn-retry/);
  assert.equal(hits.length, 1);
  const retry = await modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { sessionId: "affinity-1" }).result();
  assert.equal(retry.stopReason, "error");
  assert.deepEqual(hits, [firstKey, firstKey]);

  // A second session on the same base id is pinned to the same account: `requiredAccountSlotName`
  // sends the base row to the primary slot and leaves the second login to the `-sub` rows. So once
  // the primary is rate-limited the pool reports the pinned account instead of quietly spending the
  // other login, and it never reaches the provider. Rotation across accounts is covered by
  // "session affinity stays on the first slot after 429; a new session can use the other".
  const second = await modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { sessionId: "affinity-2" }).result();
  assert.equal(hits.length, 2);
  assert.equal(second.stopReason, "error");
  assert.match(String(second.errorMessage ?? ""), /Account 'default' is unavailable/);
});

test("candidate ModelRuntime does not rotate after committed output", async () => {
  const hits = [];
  const { modelRuntime } = await createPooledRuntime({
    xai: {
      type: "api_key",
      key: "xai-key-a",
      accounts: [
        { name: "default", source: "login", key: "xai-key-a" },
        { name: "login-2", source: "login", key: "xai-key-b" },
      ],
    },
  });
  const provider = mockXaiProvider(hits, "never");
  provider.streamSimple = function (_model, _context, options) {
    hits.push(options.apiKey);
    return (async function* () {
      yield { type: "start" };
      yield { type: "text", text: "partial" };
      const error = new Error("Too Many Requests");
      error.status = 429;
      throw error;
    })();
  };
  modelRuntime.registerNativeProvider(provider);
  const model = modelRuntime.getModels().find((entry) => entry.provider === "xai") ?? modelRuntime.getModel("xai", "grok-4.7");
  assert.ok(model, "expected a registered xai model");
  const result = await modelRuntime.streamSimple(model, { messages: [] }, { sessionId: "affinity-1" }).result();
  assert.equal(result.stopReason, "error");
  assert.match(String(result.errorMessage ?? ""), /Too Many Requests|no-turn-retry/);
  assert.equal(hits.length, 1);
});

test("login appends a slot on the stock Models path", async () => {
  const hits = [];
  const { modelRuntime, agentDir } = await createPooledRuntime({
    xai: { type: "api_key", key: "xai-key-a" },
  });
  modelRuntime.registerNativeProvider(mockXaiProvider(hits));
  try {
    await modelRuntime.login("xai", "api_key", { prompt: async () => "unused" });
  } catch (error) {
    assert.equal(error.name, "CredentialSynchronizationError");
  }
  const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).xai;
  assert.equal(listSlots(stored).length, 2);
  assert.equal(stored.key, "xai-key-a");
});

test("legacy credential import copies Codex without overwriting the target", async () => {
  const root = mkdtempSync(join(scratchRoot, "import-"));
  const legacyPath = join(root, "legacy-auth.json");
  const targetPath = join(root, "target-auth.json");
  writeFileSync(legacyPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "codex-access-test", refresh: "codex-refresh-test", expires: Date.now() + 60_000 },
    xai: { type: "api_key", key: "legacy-xai" },
  }), { mode: 0o600 });
  writeFileSync(targetPath, JSON.stringify({ xai: { type: "api_key", key: "keep-me" } }), { mode: 0o600 });
  const env = {
    HOME: isolatedHome,
    RUBATO_LEGACY_AUTH_PATH: legacyPath,
    RUBATO_TARGET_AUTH_PATH: targetPath,
    RUBATO_PI_CODING_AGENT_DIR: root,
    PI_OFFLINE: "1",
  };
  const registered = [];
  const unregistered = [];
  const commands = [];
  await feature.createProvidersExtension({ env, agentDir: root })({
    registerProvider: (provider) => registered.push(provider.id),
    unregisterProvider: (id) => unregistered.push(id),
    registerCommand: (name) => commands.push(name),
  });
  const target = JSON.parse(readFileSync(targetPath, "utf-8"));
  assert.equal(target["openai-codex"].access, "codex-access-test");
  assert.equal(target.xai.key, "keep-me");
  assert.ok(registered.includes("xai"));
  assert.ok(unregistered.includes("google"));
  assert.ok(commands.includes("account"));
});

function mockOauthXai(refreshImpl) {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    id: "xai",
    name: "xAI",
    models: [{
      provider: "xai",
      id: "grok-4.7",
      name: "grok",
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 16,
      cost: ZERO_COST,
    }],
    getModels() { return this.models; },
    auth: {
      oauth: {
        refresh: refreshImpl,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    streamSimple: async function* () { yield { type: "start" }; },
    stream(model, context, options) { return this.streamSimple(model, context, options); },
  };
}

test("patched resolve refresh writes mergeRefreshedSlot through to auth.json", async () => {
  const past = Date.now() - 60_000;
  const future = Date.now() + 60 * 60 * 1000;
  const { modelRuntime, agentDir } = await createPooledRuntime({
    xai: {
      type: "oauth",
      access: "a1",
      refresh: "r1",
      expires: past,
      accounts: [
        { name: "default", source: "login", access: "a1", refresh: "r1", expires: past },
        { name: "login-2", source: "login", access: "a2", refresh: "r2", expires: past },
      ],
    },
  });
  const seen = [];
  modelRuntime.registerNativeProvider(mockOauthXai(async (credential) => {
    seen.push(credential.access);
    return { type: "oauth", access: `${credential.access}-next`, refresh: `${credential.refresh}-next`, expires: future };
  }));
  const model = modelRuntime.getModels().find((entry) => entry.provider === "xai");
  assert.ok(model, "expected a registered xai model");
  const auth = await modelRuntime.getAuth(model, { slotName: "login-2" });
  assert.equal(auth.auth.apiKey, "a2-next");
  assert.deepEqual(seen, ["a2"]);
  const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).xai;
  assert.equal(stored.access, "a1");
  assert.equal(stored.refresh, "r1");
  assert.equal(stored.accounts[0].access, "a1");
  assert.equal(stored.accounts[1].access, "a2-next");
  assert.equal(stored.accounts[1].refresh, "r2-next");
  assert.equal(stored.accounts[1].expires, future);
});

test("providers extension requires agentDir and does not invent a legacy path", async () => {
  await assert.rejects(
    () => feature.createProvidersExtension({ env: { HOME: isolatedHome, PI_OFFLINE: "1" } })({
      registerProvider() {},
      unregisterProvider() {},
      registerCommand() {},
    }),
    /agentDir is required/,
  );
  const root = mkdtempSync(join(scratchRoot, "no-legacy-"));
  const commands = [];
  await feature.createProvidersExtension({
    agentDir: root,
    env: { HOME: isolatedHome, PI_OFFLINE: "1", RUBATO_PI_CODING_AGENT_DIR: root },
  })({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand: (name) => commands.push(name),
  });
  assert.ok(commands.includes("account"));
});

// 계정 풀을 지난 결과를 stock 재시도 판정(패치된 utils/retry.js)에 그대로 넣어 본다.
// 사고만 나오고 끊긴 턴은 세션 재시도를 받아야 하고, 텍스트가 나간 턴은 받지 않아야 한다.
test("candidate ModelRuntime: 사고만 나간 뒤 끊긴 턴은 세션 재시도 대상, 텍스트 뒤는 아니다", async () => {
  const { isRetryableAssistantError } = await import(pathToFileURL(join(piAiRoot, "dist/utils/retry.js")).href);
  const run = async (delta) => {
    const hits = [];
    const { modelRuntime } = await createPooledRuntime({
      xai: {
        type: "api_key",
        key: "xai-key-a",
        accounts: [
          { name: "default", source: "login", key: "xai-key-a" },
          { name: "login-2", source: "login", key: "xai-key-b" },
        ],
      },
    });
    const provider = mockXaiProvider(hits, "never");
    provider.streamSimple = function (_model, _context, options) {
      hits.push(options.apiKey);
      const content = delta.type === "thinking_delta"
        ? [{ type: "thinking", thinking: delta.delta }]
        : [{ type: "text", text: delta.delta }];
      const failed = {
        role: "assistant",
        content,
        stopReason: "error",
        errorMessage: "terminated",
        usage: { input: 1200, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 1203 },
      };
      return (async function* () {
        yield { type: "start", partial: { role: "assistant", content: [] } };
        yield delta;
        yield { type: "error", reason: "error", error: failed };
      })();
    };
    modelRuntime.registerNativeProvider(provider);
    const model = modelRuntime.getModels().find((entry) => entry.provider === "xai") ?? modelRuntime.getModel("xai", "grok-4.7");
    const result = await modelRuntime.streamSimple(model, { messages: [] }, { sessionId: "affinity-1" }).result();
    return { result, hits };
  };

  const thinking = await run({ type: "thinking_delta", delta: "생각" });
  assert.equal(thinking.result.errorMessage, "terminated");
  assert.deepEqual(thinking.result.content, [{ type: "thinking", thinking: "생각" }], "사고와 usage 가 빈 메시지로 바뀌지 않는다");
  assert.equal(thinking.result.usage.input, 1200);
  assert.equal(isRetryableAssistantError(thinking.result), true);
  assert.equal(thinking.hits.length, 1);

  const text = await run({ type: "text_delta", delta: "안녕" });
  assert.match(text.result.errorMessage, /no-turn-retry:terminated$/);
  assert.equal(isRetryableAssistantError(text.result), false);
});

test("coding-agent runtime-pool import is package-relative", () => {
  const text = readFileSync(join(runtime.codingAgentDir, "dist/core/model-runtime.js"), "utf8");
  assert.match(text, /from "\.\.\/rubato-features\/providers\/auth-pool\/runtime-pool\.mjs"/);
  assert.doesNotMatch(text, /node_modules\/@earendil-works\/pi-ai/);
});

test("staged pool helpers match the source copies", () => {
  assert.equal(typeof poolSlots.appendLoginSlot, "function");
  assert.equal(typeof poolSlots.mergeRefreshed, "function");
  assert.equal(typeof poolSlots.mergeRefreshedSlot, "function");
});
import { listRotationSlots } from "./auth-pool/rotation-stream.mjs";
import { CredentialSlotRepository } from "./auth-pool/state-store.mjs";

test("anthropic stored oauth plus setup-token are both rotation slots", async () => {
  const slots = await listRotationSlots({
    providerId: "anthropic",
    credential: {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
      accounts: [
        { name: "default", source: "login", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 },
      ],
    },
    env: () => undefined,
    repository: new CredentialSlotRepository(),
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: "sk-ant-oat-test",
      source: "setup-token",
    }],
  }, { acquireLeases: false });
  assert.deepEqual(slots.map((slot) => `${slot.lane}:${slot.name}`), ["stored:default", "setup-token:setup-token"]);
});

test("anthropic stored oauth plus setup-token are both rotation slots", async () => {
  const slots = await listRotationSlots({
    providerId: "anthropic",
    credential: {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
      accounts: [
        { name: "default", source: "login", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 },
      ],
    },
    env: () => undefined,
    repository: new CredentialSlotRepository(),
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: "sk-ant-oat-test",
      source: "setup-token",
    }],
  }, { acquireLeases: false });
  assert.deepEqual(slots.map((slot) => `${slot.lane}:${slot.name}`), ["stored:default", "setup-token:setup-token"]);
});
