import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { runtimeFactoriesFeature } from "../runtime-factories/feature.mjs";
import { applyFeatureToggles } from "../rubato-components/feature-toggles.mjs";
import { files, patches, promptPresetFeature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-prompt-preset-"));
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "stage"),
  features: [runtimeFactoriesFeature, promptPresetFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);
const promptPreset = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/prompt-preset/index.mjs",
)).href);

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const clean = { ...env, ...extra };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_COMPILE_CACHE;
  return clean;
}

function grokModel() {
  return {
    provider: "xai",
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: "openai-completions",
    provider: "xai",
    model: "grok-4.6",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function complete(message) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

async function createFixture({
  cwd,
  agentDir,
  sessionManager,
  includePreset = true,
  resourceLoaderOptions = {},
  model = grokModel(),
} = {}) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      xai: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [{
          id: "grok-4.6",
          name: "Grok 4.6",
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 4096,
        }],
      },
    },
  }));
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(5_000),
    createExtensionFactories: ({ settingsManager: canonicalSettings }) => (
      includePreset
        ? promptPreset.createPromptPresetExtensionFactories({ settingsManager: canonicalSettings })
        : []
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      ...resourceLoaderOptions,
    },
  });
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    tools: ["read"],
  });
  const errors = [];
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, setWidget() {}, setHeader() {} },
    onError(error) { errors.push(error); },
  });
  assert.deepEqual(result.extensionsResult.errors, []);
  return { ...result, services, settingsManager, errors };
}

function project(name) {
  const cwd = join(scratch, name);
  const agentDir = join(scratch, `${name}-agent`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

test("feature is additive-only, stock-version locked, and stages a complete owned closure", () => {
  assert.equal(promptPresetFeature.id, "prompt-preset");
  assert.deepEqual(patches, []);
  assert.ok(files.every((entry) => entry.target === "runtime" && entry.version === "0.85.1"));
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.equal(staged.receipt.addedFiles.filter((entry) => entry.feature === "prompt-preset").length, files.length);
  for (const entry of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
  assert.match(readFileSync(join(staged.root, "rubato-features/prompt-preset/THIRD_PARTY_NOTICES.md"), "utf8"), /MIT/);
});

test("model id resolution matches the Senpi auto map, including Grok 4.6 and GPT-6 Astra shapes", () => {
  const auto = { promptPreset: "auto" };
  assert.equal(promptPreset.resolvePresetName({ id: "grok-4.6", provider: "xai" }, auto), "grok-4.6");
  assert.equal(promptPreset.resolvePresetName({ id: "cursor/grok-4.6", provider: "cursor" }, auto), "grok-4.6");
  assert.equal(promptPreset.resolvePresetName({ id: "gpt-6-astra", provider: "openai" }, auto), "gpt-6-astra");
  assert.equal(promptPreset.resolvePresetName({ id: "gpt-5.2", provider: "openai" }, auto), "gpt-5.2");
  assert.equal(promptPreset.resolvePresetName({ id: "claude-opus-5", provider: "anthropic" }, auto), "claude-opus-5");
  assert.equal(promptPreset.resolvePresetName({ id: "unknown-model", provider: "other" }, auto), undefined);
  assert.equal(promptPreset.resolvePresetName({ id: "anything", provider: "xai" }, { promptPreset: "grok-4.6" }), "grok-4.6");
});

test("stock SDK injects the Grok 4.6 preset through before_agent_start into the provider system prompt", async (t) => {
  const dirs = project("preset-on");
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
  });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push(context.systemPrompt);
    return complete(assistant("ok"));
  };
  await fixture.session.prompt("hello from grok");
  assert.deepEqual(fixture.errors, []);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0], /<!--rubato-prompt-preset:grok-4.6-->/);
  assert.match(contexts[0], /Intent Gate/);
  assert.match(contexts[0], /Grok 4.6/);
});

test("explicit customPrompt / completed role prompt outranks the preset body", async (t) => {
  const dirs = project("role-wins");
  const role = "COMPLETED_ROLE_PROMPT_TAKES_PRECEDENCE\nYou are the lead.";
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
    resourceLoaderOptions: { systemPrompt: role },
  });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push(context.systemPrompt);
    return complete(assistant("ok"));
  };
  await fixture.session.prompt("hello");
  assert.equal(contexts.length, 1);
  assert.match(contexts[0], /COMPLETED_ROLE_PROMPT_TAKES_PRECEDENCE/);
  assert.doesNotMatch(contexts[0], /<!--rubato-prompt-preset:grok-4.6-->/);
  assert.doesNotMatch(contexts[0], /Intent Gate/);
});

test("disabled factory disappears and the Grok preset is not injected", async (t) => {
  const factories = promptPreset.createPromptPresetExtensionFactories({
    settingsManager: { getGlobalSettings() { return {}; }, getProjectSettings() { return {}; } },
  });
  assert.deepEqual(factories.map((entry) => entry.name), ["rubato-prompt-preset"]);
  const disabled = applyFeatureToggles(factories, new Set(["rubato-prompt-preset"]));
  assert.deepEqual(disabled.extensionFactories, []);
  assert.deepEqual(disabled.disabled, ["rubato-prompt-preset"]);

  const dirs = project("preset-off");
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
    includePreset: false,
  });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push(context.systemPrompt);
    return complete(assistant("ok"));
  };
  await fixture.session.prompt("hello");
  assert.equal(contexts.length, 1);
  assert.doesNotMatch(contexts[0], /<!--rubato-prompt-preset:/);
  assert.doesNotMatch(contexts[0], /Intent Gate/);
});
