import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import {
  ANTHROPIC_FAST_BETA,
  addServiceTierToPayload,
  applyAnthropicFastMode,
  createServiceTierFeature,
} from "./extension.mjs";
import { files, patches, serviceTierRuntimeFeature } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const runtime = resolvePiRuntime({ root: runtimeRoot });
const pristinePackage = runtime.codingAgentDir;
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-service-tier-"));
const patchedPackage = join(scratchRoot, "pi-coding-agent");

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function withoutCompileOptions(env) {
  const {
    NODE_OPTIONS: _nodeOptions,
    NODE_COMPILE_CACHE: _nodeCompileCache,
    ...clean
  } = env;
  return clean;
}

function preparePatchedPackage() {
  mkdirSync(patchedPackage, { recursive: true });
  cpSync(join(pristinePackage, "dist"), join(patchedPackage, "dist"), { recursive: true });
  cpSync(join(pristinePackage, "package.json"), join(patchedPackage, "package.json"));
  symlinkSync(join(pristinePackage, "node_modules"), join(patchedPackage, "node_modules"), "dir");

  for (const spec of patches) {
    const target = join(patchedPackage, spec.path);
    const source = readFileSync(target, "utf8");
    assert.equal(sha256(source), spec.preimageSha256, `${spec.path} pristine hash`);
    writeFileSync(target, spec.apply(source));
  }
}

preparePatchedPackage();

const sdk = await import(pathToFileURL(join(patchedPackage, "dist/index.js")).href);
const eventStreamModule = await import(
  pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js")).href
);
const { createAssistantMessageEventStream } = eventStreamModule;

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const MODELS = Object.freeze({
  codex: Object.freeze({
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    name: "Codex fixture",
    api: "openai-codex-responses",
    baseUrl: "http://127.0.0.1:9/codex",
  }),
  codexB: Object.freeze({
    provider: "openai-codex",
    id: "gpt-5.6-terra",
    name: "Second Codex fixture",
    api: "openai-codex-responses",
    baseUrl: "http://127.0.0.1:9/codex",
  }),
  xai: Object.freeze({
    provider: "xai",
    id: "grok-4.6",
    name: "xAI fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/xai",
  }),
  anthropic: Object.freeze({
    provider: "anthropic",
    id: "claude-opus-5",
    name: "Anthropic fixture",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  }),
  anthropicUnsupported: Object.freeze({
    provider: "anthropic",
    id: "claude-opus-4-7",
    name: "Unsupported Anthropic fixture",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  }),
  kiro: Object.freeze({
    provider: "kiro",
    id: "claude-opus-5",
    name: "Kiro fixture",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8990",
  }),
});

function completeModel(model) {
  return {
    ...model,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
}

function providerConfigs() {
  const byProvider = new Map();
  for (const model of Object.values(MODELS)) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return byProvider;
}

function completedMessage(model, content = "fixture response") {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { ...ZERO_COST, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function fakeProviderExtension(captures) {
  const streamSimple = (model, _context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const inputPayload = {
          model: model.id,
          betas: ["fixture-existing-beta"],
          fixture: true,
        };
        const payload = await options.onPayload?.(inputPayload, model) ?? inputPayload;
        captures.push({ provider: model.provider, modelId: model.id, payload });
        const message = completedMessage(model);
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
      } catch (error) {
        const message = completedMessage(model, error instanceof Error ? error.message : String(error));
        message.stopReason = "error";
        message.errorMessage = message.content[0].text;
        stream.push({ type: "error", reason: "error", error: message });
      }
    })();
    return stream;
  };

  return (pi) => {
    for (const [provider, models] of providerConfigs()) {
      const { api, baseUrl } = models[0];
      pi.registerProvider(provider, {
        name: `${provider} fixture`,
        api,
        baseUrl,
        apiKey: "fixture-not-a-live-key",
        streamSimple,
        models: models.map((model) => {
          const { provider: _provider, baseUrl: _baseUrl, ...config } = completeModel(model);
          return config;
        }),
      });
    }
  };
}

async function startSession({ agentDir, cwd, model: initialModel, captures, feature }) {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "fixture-providers", factory: fakeProviderExtension(captures) },
      { name: "rubato-service-tier", factory: feature.extension },
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: completeModel(initialModel),
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    noTools: "all",
  });
  const extensionErrors = [];
  await result.session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(result.extensionsResult.errors, []);
  assert.deepEqual(extensionErrors, []);
  return { ...result, extensionErrors, settingsManager };
}

function registryModel(session, key) {
  const expected = MODELS[key];
  const model = session.extensionRunner.getModelRegistry().find(expected.provider, expected.id);
  assert.ok(model, `${expected.provider}/${expected.id} fixture model missing`);
  return model;
}

async function request(session, captures, label) {
  const before = captures.length;
  await session.prompt(label);
  assert.equal(captures.length, before + 1, `${label} did not make exactly one fake request`);
  return captures.at(-1);
}

