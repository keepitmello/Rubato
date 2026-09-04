// 직결 경로의 계약. pinned factory 를 그대로 쓴다 — shape mock 은 "우리가 상상한
// provider" 를 검사하는 것이고, 실제 등록에서 터지는 것은 상상과 다른 지점이다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  credentialShapeWith,
  importLegacyDirectCredentials,
  readLegacyCandidates,
} from "../../src/credential-import.mjs";
import {
  DIRECT_PROVIDER_IDS,
  PROVIDER_DIRECT_FLAG,
  daybreakModels,
  directProviders,
  fable51Models,
  providerDirectEnabled,
  warnIgnoredDirectOptOut,
} from "../../src/provider-direct.mjs";
import providerOverlayImpl from "../../src/extensions/provider-overlay.mjs";
import { kRubatoStream } from "../../src/rubato-stream.mjs";

const CATALOG = [
  { id: "xai/grok-4.6", name: "Grok 4.6" },
  { id: "openai-codex/gpt-5.6-sol", name: "Sol" },
  { id: "anthropic/claude-opus-5", name: "Opus 5" },
  { id: "kiro/claude-opus-5", name: "Opus 5 (Kiro)" },
];

/** 등록 순서를 그대로 기록하는 pi 대역. 순서가 계약이므로 순서를 본다. */
function recordingPi() {
  const calls = [];
  const registered = new Map();
  return {
    calls,
    registered,
    registerProvider(provider) {
      // `createProvider` 산물도 native 와 **같은** top-level 모양이다(stream/streamSimple
      // 이 provider 에 직접 달린다). 그래서 모양으로는 두 경로를 못 가른다 — 실제로
      // 다른 것은 어디로 보내는지, 즉 baseUrl 이다.
      calls.push({ op: "register", id: provider.id, baseUrl: provider.baseUrl });
      registered.set(provider.id, provider);
    },
    unregisterProvider(id) {
      calls.push({ op: "unregister", id });
      registered.delete(id);
    },
    log() {},
  };
}

const antigravityCredentialImporter = async () => ({ status: "keychain_unavailable" });
const providerOverlay = (pi, options = {}) => providerOverlayImpl(pi, {
  antigravityCredentialImporter,
  ...options,
});

function isolatedDirectEnv(t) {
  const root = mkdtempSync(join(tmpdir(), "rubato-direct-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    RUBATO_PROVIDER_DIRECT: "1",
    RUBATO_LEGACY_AUTH_PATH: join(root, "legacy-auth.json"),
    RUBATO_TARGET_AUTH_PATH: join(root, "target-auth.json"),
  };
}

test("플래그 파싱은 그대로고, 이제 경로를 가르지 않는다", () => {
  assert.equal(PROVIDER_DIRECT_FLAG, "RUBATO_PROVIDER_DIRECT");
  assert.equal(providerDirectEnabled({}), false);
  assert.equal(providerDirectEnabled({ RUBATO_PROVIDER_DIRECT: "0" }), false);
  assert.equal(providerDirectEnabled({ RUBATO_PROVIDER_DIRECT: "true" }), false);
  assert.equal(providerDirectEnabled({ RUBATO_PROVIDER_DIRECT: "1" }), true);
});

// FX bridge 가 삭제되면서 `=0` 이 고를 다른 경로가 없어졌다. 조용히 무시하면 사용자는
// 자신이 직결을 끈 상태로 돌고 있다고 믿는다. 한 줄 경고가 그 오해를 막는다.
test("예전 opt-out 은 무시되지만 조용하지는 않다", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(warnIgnoredDirectOptOut({}, warn), false, "값이 없는 것은 정상이다");
  assert.equal(warnIgnoredDirectOptOut({ RUBATO_PROVIDER_DIRECT: "1" }, warn), false);
  assert.deepEqual(warnings, [], "정상 구성에서 경고를 내면 소음이 된다");

  assert.equal(warnIgnoredDirectOptOut({ RUBATO_PROVIDER_DIRECT: "0" }, warn), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RUBATO_PROVIDER_DIRECT/);
  assert.match(warnings[0], /ignored/);
  // 값은 싣지 않는다 — 이름과 고정된 사유뿐이다.
  assert.doesNotMatch(warnings[0], /8788/);
});

// 예전에는 이 자리에 "OFF: 모든 provider 가 bridge 경로로 남는다" 가 있었다. bridge 가
// 없으므로 남을 곳이 없다. 그 계약을 대신하는 것은 "플래그와 무관하게 native 로 등록된다"다.
test("플래그를 주지 않아도 native 로 등록된다 — 돌아갈 bridge 가 없다", async (t) => {
  const pi = recordingPi();
  const env = isolatedDirectEnv(t);
  delete env.RUBATO_PROVIDER_DIRECT;
  await providerOverlay(pi, { env });
  for (const id of DIRECT_PROVIDER_IDS) {
    const provider = pi.registered.get(id);
    assert.ok(provider, `${id} 가 등록되지 않았다`);
    assert.equal(provider[kRubatoStream], true, `${id} 가 Rubato decorator 로 감싸지지 않았다`);
    assert.notEqual(provider.baseUrl, "http://127.0.0.1:8788", `${id} 가 삭제된 bridge 를 가리킨다`);
  }
  // 각 id 는 정확히 한 번 등록된다. 예전에는 bridge 등록을 native 가 덮어서 2였다.
  for (const id of ["openai-codex", "xai"]) {
    const registrations = pi.calls.filter((call) => call.op === "register" && call.id === id);
    assert.equal(registrations.length, 1, `${id} 를 ${registrations.length} 번 등록했다`);
  }
});

