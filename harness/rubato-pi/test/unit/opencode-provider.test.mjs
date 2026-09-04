import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DIRECT_PROVIDER_IDS, directProviders } from "../../src/provider-direct.mjs";
import { SUPPORTED_PROVIDER_IDS, foreignProviderIds } from "../../src/provider-ids.mjs";
import { OPENCODE_PICKER_IDS } from "../../src/picker-catalog.mjs";
import { ensureModelsConfig } from "../../src/session-defaults.mjs";
import providerOverlayImpl from "../../src/extensions/provider-overlay.mjs";
import { kRubatoStream } from "../../src/rubato-stream.mjs";

const MUSE_ID = "muse-spark-1.3-contributor-free";
const ZEN_URL = "https://opencode.ai/zen/v1";

function recordingPi() {
  const calls = [];
  const registered = new Map();
  return {
    calls,
    registered,
    registerProvider(provider) {
      calls.push({ op: "register", id: provider.id });
      registered.set(provider.id, provider);
    },
    unregisterProvider(id) {
      calls.push({ op: "unregister", id });
      registered.delete(id);
    },
    log() {},
  };
}

function isolatedDirectEnv(t) {
  const root = mkdtempSync(join(tmpdir(), "rubato-opencode-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    RUBATO_PROVIDER_DIRECT: "1",
    RUBATO_LEGACY_AUTH_PATH: join(root, "legacy-auth.json"),
    RUBATO_TARGET_AUTH_PATH: join(root, "target-auth.json"),
  };
}

const providerOverlay = (pi, options = {}) => providerOverlayImpl(pi, {
  antigravityCredentialImporter: async () => ({ status: "keychain_unavailable" }),
  ...options,
});

async function opencodeProvider() {
  const providers = await directProviders();
  const opencode = providers.at(-1);
  assert.equal(opencode.id, "opencode");
  return { providers, opencode };
}

function museModel(opencode) {
  const model = opencode.getModels().find((entry) => entry.id === MUSE_ID);
  assert.ok(model, "pinned catalog 에 muse-spark-1.3-contributor-free 가 없다");
  return { ...model, provider: opencode.id, baseUrl: model.baseUrl };
}

test("SUPPORTED 에 opencode 가 있고 foreign 목록에서는 빠진다", () => {
  assert.ok(SUPPORTED_PROVIDER_IDS.includes("opencode"));
  assert.equal(foreignProviderIds().includes("opencode"), false);
});

test("disabled 로 남은 opencode 는 models.json 갱신 때 회수된다", () => {
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({
      providers: {},
      disabledProviders: ["opencode", "vercel-ai-gateway"],
    }),
    writeFile: () => {},
  });
  assert.ok(!next.disabledProviders.includes("opencode"), "stale opencode 를 회수해야 한다");
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"));
});

test("directProviders 맨 뒤가 opencode 이고 앞 순서는 그대로다", async () => {
  const { providers } = await opencodeProvider();
  assert.deepEqual(providers.map((provider) => provider.id), [...DIRECT_PROVIDER_IDS]);
  assert.equal(providers[0].id, "openai-codex");
  assert.equal(providers[1].id, "xai");
  assert.equal(providers[2].id, "cursor");
  assert.equal(providers[3].id, "anthropic");
  assert.equal(providers[4].id, "kiro");
  assert.equal(providers[5].id, "google-antigravity");
  assert.equal(providers[6].id, "opencode");
});

test("OpenCode 는 pinned Muse Spark 1.3 Free 를 그대로 싣는다", async () => {
  const { opencode } = await opencodeProvider();
  assert.equal(opencode.name, "OpenCode Zen");
  assert.equal(opencode[kRubatoStream], true);
  assert.deepEqual([...OPENCODE_PICKER_IDS], [MUSE_ID]);

  const muse = opencode.getModels().find((model) => model.id === MUSE_ID);
  assert.ok(muse);
  assert.equal(muse.name, "Muse Spark 1.3 Free");
  assert.equal(muse.api, "openai-responses");
  assert.equal(muse.baseUrl, ZEN_URL);
  assert.equal(muse.reasoning, true);
  assert.deepEqual(muse.input, ["text", "image"]);
  assert.equal(muse.contextWindow, 1_048_576);
  assert.equal(muse.maxTokens, 131_072);
  assert.deepEqual(muse.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(muse.compat, { sessionAffinityFormat: "openai-nosession" });
  assert.deepEqual(muse.thinkingLevelMap, {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  });
});

test("OPENCODE_API_KEY 가 없어도 overlay 부팅은 통과하고 OpenCode 만 키가 없다", async (t) => {
  const env = isolatedDirectEnv(t);
  delete env.OPENCODE_API_KEY;
  const pi = recordingPi();
  const keychainLookup = async () => undefined;
  await providerOverlay(pi, { env, opencode: { keychainLookup } });

  for (const id of DIRECT_PROVIDER_IDS) {
    assert.ok(pi.registered.get(id), `${id} 가 등록되지 않았다`);
  }
  const unregistered = pi.calls.filter((call) => call.op === "unregister").map((call) => call.id);
  assert.ok(!unregistered.includes("opencode"), "정리 단계가 opencode 를 지웠다");

  const opencode = pi.registered.get("opencode");
  const signal = new AbortController().signal;
  const missing = await opencode.auth.apiKey.resolve({
    ctx: { env: async () => undefined },
    credential: undefined,
    signal,
  });
  assert.equal(missing, undefined, "키 없이 OpenCode 가 available 이면 안 된다");

  const present = await opencode.auth.apiKey.resolve({
    ctx: { env: async (name) => (name === "OPENCODE_API_KEY" ? "test-key" : undefined) },
    credential: undefined,
    signal,
  });
  assert.equal(present?.auth?.apiKey, "test-key");
  assert.equal(present?.source, "OPENCODE_API_KEY");
});

test("Keychain 키가 있으면 env 없이 OpenCode 가 available 이다", async () => {
  const providers = await directProviders({
    opencode: { keychainLookup: async () => "keychain-zen-key" },
  });
  const opencode = providers.at(-1);
  const signal = new AbortController().signal;
  const resolved = await opencode.auth.apiKey.resolve({
    ctx: { env: async () => undefined },
    credential: undefined,
    signal,
  });
  assert.equal(resolved?.auth?.apiKey, "keychain-zen-key");
  assert.equal(resolved?.source, "opencode.ai Keychain");
});

test("Muse 요청 payload 는 무료 모델 id 와 pin thinking map 을 유지한다", async () => {
  const { opencode } = await opencodeProvider();
  const model = museModel(opencode);
  let payload;
  const events = [];
  for await (const event of opencode.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    {
      apiKey: "test-key",
      maxRetries: 0,
      reasoning: "high",
      sessionId: "sess-test",
      fetch: async () => {
        throw new Error("payload-only");
      },
      onPayload: (params) => {
        payload = params;
        return params;
      },
      env: {},
    },
  )) {
    events.push(event);
  }

  assert.ok(payload, "onPayload 가 호출되지 않았다");
  assert.equal(payload.model, MUSE_ID, "유료 Muse 로 fallback 하면 안 된다");
  assert.equal(payload.store, false);
  assert.equal(payload.reasoning?.effort, "high");
  assert.ok(!Object.hasOwn(payload, "previous_response_id"));
  const last = events.at(-1);
  assert.equal(last?.type, "error");
});
