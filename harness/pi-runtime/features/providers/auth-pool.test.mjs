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
  assert.equal(projectSlot(pooled, "login-2").key, "key-b");
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
      id: "grok-4.6",
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

test("candidate ModelRuntime rotates a second stored account after a pre-output 429", async () => {
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
  modelRuntime.registerNativeProvider(mockXaiProvider(hits));
  const model = modelRuntime.getModels().find((entry) => entry.provider === "xai") ?? modelRuntime.getModel("xai", "grok-4.6");
  assert.ok(model, "expected a registered xai model");
  const stream = modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { sessionId: "affinity-1" });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(hits.length, 2);
  assert.ok(hits.includes("xai-key-a"));
  assert.ok(hits.includes("xai-key-b"));
  assert.equal(events.at(-1).text, "ok");
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
  const model = modelRuntime.getModels().find((entry) => entry.provider === "xai") ?? modelRuntime.getModel("xai", "grok-4.6");
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
      id: "grok-4.6",
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