test("지원 provider 전부가 native 로 등록된다", async (t) => {
  const pi = recordingPi();
  await providerOverlay(pi, { env: isolatedDirectEnv(t) });

  for (const id of DIRECT_PROVIDER_IDS) {
    const provider = pi.registered.get(id);
    assert.ok(provider, `${id} 가 등록되지 않았다`);
    assert.equal(typeof provider.stream, "function", `${id} 가 native 가 아니다`);
    assert.equal(typeof provider.streamSimple, "function");
    assert.equal(provider[kRubatoStream], true, `${id} 가 Rubato decorator 로 감싸지지 않았다`);
    assert.notEqual(provider.baseUrl, "http://127.0.0.1:8788", `${id} 가 삭제된 bridge 를 가리킨다`);
  }
  // vendor 직통과 loopback 사이드카를 가른다. Kiro 만 로컬이고, 그것은 사이드카가 이
  // 기기에서 돌기 때문이다 — 다른 넓은 주소를 허용한다는 뜻이 아니다.
  for (const id of ["openai-codex", "xai", "cursor", "anthropic"]) {
    assert.match(pi.registered.get(id).baseUrl, /^https:\/\//, `${id} 가 vendor 로 직접 가지 않는다`);
  }
  assert.equal(pi.registered.get("kiro").baseUrl, "http://127.0.0.1:8990", "Kiro 는 loopback 사이드카다");
});

test("등록 순서: native 등록이 전부 끝난 뒤에 정리한다", async (t) => {
  // 마지막 등록이 이긴다(pinned model-runtime.js:635-640). 정리가 등록보다 먼저 오면
  // 방금 등록한 native 가 사라지므로, 순서 자체를 계약으로 고정한다.
  //
  // 예전에는 이 앞에 bridge catalog 등록 단계가 있어서 codex 가 2번 등록됐다(bridge →
  // native 덮기). 그 단계가 삭제됐으므로 이제 1번이다.
  const pi = recordingPi();
  await providerOverlay(pi, { env: isolatedDirectEnv(t) });
  const codexRegistrations = pi.calls.filter((call) => call.op === "register" && call.id === "openai-codex");
  assert.equal(codexRegistrations.length, 1, "native 등록 한 번이어야 한다");
  assert.equal(codexRegistrations[0].baseUrl, "https://chatgpt.com/backend-api");

  const lastNativeAt = pi.calls.findLastIndex(
    (call) => call.op === "register" && DIRECT_PROVIDER_IDS.includes(call.id),
  );
  const firstUnregisterAt = pi.calls.findIndex((call) => call.op === "unregister");
  if (firstUnregisterAt >= 0) {
    assert.ok(lastNativeAt < firstUnregisterAt, "정리가 native 등록보다 먼저 오면 방금 등록한 것을 지운다");
  }
});

test("정리 단계가 직결 provider 를 지우지 않는다", async (t) => {
  const pi = recordingPi();
  // 지원 목록 안의 id 는 foreign 이 아니다. 그래도 정리 단계가 그것을 지우면 방금
  // 등록한 native 가 사라진다.
  await providerOverlay(pi, { env: isolatedDirectEnv(t) });
  const unregistered = pi.calls.filter((call) => call.op === "unregister").map((call) => call.id);
  for (const id of DIRECT_PROVIDER_IDS) {
    assert.ok(!unregistered.includes(id), `${id} 를 지웠다`);
    assert.notEqual(pi.registered.get(id)?.baseUrl, "http://127.0.0.1:8788", `${id} native 가 남아 있어야 한다`);
  }
});

test("Codex: native metadata 를 보존하되 Rubato context 상한은 272K 다", async () => {
  const [codex] = await directProviders();
  assert.equal(codex.id, "openai-codex");
  const models = new Map(codex.getModels().map((model) => [model.id, model]));

  // pinned catalog 의 raw Sol 값이 더 커져도 statusline 과 compaction 은 Rubato 상한을 쓴다.
  assert.equal(models.get("gpt-5.6-sol").contextWindow, 272_000);
  assert.equal(models.get("gpt-5.6-terra").contextWindow, 272_000);
  assert.equal(models.get("gpt-5.6-luna").contextWindow, 272_000);
  assert.equal(models.get("gpt-5.6-sol-fast").contextWindow, 272_000);
  assert.ok([...models.values()].every((model) => model.contextWindow <= 272_000));

  // Fast 변형의 wire 계약.
  const solFast = models.get("gpt-5.6-sol-fast");
  assert.equal(solFast.upstreamModelId, "gpt-5.6-sol", "Fast 는 canonical ID 로 나가야 한다");
  assert.equal(solFast.serviceTier, "priority");
  assert.equal(models.get("gpt-5.6-sol").serviceTier, undefined, "base 에는 tier 가 없다");
  assert.equal(models.get("gpt-5.6-sol").upstreamModelId, undefined);

  const astra = models.get("gpt-6-astra");
  const astraFast = models.get("gpt-6-astra-fast");
  assert.ok(astra, "Astra 가 catalog 에 없다");
  assert.ok(astraFast, "Astra Fast 가 catalog 에 없다");
  assert.equal(astra.name, "GPT-6 Astra");
  assert.equal(astra.contextWindow, 272_000);
  assert.equal(astra.maxTokens, 128_000);
  assert.equal(astra.cost.input, 10);
  assert.equal(astra.cost.output, 50);
  assert.equal(astra.api, "openai-codex-responses");
  assert.equal(astra.thinkingLevelMap.low, "low");
  assert.equal(astra.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(astra.thinkingLevelMap.max, "max");
  assert.equal(astra.thinkingLevelMap.off, null);
  assert.equal(astra.thinkingLevelMap.minimal, null);
  assert.equal(astra.upstreamModelId, undefined, "base 에는 tier 가 없다");
  assert.equal(astra.serviceTier, undefined);
  assert.equal(astraFast.upstreamModelId, "gpt-6-astra", "Fast 는 canonical ID 로 나가야 한다");
  assert.equal(astraFast.serviceTier, "priority");
  assert.equal(astraFast.contextWindow, 272_000);

  // Daybreak.
  const base = models.get("gpt-daybreak-blue-latest");
  const fast = models.get("gpt-daybreak-blue-latest-fast");
  assert.ok(base, "Daybreak base 가 없다");
  assert.ok(fast, "Daybreak fast 가 없다");
  assert.equal(base.contextWindow, 272_000);
  assert.equal(base.maxTokens, 128_000);
  assert.deepEqual(base.input ?? base.modalities, ["text", "image"]);
  assert.equal(base.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(base.thinkingLevelMap.max, "max");
  assert.equal(base.thinkingLevelMap.off, undefined);
  assert.equal(base.thinkingLevelMap.minimal, undefined);
  assert.equal(base.upstreamModelId, undefined, "base 는 canonical 그 자체다");
  assert.equal(base.serviceTier, undefined, "base 에 priority 를 붙이면 항상 우선 처리로 나간다");
  assert.equal(fast.upstreamModelId, "gpt-daybreak-blue-latest", "Fast wire 는 base ID 다");
  assert.equal(fast.serviceTier, "priority");
  assert.equal(fast.contextWindow, 272_000);
  // Daybreak 은 같은 계열 native 모델에서 파생시킨다 — api 같은 필드가 빠지면 안 된다.
  assert.equal(base.api, models.get("gpt-5.6-terra").api);
});

test("Daybreak 파생은 틀이 없으면 조용히 넘어가지 않는다", () => {
  assert.throws(() => daybreakModels([{ id: "gpt-5.4" }]), /gpt-5\.6-terra/);
});

test("Fable 5.1 은 pin 의 Fable 5에서 id·이름만 덮는다", () => {
  const template = {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "anthropic-messages",
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    cost: { input: 10, output: 50 },
  };
  const [model] = fable51Models([template]);
  assert.equal(model.id, "claude-fable-5-1");
  assert.equal(model.name, "Fable 5.1");
  assert.equal(model.api, "anthropic-messages");
  assert.deepEqual(model.thinkingLevelMap, template.thinkingLevelMap);
  assert.deepEqual(model.cost, template.cost);
  assert.deepEqual(fable51Models([{ ...template, id: "claude-fable-5-1" }]), []);
});

test("Fable 5.1 파생은 틀이 없으면 조용히 넘어가지 않는다", () => {
  assert.throws(() => fable51Models([{ id: "claude-opus-5" }]), /claude-fable-5/);
});

test("xAI: pinned grok-4.6 의 xhigh 가 picker 와 wire 에 남는다", async () => {
  const [, xai] = await directProviders();
  assert.equal(xai.id, "xai");
  const grok = xai.getModels().find((model) => model.id === "grok-4.6");
  assert.ok(grok, "grok-4.6 이 없다");
  // picker 가 Shift+Tab 으로 xhigh 를 고를 수 있는 근거, 그리고 wire 로 나가는 값.
  assert.equal(grok.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(grok.contextWindow, 500_000);
  assert.equal(grok.serviceTier, undefined, "base 에 priority 를 붙이면 항상 우선 처리로 나간다");
});

test("피커는 현재 세대만 남기고 getModels 저장분은 그대로다", async () => {
  const providers = await directProviders();
  const [codex, xai, , anthropic] = providers;
  const opencode = providers.at(-1);
  assert.deepEqual(xai.filterModels(xai.getModels()).map((model) => model.id), ["grok-4.6"]);
  assert.ok(xai.getModels().some((model) => model.id === "grok-4.3"), "pin 저장분에서 4.3 을 지우면 안 된다");

  const anthropicPicker = anthropic.filterModels(anthropic.getModels()).map((model) => model.id);
  assert.deepEqual(anthropicPicker, ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5"]);
  assert.ok(anthropic.getModels().some((model) => model.id === "claude-sonnet-4-5"));
  assert.ok(anthropic.getModels().some((model) => model.id === "claude-fable-5"), "pin 저장분의 Fable 5를 지우면 안 된다");
  assert.ok(anthropic.getModels().some((model) => model.id === "claude-fable-5-1"), "Fable 5.1 파생이 없다");

  const codexPicker = new Set(codex.filterModels(codex.getModels()).map((model) => model.id));
  assert.ok(codexPicker.has("gpt-5.6-sol"));
  assert.ok(codexPicker.has("gpt-6-astra"));
  assert.ok(codexPicker.has("gpt-6-astra-fast"));
  assert.ok(codexPicker.has("gpt-daybreak-blue-latest"));
  assert.ok(!codexPicker.has("gpt-5.4"));

  assert.equal(opencode.id, "opencode");
  assert.deepEqual(
    opencode.filterModels(opencode.getModels()).map((model) => model.id),
    ["muse-spark-1.3-contributor-free"],
  );
  assert.ok(opencode.getModels().some((model) => model.id === "muse-spark-1.2"), "pin 저장분의 유료 Muse 를 지우면 안 된다");
});

test("직결 provider 는 pinned 의 다른 면을 잃지 않는다", async () => {
  const providers = await directProviders();
  for (const provider of providers) {
    // pinned factory 가 실제로 채우는 것만 본다. `headers`/`filterModels` 는 key 는
    // 있으나 값이 undefined 다 — 있다고 단정하면 pin 이 아니라 우리 상상을 검사한다.
    assert.equal(typeof provider.auth, "object", `${provider.id} 의 auth 가 사라졌다`);
    assert.equal(typeof provider.getModels, "function");
    // OpenCode 의 pin factory 는 provider.baseUrl 을 안 싣고, 모델이 Zen 주소를 갖는다.
    // Anthropic 계열은 `/zen`, Responses 계열(Muse)은 `/zen/v1` 이다.
    if (provider.id === "opencode") {
      const models = provider.getModels();
      assert.ok(models.length > 0, "opencode catalog 가 비었다");
      assert.ok(models.every((model) => typeof model.baseUrl === "string" && model.baseUrl.startsWith("https://opencode.ai/zen")));
      assert.equal(
        models.find((model) => model.id === "muse-spark-1.3-contributor-free")?.baseUrl,
        "https://opencode.ai/zen/v1",
      );
    } else {
      assert.ok(provider.baseUrl, `${provider.id} 의 baseUrl 이 사라졌다`);
    }
    assert.ok(provider.name, `${provider.id} 의 name 이 사라졌다`);
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    // Kiro 는 로컬 사이드카 key, OpenCode 는 OPENCODE_API_KEY 하나다. 둘 다 oauth 가
    // 없다. 달아 두면 없는 로그인을 제시하게 된다.
    if (provider.id === "kiro" || provider.id === "opencode") {
      assert.equal(provider.auth.oauth, undefined);
      assert.equal(typeof provider.auth.apiKey?.resolve, "function");
      continue;
    }
    assert.ok(provider.auth.oauth, `${provider.id} 의 oauth 정의가 사라졌다`);
  }
});

// ---------------------------------------------------------------- credentials

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "rubato-cred-"));
  return {
    dir,
    legacy: join(dir, "legacy-auth.json"),
    target: join(dir, "target-auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** pinned 계약을 만족하는 항목. oauth 는 access + refresh + 유한한 expires 가 필수다. */
const VALID_CODEX = Object.freeze({
  type: "oauth",
  access: "legacy-access",
  refresh: "legacy-refresh",
  expires: 4_102_444_800_000,
});
const VALID_XAI = Object.freeze({ type: "api_key", key: "legacy-xai-key" });

const LEGACY_BODY = {
  "openai-codex": VALID_CODEX,
  xai: VALID_XAI,
  // 직결 대상이 아니고, pinned 계약도 만족하지 않는다. 둘 다 이관 대상이 아니라는 뜻이다.
  anthropic: { type: "oauth", refresh: "legacy-anthropic" },
};

/** pinned 파서를 그대로 쓴다 — 검증 권위가 우리 손 코드가 아님을 테스트에서도 고정한다. */
async function pinnedParser() {
  const { pathToFileURL } = await import("node:url");
  const { senpiDir } = await import("../../src/engine-paths.mjs");
  const module = await import(pathToFileURL(join(senpiDir, "dist/core/auth-storage.js")).href);
  return module.ReadOnlyAuthStorage;
}

test("검증은 pinned Senpi 파서의 계약을 그대로 따른다", async () => {
  const Parser = await pinnedParser();
  const check = (entry) => credentialShapeWith(Parser, "openai-codex", entry);

  // oauth: access + refresh + 유한한 number expires 가 전부 있어야 한다.
  const valid = { type: "oauth", access: "a", refresh: "r", expires: 4_102_444_800_000 };
  assert.equal(check(valid).ok, true);
  assert.equal(check({ type: "oauth", refresh: "r", expires: 1 }).reason, "oauth_missing_access");
  assert.equal(check({ type: "oauth", access: "a", expires: 1 }).reason, "oauth_missing_refresh");
  assert.equal(check({ type: "oauth", access: "a", refresh: "r" }).reason, "oauth_missing_expires");
  assert.equal(check({ type: "oauth", access: "a", refresh: "r", expires: "soon" }).reason, "oauth_expires_not_a_number");
  assert.equal(check({ type: "oauth", access: "a", refresh: "r", expires: Number.POSITIVE_INFINITY }).reason, "oauth_expires_not_finite");
  assert.equal(check({ type: "oauth", access: "a", refresh: "r", expires: Number.NaN }).reason, "oauth_expires_not_finite");

  // api_key: pinned 는 key 가 없어도 통과시킨다(env 경로). 우리가 더 좁히지 않는다.
  assert.equal(check({ type: "api_key", key: "k" }).ok, true);
  assert.equal(check({ type: "api_key" }).ok, true, "pinned 는 key 없는 api_key 를 받는다");
  assert.equal(check({ type: "api_key", env: { XAI_API_KEY: "VAR" } }).ok, true);
  assert.equal(check({ type: "api_key", key: 7 }).reason, "api_key_key_not_a_string");

  assert.equal(check({ type: "bearer", key: "k" }).reason, "unsupported_type");
  assert.equal(check({ key: "k" }).reason, "missing_type");
  assert.equal(check(null).reason, "not_an_object");
  assert.equal(check([]).reason, "not_an_object");
});

test("느슨한 항목은 이관하지 않는다 — 엔진이 나중에 파일 전체를 거절하기 때문이다", async () => {
  // 이것이 이 gate 의 이유다. access 없는 oauth 를 옮겨 놓으면 pinned load() 가
  // 대상 auth.json 전체에서 throw 하고, 멀쩡한 다른 provider 까지 읽히지 않는다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify({
      "openai-codex": { type: "oauth", refresh: "r", expires: 1 },
      xai: VALID_XAI,
    }));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.deepEqual(result.imported, ["xai"]);
    assert.equal(result.rejected["openai-codex"], "oauth_missing_access");

    // 그리고 옮긴 결과는 pinned 파서로 읽힌다.
    const Parser = await pinnedParser();
    assert.doesNotThrow(() => new Parser(box.target).load(), "이관 결과가 엔진에서 읽히지 않는다");
  } finally {
    box.cleanup();
  }
});

test("관계없는 provider 가 깨져 있어도 멀쩡한 항목은 이관된다", async () => {
  // pinned load() 는 첫 실패에서 throw 한다. 통째로 태우면 anthropic 하나 때문에
  // Codex/xAI 이관이 막힌다. 항목별로 태우는 이유가 이것이다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify({
      anthropic: { type: "oauth", refresh: "only-refresh" },
      "openai-codex": VALID_CODEX,
      xai: VALID_XAI,
    }));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.deepEqual(result.imported.sort(), ["openai-codex", "xai"]);
    assert.ok(!("anthropic" in result.rejected), "직결 대상이 아닌 provider 는 판정 대상도 아니다");
  } finally {
    box.cleanup();
  }
});