test("patch manifest is version-locked, drift-strict, and keeps SettingsManager valid", () => {
  assert.equal(serviceTierRuntimeFeature.id, "service-tier");
  assert.equal(serviceTierRuntimeFeature.patches, patches);
  assert.equal(serviceTierRuntimeFeature.files, files);
  assert.deepEqual(
    files.map(({ target, version, path }) => ({ target, version, path })),
    [
      {
        target: "runtime",
        version: "0.85.1",
        path: "rubato-features/service-tier/extension.mjs",
      },
      {
        target: "runtime",
        version: "0.85.1",
        path: "rubato-features/service-tier/THIRD_PARTY_NOTICES.md",
      },
    ],
  );
  assert.equal(patches.length, 2);
  assert.equal(new Set(patches.map((patch) => patch.id)).size, patches.length);
  for (const spec of patches) {
    assert.equal(spec.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(spec.version, "0.85.1");
    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256, `${spec.path} hash`);
    const output = spec.apply(pristine);
    assert.notEqual(output, pristine);
    assert.throws(() => spec.apply(output), /expected anchor is missing/);
  }

  const syntax = spawnSync(
    process.execPath,
    ["--check", join(patchedPackage, "dist/core/settings-manager.js")],
    { encoding: "utf8", env: withoutCompileOptions(process.env) },
  );
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("patched stock SettingsManager persists isolated per-model service tiers", async () => {
  const cwd = join(scratchRoot, "settings-project");
  const agentDir = join(scratchRoot, "settings-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const writer = sdk.SettingsManager.create(cwd, agentDir);
  writer.setModelServiceTier("openai-codex", "gpt-5.6-sol", "priority");
  writer.setModelServiceTier("xai", "grok-4.6", "auto");
  await writer.flush();

  const persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(persisted.modelServiceTiers, {
    "openai-codex/gpt-5.6-sol": "priority",
    "xai/grok-4.6": "auto",
  });

  const reader = sdk.SettingsManager.create(cwd, agentDir);
  assert.equal(reader.getModelServiceTier("openai-codex", "gpt-5.6-sol"), "priority");
  assert.equal(reader.getModelServiceTier("xai", "grok-4.6"), "auto");
  assert.equal(reader.getModelServiceTier("anthropic", "claude-opus-5"), undefined);
});

test("stock AgentSession runs /fast through real settings and all three request wires", async (t) => {
  const cwd = join(scratchRoot, "sdk-project");
  const agentDir = join(scratchRoot, "sdk-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const captures = [];
  const feature = createServiceTierFeature({ SettingsManager: sdk.SettingsManager, agentDir });
  const stateChanges = [];
  feature.onChange((state) => stateChanges.push(state));
  const { session, extensionErrors } = await startSession({
    agentDir,
    cwd,
    model: MODELS.codex,
    captures,
    feature,
  });
  t.after(() => session.dispose());

  assert.deepEqual(feature.getState(), {
    revision: 1,
    active: false,
    supported: true,
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    wireMode: "service-tier",
    rememberedTier: undefined,
  });

  await session.prompt("/fast on");
  assert.equal(feature.getState().active, true);
  const codex = await request(session, captures, "codex request");
  assert.equal(codex.payload.service_tier, "priority");
  assert.equal(codex.payload.speed, undefined);

  await session.setModel(registryModel(session, "codexB"));
  assert.equal(
    feature.getState().active,
    true,
    "live fast intent must survive a Codex-to-Codex model switch",
  );
  assert.equal(feature.getState().rememberedTier, undefined);
  const secondCodex = await request(session, captures, "second codex request");
  assert.equal(secondCodex.payload.service_tier, "priority");
  assert.equal(secondCodex.payload.speed, undefined);

  await session.setModel(registryModel(session, "xai"));
  assert.equal(
    feature.getState().active,
    true,
    "current Rubato keeps live intent across a switch to another fast-capable lane",
  );
  const xaiFromSessionIntent = await request(session, captures, "xai session-intent request");
  assert.equal(xaiFromSessionIntent.payload.service_tier, "priority");
  assert.equal(xaiFromSessionIntent.payload.speed, undefined);
  await session.prompt("/fast on");
  const xai = await request(session, captures, "xai request");
  assert.equal(xai.payload.service_tier, "priority");
  assert.equal(xai.payload.speed, undefined);

  await session.setModel(registryModel(session, "kiro"));
  assert.deepEqual(
    { active: feature.getState().active, supported: feature.getState().supported },
    { active: false, supported: false },
  );
  await session.prompt("/fast on");
  const kiro = await request(session, captures, "kiro request");
  assert.equal(kiro.payload.service_tier, undefined);
  assert.equal(kiro.payload.speed, undefined);
  assert.deepEqual(kiro.payload.betas, ["fixture-existing-beta"]);

  await session.setModel(registryModel(session, "anthropic"));
  await session.prompt("/fast on");
  const anthropic = await request(session, captures, "anthropic request");
  assert.equal(anthropic.payload.service_tier, undefined);
  assert.equal(anthropic.payload.speed, "fast");
  assert.deepEqual(anthropic.payload.betas, ["fixture-existing-beta", ANTHROPIC_FAST_BETA]);

  await session.setModel(registryModel(session, "anthropicUnsupported"));
  assert.equal(feature.getState().supported, false);
  const unsupported = await request(session, captures, "unsupported opus request");
  assert.equal(unsupported.payload.service_tier, undefined);
  assert.equal(unsupported.payload.speed, undefined);
  assert.deepEqual(unsupported.payload.betas, ["fixture-existing-beta"]);

  await session.setModel(registryModel(session, "anthropic"));
  assert.equal(feature.getState().active, true, "Opus memory must restore after a model switch");
  await session.reload();
  assert.equal(feature.getState().active, true, "Opus memory must restore after extension reload");
  const afterReload = await request(session, captures, "after reload request");
  assert.equal(afterReload.payload.speed, "fast");

  const persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(persisted.modelServiceTiers, {
    "openai-codex/gpt-5.6-sol": "priority",
    "xai/grok-4.6": "priority",
    "anthropic/claude-opus-5": "priority",
  });
  assert.equal("openai-codex/gpt-5.6-terra" in persisted.modelServiceTiers, false);
  assert.equal("kiro/claude-opus-5" in persisted.modelServiceTiers, false);
  assert.equal("anthropic/claude-opus-4-7" in persisted.modelServiceTiers, false);
  assert.ok(stateChanges.some((state) => state.provider === "kiro" && state.supported === false));
  assert.deepEqual(extensionErrors, []);
});

for (const key of ["codex", "xai", "anthropic"]) {
  test(`fresh stock AgentSession restores ${key} on/off memory after restart`, async (t) => {
    const cwd = join(scratchRoot, `restart-${key}-project`);
    const agentDir = join(scratchRoot, `restart-${key}-agent`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    const firstCaptures = [];
    const firstFeature = createServiceTierFeature({ SettingsManager: sdk.SettingsManager, agentDir });
    const first = await startSession({
      agentDir,
      cwd,
      model: MODELS[key],
      captures: firstCaptures,
      feature: firstFeature,
    });
    t.after(() => first.session.dispose());
    assert.equal(firstFeature.getState().active, false);
    await first.session.prompt("/fast on");
    assert.equal(firstFeature.getState().active, true);
    first.session.dispose();

    const enabledCaptures = [];
    const enabledFeature = createServiceTierFeature({ SettingsManager: sdk.SettingsManager, agentDir });
    const enabled = await startSession({
      agentDir,
      cwd,
      model: MODELS[key],
      captures: enabledCaptures,
      feature: enabledFeature,
    });
    t.after(() => enabled.session.dispose());

    assert.equal(enabledFeature.getState().active, true);
    const capture = await request(enabled.session, enabledCaptures, `${key} restarted enabled request`);
    if (key === "anthropic") {
      assert.equal(capture.payload.speed, "fast");
      assert.ok(capture.payload.betas.includes(ANTHROPIC_FAST_BETA));
      assert.equal(capture.payload.service_tier, undefined);
    } else {
      assert.equal(capture.payload.service_tier, "priority");
      assert.equal(capture.payload.speed, undefined);
    }
    await enabled.session.prompt("/fast off");
    assert.equal(enabledFeature.getState().active, false);
    const disabled = await request(
      enabled.session,
      enabledCaptures,
      `${key} disabled request`,
    );
    assert.equal(disabled.payload.service_tier, undefined);
    assert.equal(disabled.payload.speed, undefined);
    assert.deepEqual(disabled.payload.betas, ["fixture-existing-beta"]);
    enabled.session.dispose();

    const disabledCaptures = [];
    const disabledFeature = createServiceTierFeature({ SettingsManager: sdk.SettingsManager, agentDir });
    const restarted = await startSession({
      agentDir,
      cwd,
      model: MODELS[key],
      captures: disabledCaptures,
      feature: disabledFeature,
    });
    t.after(() => restarted.session.dispose());
    assert.equal(disabledFeature.getState().active, false);
    const afterDisabledRestart = await request(
      restarted.session,
      disabledCaptures,
      `${key} restarted disabled request`,
    );
    assert.equal(afterDisabledRestart.payload.service_tier, undefined);
    assert.equal(afterDisabledRestart.payload.speed, undefined);
    assert.deepEqual(afterDisabledRestart.payload.betas, ["fixture-existing-beta"]);

    const persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(persisted.modelServiceTiers[`${MODELS[key].provider}/${MODELS[key].id}`], "auto");
    assert.deepEqual(first.extensionErrors, []);
    assert.deepEqual(enabled.extensionErrors, []);
    assert.deepEqual(restarted.extensionErrors, []);
  });
}

test("caller-owned wire fields are not overwritten or duplicated", () => {
  const featurePayload = { service_tier: "flex", keep: true };
  assert.equal(addServiceTierToPayload(featurePayload, "priority"), featurePayload);

  const speedPayload = { speed: "standard", betas: [ANTHROPIC_FAST_BETA] };
  assert.equal(applyAnthropicFastMode(speedPayload, true), speedPayload);
  assert.deepEqual(applyAnthropicFastMode({ betas: [ANTHROPIC_FAST_BETA] }, true).betas, [
    ANTHROPIC_FAST_BETA,
  ]);
});
