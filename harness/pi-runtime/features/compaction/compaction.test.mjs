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
import { compactionFeature, files, patches } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-compaction-"));
const previousMode = process.env.RUBATO_CONTEXT_MODE;
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "stage"),
  features: [runtimeFactoriesFeature, compactionFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);
const compaction = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/compaction/index.mjs",
)).href);

after(() => {
  if (previousMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousMode;
  rmSync(scratch, { recursive: true, force: true });
});

function withoutNodeOptions(env, extra = {}) {
  const clean = { ...env, ...extra };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_COMPILE_CACHE;
  return clean;
}

function model(overrides = {}) {
  return {
    provider: overrides.provider ?? "compaction-test",
    id: overrides.id ?? "fake-model",
    name: "Offline compaction fixture",
    api: overrides.api ?? "openai-completions",
    baseUrl: overrides.baseUrl ?? "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function assistant(content, stopReason = "stop", usageTokens = 4000) {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: "compaction-test",
    model: "fake-model",
    usage: {
      input: usageTokens,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usageTokens + 8,
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

function pad(label) {
  return `${label} ${"x".repeat(5000)}`;
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timeout waiting for compaction overlay");
}

function compactionEntries(session) {
  return session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
}

async function createFixture({
  cwd,
  agentDir,
  sessionManager,
  includeOverlay = true,
  fetchImpl,
  modelOverrides,
  settings = {
    compaction: {
      enabled: true,
      reserveTokens: 1,
      keepRecentTokens: 10,
      thresholdRatio: 0.01,
      idleCompactionEnabled: true,
    },
  },
} = {}) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "compaction-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [{ id: "fake-model", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
      openai: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-responses",
        apiKey: "offline-fixture-key",
        models: [{ id: "gpt-5.4", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
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
      includeOverlay
        ? compaction.createCompactionExtensionFactories({
          settingsManager: canonicalSettings,
          env: process.env,
          fetchImpl,
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
    sessionManager,
    model: model(modelOverrides),
    tools: ["read"],
  });
  const errors = [];
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, setWidget() {} },
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

test("feature is additive-only and documents the notes vs summary relationship", () => {
  assert.equal(compactionFeature.id, "compaction");
  assert.deepEqual(patches, []);
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.match(readFileSync(join(staged.root, "rubato-features/compaction/relationship.md"), "utf8"), /history-notes/);
  assert.match(readFileSync(join(staged.root, "rubato-features/compaction/THIRD_PARTY_NOTICES.md"), "utf8"), /MIT/);
  for (const entry of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
});

test("product threshold and circuit-breaker match the overlay contract", () => {
  assert.equal(compaction.shouldTriggerCompaction(
    { tokens: 90_000 },
    100_000,
    { enabled: true, model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  ), true);
  assert.equal(compaction.shouldTriggerCompaction(
    { tokens: 10 },
    100_000,
    { enabled: true },
  ), false);
  let state = { consecutiveFailures: 0, trippedAt: null };
  const t0 = 1_000;
  state = compaction.recordFailure(state, t0);
  state = compaction.recordFailure(state, t0 + 1);
  state = compaction.recordFailure(state, t0 + 2);
  assert.equal(compaction.isTripped(state, t0 + 3), true);
  assert.equal(compaction.isTripped(state, t0 + 70_000), false);
  const factories = compaction.createCompactionExtensionFactories({
    settingsManager: { getCompactionSettings() { return { enabled: true, reserveTokens: 1, keepRecentTokens: 10 }; } },
  });
  assert.deepEqual(factories.map((entry) => entry.name), ["rubato-compaction"]);
  const disabled = applyFeatureToggles(factories, new Set(["rubato-compaction"]));
  assert.deepEqual(disabled.extensionFactories, []);
});

test("summary-mode idle overlay compacts through the stock SDK; history-notes does not", async (t) => {
  process.env.RUBATO_CONTEXT_MODE = "summary";
  const dirs = project("idle-summary");
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
  });
  t.after(() => fixture.session.dispose());
  fixture.session.agent.streamFunction = () => complete(assistant("done", "stop", 4000));
  await fixture.session.prompt(pad("turn-one"));
  await fixture.session.waitForIdle();
  if (compactionEntries(fixture.session).length === 0) {
    await fixture.session.prompt(pad("turn-two"));
    await fixture.session.waitForIdle();
  }
  await waitFor(() => compactionEntries(fixture.session).length >= 1);
  assert.ok(compactionEntries(fixture.session).length >= 1);

  process.env.RUBATO_CONTEXT_MODE = "history-notes";
  const notesDirs = project("idle-notes");
  const notes = await createFixture({
    ...notesDirs,
    sessionManager: sdk.SessionManager.inMemory(notesDirs.cwd),
  });
  t.after(() => notes.session.dispose());
  notes.session.agent.streamFunction = () => complete(assistant("done", "stop", 4000));
  await notes.session.prompt(pad("notes-one"));
  await notes.session.prompt(pad("notes-two"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  assert.equal(compactionEntries(notes.session).length, 0);
});

test("openai-remote session_before_compact supplies a result and skips the local summarizer", async (t) => {
  process.env.RUBATO_CONTEXT_MODE = "summary";
  const dirs = project("remote");
  let fetchCalls = 0;
  const fetchImpl = async (url, init) => {
    fetchCalls += 1;
    assert.match(String(url), /responses\/compact/);
    assert.equal(JSON.parse(init.body).model, "gpt-5.4");
    return {
      ok: true,
      async json() {
        return {
          id: "cmp_test",
          object: "response.compaction",
          created_at: 1,
          output: [{ type: "compaction", encrypted_content: "remote-body" }],
        };
      },
    };
  };
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
    fetchImpl,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 10,
        thresholdRatio: 0.01,
        idleCompactionEnabled: false,
      },
    },
    modelOverrides: {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:9/v1",
    },
  });
  t.after(() => fixture.session.dispose());
  let streamCalls = 0;
  fixture.session.agent.streamFunction = () => {
    streamCalls += 1;
    return complete(assistant("done", "stop", 4000));
  };
  await fixture.session.prompt(pad("remote-one"));
  await fixture.session.prompt(pad("remote-two"));
  const before = streamCalls;
  await fixture.session.compact();
  assert.equal(fetchCalls, 1);
  assert.equal(streamCalls, before, "remote result must skip the local summarizer stream");
  const entries = compactionEntries(fixture.session);
  assert.equal(entries.length, 1);
  assert.match(entries[0].summary, /OpenAI remote compaction checkpoint/);
  assert.equal(entries[0].details?.mode, "openai-remote");
});

test("disabled overlay never registers, so idle compact does not run", async (t) => {
  process.env.RUBATO_CONTEXT_MODE = "summary";
  const dirs = project("disabled");
  const fixture = await createFixture({
    ...dirs,
    sessionManager: sdk.SessionManager.inMemory(dirs.cwd),
    includeOverlay: false,
  });
  t.after(() => fixture.session.dispose());
  fixture.session.agent.streamFunction = () => complete(assistant("done", "stop", 4000));
  await fixture.session.prompt(pad("off-one"));
  await fixture.session.prompt(pad("off-two"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  assert.equal(compactionEntries(fixture.session).length, 0);
});