test("legacy 가 객체가 아니면 대상을 건드리지 않는다", async () => {
  for (const body of ["[]", '"a string"', "42", "null"]) {
    const box = sandbox();
    try {
      writeFileSync(box.legacy, body);
      writeFileSync(box.target, JSON.stringify({ keep: true }));
      const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
      assert.deepEqual(result.imported, [], `${body} 에서 이관이 일어났다`);
      assert.deepEqual(JSON.parse(readFileSync(box.target, "utf-8")), { keep: true }, `${body} 가 대상을 바꿨다`);
    } finally {
      box.cleanup();
    }
  }
});

test("직결 대상 provider 만 후보가 된다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    const { candidates, status } = await readLegacyCandidates(box.legacy);
    assert.equal(status, "legacy_read");
    assert.deepEqual(Object.keys(candidates).sort(), ["openai-codex", "xai"]);
    assert.ok(!("anthropic" in candidates), "직결 대상이 아닌 provider 를 옮기면 권위가 둘이 된다");
  } finally {
    box.cleanup();
  }
});

test("대상이 비어 있으면 두 항목을 옮기고 mode 0600 을 지킨다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(result.status, "imported");
    assert.deepEqual(result.imported.sort(), ["openai-codex", "xai"]);
    const written = JSON.parse(readFileSync(box.target, "utf-8"));
    assert.deepEqual(written["openai-codex"], LEGACY_BODY["openai-codex"]);
    assert.deepEqual(written.xai, LEGACY_BODY.xai);
    assert.ok(!("anthropic" in written));
  } finally {
    box.cleanup();
  }
});

