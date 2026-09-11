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
import { configReloadFeature, files, patches } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-config-reload-"));
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "stage"),
  features: [runtimeFactoriesFeature, configReloadFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);
const configReload = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/config-reload/index.mjs",
)).href);

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const clean = { ...env, ...extra };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_COMPILE_CACHE;
  return clean;
}

function model() {
  return {
    provider: "reload-test",
    id: "fake-model",
    name: "Offline config-reload fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function complete() {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "reload-test",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

async function waitTick() {
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}

async function createFixture({ cwd, agentDir, emitHolder, requestReload, includeFactory = true }) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "reload-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [{ id: "fake-model", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ transport: "auto" }));
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const subscribe = (onEvent) => {
    emitHolder.emit = onEvent;
    return () => { emitHolder.emit = undefined; };
  };
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(5_000),
    createExtensionFactories: ({ settingsManager: canonicalSettings }) => (
      includeFactory
        ? configReload.createConfigReloadExtensionFactories({
          settingsManager: canonicalSettings,
          agentDir,
          cwd,
          requestReload,
          subscribe,
          debounceMs: 0,
        })
        : []
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: model(),
    tools: ["read"],
  });
  const errors = [];
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, setWidget() {} },
    onError(error) { errors.push(error); },
  });
  assert.deepEqual(result.extensionsResult.errors, []);
  result.session.agent.streamFunction = () => complete();
  return { ...result, settingsManager, errors };
}

function project(name) {
  const cwd = join(scratch, name);
  const agentDir = join(scratch, `${name}-agent`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  return { cwd, agentDir };
}

test("feature is additive-only and distinct from session reload veto", () => {
  assert.equal(configReloadFeature.id, "config-reload");
  assert.deepEqual(patches, []);
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.match(readFileSync(join(staged.root, "rubato-features/config-reload/THIRD_PARTY_NOTICES.md"), "utf8"), /features\/reload/);
  for (const entry of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
  const factories = configReload.createConfigReloadExtensionFactories({
    settingsManager: { reload: async () => {} },
    agentDir: scratch,
    cwd: scratch,
  });
  assert.deepEqual(factories.map((entry) => entry.name), ["rubato-config-reload"]);
  assert.deepEqual(applyFeatureToggles(factories, new Set(["rubato-config-reload"])).extensionFactories, []);
});

test("stock SDK re-applies settings.json and ignores routine-only plus generated shims", async (t) => {
  const dirs = project("watch");
  const emitHolder = {};
  const reloads = [];
  const fixture = await createFixture({
    ...dirs,
    emitHolder,
    requestReload: async (paths) => { reloads.push([...paths]); },
  });
  t.after(() => fixture.session.dispose());
  await fixture.session.prompt("wake");
  assert.equal(typeof emitHolder.emit, "function");

  writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({ transport: "sse" }));
  emitHolder.emit({ path: join(dirs.agentDir, "settings.json") });
  await waitTick();
  assert.equal(fixture.settingsManager.getTransport(), "sse");
  assert.equal(reloads.length, 1);

  writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({
    transport: "sse",
    compaction: { enabled: true, thresholdRatio: 0.88 },
  }));
  emitHolder.emit({ path: join(dirs.agentDir, "settings.json") });
  await waitTick();
  assert.equal(reloads.length, 1, "routine compaction-only writes must not reload");

  const bannerless = join(dirs.agentDir, "extensions", "tps.js");
  writeFileSync(bannerless, "export default function tps() {}\n");
  emitHolder.emit({ path: bannerless });
  await waitTick();
  assert.equal(reloads.length, 2, "bannerless extension writes count as reloads");

  const generated = join(dirs.agentDir, "extensions", "generated.js");
  writeFileSync(generated, "// Generated by senpi\\nexport default function shim() {}\n");
  emitHolder.emit({ path: generated });
  await waitTick();
  assert.equal(reloads.length, 2, "generated shims must not reload");
});

test("disabled factory never watches, so settings writes do not re-apply", async (t) => {
  const dirs = project("disabled");
  const emitHolder = {};
  const reloads = [];
  const fixture = await createFixture({
    ...dirs,
    emitHolder,
    includeFactory: false,
    requestReload: async (paths) => { reloads.push([...paths]); },
  });
  t.after(() => fixture.session.dispose());
  await fixture.session.prompt("wake");
  writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({ transport: "sse" }));
  assert.equal(emitHolder.emit, undefined);
  assert.equal(reloads.length, 0);
  assert.equal(fixture.settingsManager.getTransport(), "auto");
});