test("대상에 이미 있는 provider 는 절대 덮지 않는다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    // 대상 항목도 pinned 계약을 만족해야 한다 — 아니면 엔진이 파일 전체를 거절하고,
    // 우리는 그 위에 얹지 않는다(그 동작은 아래 별도 테스트가 본다).
    writeFileSync(box.target, JSON.stringify({
      "openai-codex": { type: "oauth", access: "target-access", refresh: "TARGET-WINS", expires: 4_102_444_800_000 },
    }));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.deepEqual(result.imported, ["xai"]);
    assert.deepEqual(result.skipped, ["openai-codex"]);
    const written = JSON.parse(readFileSync(box.target, "utf-8"));
    assert.equal(written["openai-codex"].refresh, "TARGET-WINS");
  } finally {
    box.cleanup();
  }
});

test("두 번 돌려도 같은 결과다 (idempotent)", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    const first = readFileSync(box.target, "utf-8");
    const second = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(second.status, "nothing_to_import");
    assert.deepEqual(second.imported, []);
    assert.equal(readFileSync(box.target, "utf-8"), first, "두 번째 실행이 파일을 바꿨다");
  } finally {
    box.cleanup();
  }
});

test("legacy 를 읽은 뒤 lock 안에서 들어온 값이 이긴다", async () => {
  // 이것이 check-then-write 경쟁의 실제 모양이다: legacy 를 읽는 사이에 다른
  // 프로세스가 로그인해 대상에 값을 넣는다. lock 안에서 다시 읽지 않으면 그 값을
  // 덮는다. 시간에 기대지 않고, lock 획득 시점에 값을 끼워 넣어 결정적으로 만든다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    class InjectingBackend {
      constructor(path) { this.path = path; }
      async withLockAsync(fn) {
        // lock 을 잡은 그 순간의 대상 상태 — 방금 로그인이 들어왔다.
        const current = JSON.stringify({
          "openai-codex": { type: "oauth", access: "fresh-access", refresh: "FRESH-LOGIN", expires: 4_102_444_800_000 },
        });
        const { next } = await fn(current);
        if (next !== undefined) writeFileSync(this.path, next);
        return undefined;
      }
    }
    const result = await importLegacyDirectCredentials({
      legacyPath: box.legacy,
      targetPath: box.target,
      backendFactory: InjectingBackend,
    });
    assert.deepEqual(result.imported, ["xai"], "끼어든 값을 덮지 않아야 한다");
    assert.deepEqual(result.skipped, ["openai-codex"]);
    const written = JSON.parse(readFileSync(box.target, "utf-8"));
    assert.equal(written["openai-codex"].refresh, "FRESH-LOGIN");
    assert.deepEqual(written.xai, LEGACY_BODY.xai);
  } finally {
    box.cleanup();
  }
});

test("두 프로세스가 동시에 옮겨도 대상이 깨지지 않고 값이 하나로 정착한다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    // 같은 대상에 동시에 병합한다. patch 된 atomic 경로 + lock 이 직렬화해야 한다.
    const results = await Promise.all([
      importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target }),
      importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target }),
    ]);
    const written = JSON.parse(readFileSync(box.target, "utf-8"));
    assert.deepEqual(written["openai-codex"], LEGACY_BODY["openai-codex"]);
    assert.deepEqual(written.xai, LEGACY_BODY.xai);
    // 같은 provider 를 두 번 넣었다고 보고하지 않는다.
    const importedTwice = results.flatMap((result) => result.imported);
    for (const id of ["openai-codex", "xai"]) {
      assert.equal(importedTwice.filter((seen) => seen === id).length, 1, `${id} 가 두 번 이관됐다`);
    }
  } finally {
    box.cleanup();
  }
});

test("깨진 legacy 파일은 대상을 건드리지 않는다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, '{"openai-codex": {"type": "oauth"');
    writeFileSync(box.target, JSON.stringify({ keep: true }));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(result.status, "legacy_invalid_json");
    assert.deepEqual(result.imported, []);
    assert.deepEqual(JSON.parse(readFileSync(box.target, "utf-8")), { keep: true });
  } finally {
    box.cleanup();
  }
});

test("모양이 틀린 항목은 사유만 보고하고 옮기지 않는다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify({
      "openai-codex": { type: "oauth" },
      xai: { type: "api_key", key: "SENTINEL-SECRET-VALUE" },
    }));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.deepEqual(result.imported, ["xai"]);
    assert.equal(result.rejected["openai-codex"], "oauth_missing_access");
    // 사유에 값이 실리지 않는다. 자격증명 값과 겹칠 수 없는 sentinel 로 본다.
    assert.ok(!JSON.stringify(result).includes("SENTINEL-SECRET-VALUE"), "보고에 자격증명 값이 실렸다");
  } finally {
    box.cleanup();
  }
});

test("legacy 가 없으면 조용히 아무것도 하지 않는다", async () => {
  const box = sandbox();
  try {
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(result.status, "legacy_absent");
    assert.deepEqual(result.imported, []);
  } finally {
    box.cleanup();
  }
});

test("legacy 와 target 이 같은 경로면 아무것도 하지 않는다", async () => {
  const box = sandbox();
  try {
    const result = await importLegacyDirectCredentials({ legacyPath: box.target, targetPath: box.target });
    assert.equal(result.status, "same_path");
  } finally {
    box.cleanup();
  }
});

// ------------------------------------------------- support identity vs routes

// 예전에는 지원 신원과 활성 등록이 갈라져 있었다: 이 목록은 제품 계약이고, 활성 권위는
// bridge catalog 에서 유도한 `ourProviderIds(catalog)` 였다. bridge 가 삭제되면서 물을
// 곳이 없어졌으므로 이 목록이 유일한 권위다.
test("지원 신원은 일곱 개이고 정적이다", async () => {
  const { SUPPORTED_PROVIDER_IDS, foreignProviderIds } = await import("../../src/provider-ids.mjs");
  assert.deepEqual([...SUPPORTED_PROVIDER_IDS], [
    "openai-codex",
    "xai",
    "anthropic",
    "cursor",
    "kiro",
    "google-antigravity",
    "opencode",
  ]);
  // 등록하는 id 는 어느 것도 foreign 이 아니다 — 정리 단계가 그것을 지우면 안 된다.
  const foreign = foreignProviderIds([...SUPPORTED_PROVIDER_IDS, "vercel-ai-gateway", "ollama"]);
  assert.deepEqual(foreign, ["vercel-ai-gateway", "ollama"]);
});

test("Cursor 는 직결 소유이고 정확히 한 번 등록된다", async (t) => {
  const pi = recordingPi();
  await providerOverlay(pi, { env: isolatedDirectEnv(t) });
  const cursor = pi.registered.get("cursor");
  assert.ok(cursor, "native Cursor 가 등록되지 않았다");
  assert.equal(cursor.baseUrl, "https://api2.cursor.sh", "Cursor 가 vendor 로 직접 가지 않는다");
  assert.equal(cursor[kRubatoStream], true);
  // 등록은 한 번이다.
  const registrations = pi.calls.filter((call) => call.op === "register" && call.id === "cursor");
  assert.equal(registrations.length, 1, `cursor 를 ${registrations.length} 번 등록했다`);
  // 그리고 모델은 하나도 없다 — canary 전에는 catalog 가 버어 있는 것이 정상이다.
  assert.deepEqual(cursor.getModels(), [], "canary 전에 Cursor 모델이 보이면 사용자가 그것을 골라 쓴다");
});

// 예전에는 플래그가 꺼진 세션이 legacy auth 를 **읽지도** 않는다는 것이 계약이었다.
// 직결이 유일한 경로가 되면서 그 자연스러운 방벽이 사라졌다. 대신 명시적인 방벽을 둔다:
// 테스트 안에서 경로를 주지 않으면 이관은 살아 있는 저장소를 건드리는 대신 세운다.
//
// 이 기기에는 다른 세션들이 같은 `~/.senpi`·`~/.rubato-pi` 를 지금 쓰고 있다. 소스를
// 공유하는 것만으로 그 파일이 바뀌면 안 된다.
test("테스트가 경로를 주지 않으면 살아 있는 자격증명 저장소를 건드리지 않고 세운다", async () => {
  await assert.rejects(
    () => importLegacyDirectCredentials({ env: {} }),
    /must not use the live credential store/,
  );
  // overlay 경로도 같은 방벽 뒤에 있다.
  await assert.rejects(
    () => providerOverlay(recordingPi(), { env: {} }),
    /must not use the live credential store/,
  );
});

test("대상이 배열이면 인덱스를 key 로 만들지 않고 손대지 않는다", async () => {
  // `typeof [] === "object"` 다. 그대로 spread 하면 `{"0": …}` 짜리 auth.json 이 된다 —
  // provider 이름이 사라진 파일이다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    writeFileSync(box.target, JSON.stringify([{ type: "oauth" }]));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(result.targetStatus, "target_not_an_object");
    assert.deepEqual(result.imported, []);
    assert.deepEqual(JSON.parse(readFileSync(box.target, "utf-8")), [{ type: "oauth" }], "대상이 바뀌었다");
  } finally {
    box.cleanup();
  }
});

test("엔진이 거절할 대상 위에는 얹지 않는다", async () => {
  // 대상에 계약을 어긴 항목이 하나라도 있으면 pinned load() 는 파일 전체에서 throw 한다.
  // 그 위에 새 항목을 얹으면 우리가 그 깨진 상태를 굳히는 셈이다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    const broken = { anthropic: { type: "oauth", refresh: "only-refresh" } };
    writeFileSync(box.target, JSON.stringify(broken));
    const result = await importLegacyDirectCredentials({ legacyPath: box.legacy, targetPath: box.target });
    assert.equal(result.targetStatus, "target_rejected_by_engine");
    assert.deepEqual(result.imported, []);
    assert.deepEqual(JSON.parse(readFileSync(box.target, "utf-8")), broken, "대상이 바뀌었다");
  } finally {
    box.cleanup();
  }
});

test("DIRECT=1 + 대상 자격증명 없음 + 깨진 legacy 는 부팅에서 세운다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, '{"openai-codex": {"type": "oauth"');
    const pi = recordingPi();
    await assert.rejects(
      () => providerOverlay(pi, {
        env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
      }),
      (error) => {
        assert.match(error.message, /legacy store could not be used/);
        assert.match(error.message, /legacy_invalid_json/);
        // 값이 실리지 않는다.
        assert.ok(!error.message.includes("oauth\""), "오류에 파일 내용이 실렸다");
        return true;
      },
      "조용히 시작하면 직결이 곧 401 로 죽는다",
    );
  } finally {
    box.cleanup();
  }
});

test("대상 자격증명이 이미 있으면 깨진 legacy 는 경고로 끝난다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, '{"openai-codex": {"type": "oauth"');
    writeFileSync(box.target, JSON.stringify({ "openai-codex": VALID_CODEX, xai: VALID_XAI }));
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const pi = recordingPi();
      await providerOverlay(pi, {
        env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
      });
      // 보장된 관측 경로다. pinned ExtensionAPI 에 log 가 없으므로 console.warn 을 쓴다.
      assert.equal(warnings.length, 1, `경고가 정확히 한 번이어야 한다: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /legacy credential import incomplete/);
      assert.match(warnings[0], /legacy_invalid_json/);
      assert.ok(!warnings[0].includes("legacy-access"), "경고에 자격증명 값이 실렸다");
      // 그리고 직결은 정상 등록된다.
      assert.notEqual(pi.registered.get("openai-codex")?.baseUrl, "http://127.0.0.1:8788");
    } finally {
      console.warn = realWarn;
    }
  } finally {
    box.cleanup();
  }
});

test("부분 대상: Codex 만 유효하고 legacy 가 깨졌으면 xAI 부재가 부팅을 막는다", async () => {
  // 한 provider 가 멀쩡하다고 다른 provider 의 부재를 덮으면, 세션은 부팅에 성공하고
  // 첫 xAI 요청에서 죽는다. 그때는 원인이 부팅에서 멀어져 있다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, '{"xai": {"type": "api_key"');
    writeFileSync(box.target, JSON.stringify({ "openai-codex": VALID_CODEX }));
    await assert.rejects(
      () => providerOverlay(recordingPi(), {
        env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
      }),
      (error) => {
        assert.match(error.message, /xai\(legacy_invalid_json\)/, `xAI 를 이름으로 들어야 한다: ${error.message}`);
        assert.ok(!error.message.includes("openai-codex("), "이미 유효한 Codex 를 막으면 안 된다");
        return true;
      },
    );
  } finally {
    box.cleanup();
  }
});

test("부분 대상: xAI 만 유효하고 legacy 가 깨졌으면 Codex 부재가 부팅을 막는다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, "not json at all");
    writeFileSync(box.target, JSON.stringify({ xai: VALID_XAI }));
    await assert.rejects(
      () => providerOverlay(recordingPi(), {
        env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
      }),
      (error) => {
        assert.match(error.message, /openai-codex\(legacy_invalid_json\)/);
        assert.ok(!error.message.includes("xai("), "이미 유효한 xAI 를 막으면 안 된다");
        return true;
      },
    );
  } finally {
    box.cleanup();
  }
});

test("부분 대상: 나머지를 legacy 가 채워 주면 막지 않는다", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.legacy, JSON.stringify({ xai: VALID_XAI }));
    writeFileSync(box.target, JSON.stringify({ "openai-codex": VALID_CODEX }));
    const pi = recordingPi();
    await providerOverlay(pi, {
      env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
    });
    const written = JSON.parse(readFileSync(box.target, "utf-8"));
    assert.deepEqual(written["openai-codex"], VALID_CODEX, "이미 있던 것을 덮지 않는다");
    assert.deepEqual(written.xai, VALID_XAI, "빠진 것만 채운다");
    for (const id of DIRECT_PROVIDER_IDS) {
      assert.notEqual(pi.registered.get(id)?.baseUrl, "http://127.0.0.1:8788");
    }
  } finally {
    box.cleanup();
  }
});

test("부분 대상: 대상이 배열이면 두 provider 모두 부재로 본다", async () => {
  // 엔진이 읽지 못하는 파일에 들어 있는 것은 들어 있는 것이 아니다.
  const box = sandbox();
  try {
    writeFileSync(box.legacy, "not json at all");
    writeFileSync(box.target, JSON.stringify([{ type: "api_key", key: "k" }]));
    await assert.rejects(
      () => providerOverlay(recordingPi(), {
        env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
      }),
      (error) => {
        assert.match(error.message, /openai-codex\(/);
        assert.match(error.message, /xai\(/);
        return true;
      },
    );
  } finally {
    box.cleanup();
  }
});

test("로그인만 안 한 상태(absent)는 부팅을 막지 않는다", async () => {
  // 이관할 것이 없는 것은 정상이다. 로그인 흐름이 해결한다.
  const box = sandbox();
  try {
    const pi = recordingPi();
    await providerOverlay(pi, {
      env: { RUBATO_PROVIDER_DIRECT: "1", RUBATO_LEGACY_AUTH_PATH: box.legacy, RUBATO_TARGET_AUTH_PATH: box.target },
    });
    for (const id of DIRECT_PROVIDER_IDS) {
      assert.notEqual(pi.registered.get(id)?.baseUrl, "http://127.0.0.1:8788");
    }
  } finally {
    box.cleanup();
  }
});

// ------------------------------------------------------- agent dir resolution

test("custom agentDir: 이관 대상이 세션이 실제로 읽는 파일이 된다", async () => {
  // spawn 된 Senpi 는 `*_CODING_AGENT_DIR` 로 agent 디렉터리를 옮기고
  // (`brand.mjs` launchEnv 가 실제로 넘긴다) native AuthStorage 는 그 해결된
  // 디렉터리에 쓴다(`config.js:446-459,478`). 홈에 쓰면 세션이 읽지 않는 파일을
  // 채우고, 로그인은 여전히 비어 있는 것으로 보인다.
  const box = sandbox();
  const agentDir = join(box.dir, "custom-agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    const result = await importLegacyDirectCredentials({
      env: { SENPI_CODING_AGENT_DIR: agentDir, RUBATO_LEGACY_AUTH_PATH: box.legacy },
    });
    assert.deepEqual(result.imported.sort(), ["openai-codex", "xai"]);
    // 홈이 아니라 이 디렉터리에 쓰였다.
    const written = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
    assert.deepEqual(written["openai-codex"], VALID_CODEX);
    assert.deepEqual(written.xai, VALID_XAI);
  } finally {
    box.cleanup();
  }
});

test("agentDir 우선순위는 pinned brand envValue 와 같다", async () => {
  const { defaultTargetAuthPath, resolveAgentDirFromEnv } = await import("../../src/credential-import.mjs");
  const home = "/tmp/fake-home-not-used";

  // 1) Rubato prefix 가 Senpi prefix 보다 앞선다 (pinned brandEnvNames 순서와 같다).
  assert.equal(
    resolveAgentDirFromEnv({ RUBATO_PI_CODING_AGENT_DIR: "/a", SENPI_CODING_AGENT_DIR: "/b" }, home),
    "/a",
  );
  assert.equal(resolveAgentDirFromEnv({ SENPI_CODING_AGENT_DIR: "/b" }, home), "/b");
  // 2) 빈 문자열은 디렉터리가 아니므로 다음 후보로 넘어간다.
  assert.equal(resolveAgentDirFromEnv({ PI_CODING_AGENT_DIR: "/c" }, home), "/c");
  assert.equal(
    resolveAgentDirFromEnv({ SENPI_CODING_AGENT_DIR: "", PI_CODING_AGENT_DIR: "/c" }, home),
    undefined,
    "정의된 빈 SENPI 값은 뒤 PI fallback 을 가린다",
  );
  // 3) 아무것도 없으면 undefined — 기본 경로가 쓰인다.
  assert.equal(resolveAgentDirFromEnv({}, home), undefined);

  // 대상 경로 조립.
  assert.equal(defaultTargetAuthPath(home, { SENPI_CODING_AGENT_DIR: "/agent" }), join("/agent", "auth.json"));
  assert.equal(defaultTargetAuthPath(home, {}), join(home, ".rubato-pi", "agent", "auth.json"));
});

test("agentDir 의 `~` 는 실제 homedir 로 펼친다 — env.HOME 이 홈을 뜻하지 않는다", async () => {
  const { resolveAgentDirFromEnv } = await import("../../src/credential-import.mjs");
  const realHome = homedir();
  // pinned normalizePath 와 같게 실제 homedir 로 펼친다. env.HOME 을 홈으로 취급하면
  // 테스트만 통과하고 실제 세션은 다른 파일을 본다.
  assert.equal(
    resolveAgentDirFromEnv({ SENPI_CODING_AGENT_DIR: "~/.custom/agent", HOME: "/tmp/decoy" }),
    join(realHome, ".custom/agent"),
  );
  assert.equal(resolveAgentDirFromEnv({ SENPI_CODING_AGENT_DIR: "~" }), realHome);
});

test("custom agentDir 에서도 이미 있는 값을 덮지 않는다", async () => {
  const box = sandbox();
  const agentDir = join(box.dir, "custom-agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    writeFileSync(box.legacy, JSON.stringify(LEGACY_BODY));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "AGENT-DIR-WINS", expires: 4_102_444_800_000 },
    }));
    const result = await importLegacyDirectCredentials({
      env: { SENPI_CODING_AGENT_DIR: agentDir, RUBATO_LEGACY_AUTH_PATH: box.legacy },
    });
    assert.deepEqual(result.imported, ["xai"]);
    assert.deepEqual(result.skipped, ["openai-codex"]);
    const written = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
    assert.equal(written["openai-codex"].refresh, "AGENT-DIR-WINS");
  } finally {
    box.cleanup();
  }
});

test("presence 판정도 custom agentDir 를 본다", async () => {
  // 부재 판정이 홈만 보면, custom agentDir 에 로그인이 있어도 부팅을 막는다.
  const box = sandbox();
  const agentDir = join(box.dir, "custom-agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": VALID_CODEX, xai: VALID_XAI }));
    writeFileSync(box.legacy, "not json at all");
    const { unavailableDirectProviders } = await import("../../src/credential-import.mjs");
    const unavailable = await unavailableDirectProviders(
      { status: "legacy_invalid_json", imported: [], rejected: {} },
      { SENPI_CODING_AGENT_DIR: agentDir },
    );
    assert.deepEqual(unavailable, [], "custom agentDir 의 로그인을 못 보면 멀쩡한 세션을 막는다");
  } finally {
    box.cleanup();
  }
});

// 격리 memory/reflection 자식도 같은 provider overlay 를 물려받는다(`brand.mjs` 가 그 경로를
// 자식 env 에 싣는다). 그래서 이관을 걸지 않으면 자식마다 Keychain 을 읽고 loadCodeAssist 로
// Google 에 요청한다 — 시작 부작용이 자식 수만큼 곱해진다. 권위를 가진 부모만 이관한다.
test("Antigravity 이관은 부모 세션만 한다", async (t) => {
  const calls = [];
  const importer = async ({ enabled }) => {
    calls.push(enabled);
    return { status: enabled === true ? "already_present" : "disabled" };
  };

  const childArgv = ["node", "senpi", "-p", "--no-extensions", "-e", "/x/provider-overlay.mjs"];
  const parentArgv = ["node", "senpi", "-e", "/x/lead-overlay.mjs", "-e", "/x/provider-overlay.mjs"];
  const original = process.argv;

  try {
    process.argv = childArgv;
    await providerOverlay(recordingPi(), {
      env: isolatedDirectEnv(t),
      antigravityCredentialImporter: importer,
    });
    assert.equal(calls.at(-1), false, "자식이 이관을 시도했다");

    process.argv = parentArgv;
    await providerOverlay(recordingPi(), {
      env: isolatedDirectEnv(t),
      antigravityCredentialImporter: importer,
    });
    assert.equal(calls.at(-1), true, "부모가 이관을 건너뛰었다");
  } finally {
    process.argv = original;
  }
});

test("자식 overlay 도 google-antigravity/gemini-3.7-flash 를 입학시킨다", async (t) => {
  const original = process.argv;
  const pi = recordingPi();
  try {
    process.argv = ["node", "senpi", "-p", "--no-extensions", "-e", "/x/provider-overlay.mjs"];
    await providerOverlay(pi, { env: isolatedDirectEnv(t) });
  } finally {
    process.argv = original;
  }
  const antigravity = pi.registered.get("google-antigravity");
  assert.ok(antigravity, "자식이 google-antigravity 를 등록하지 않았다");
  const flash = antigravity.getModels?.().find((entry) => entry.id === "gemini-3.7-flash");
  assert.ok(flash, "자식 catalog 에 gemini-3.7-flash 가 없다");
  assert.equal(flash.provider, "google-antigravity");
  assert.deepEqual(flash.input, ["text", "image"]);
});
