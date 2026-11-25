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

import { PI_VERSION } from "../../pi-version.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { runtimeFactoriesFeature } from "../runtime-factories/feature.mjs";
import { applyFeatureToggles } from "../rubato-components/feature-toggles.mjs";
import { compactionFeature, files, patches } from "./feature.mjs";
import {
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_WIRE_TOOL_NAMES,
} from "../../../rubato-pi/src/transforms/misc-claude-code-version.mjs";

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
  runtime.packages["@earendil-works/pi-ai"].dir,
  "dist/utils/event-stream.js",
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
      thresholdRatio: 0.9,
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
  assert.equal(patches.length, 3);
  assert.equal(new Set(patches.map((entry) => entry.path)).size, patches.length);
  assert.ok(patches.every((entry) => entry.version === PI_VERSION));
  assert.ok(patches.every((entry) => /^[a-f0-9]{64}$/.test(entry.preimageSha256)));
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.match(readFileSync(join(staged.root, "rubato-features/compaction/relationship.md"), "utf8"), /history-notes/);
  assert.match(readFileSync(join(staged.root, "rubato-features/compaction/THIRD_PARTY_NOTICES.md"), "utf8"), /MIT/);
  for (const entry of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", entry.sourcePath], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
});

test("the staged engine sends the declared Claude Code identity, not stock's", () => {
  // 이 패치가 유일한 주입점이다. 빠지면 stock 2.1.251 이 그대로 나가 400 을 받는다
  // (2026-09-23 실측). 선언을 올려도 구운 엔진이 안 따라가면 여기서 깨진다.
  const wire = readFileSync(join(
    runtime.packages["@earendil-works/pi-ai"].dir,
    "dist/api/anthropic-messages.js",
  ), "utf8");
  assert.ok(wire.includes(`const claudeCodeVersion = "${CLAUDE_CODE_VERSION}";`));
  assert.ok(wire.includes(CLAUDE_CODE_BILLING_HEADER));
});

test("OAuth sends deep_research under its wire casing and maps the model's call back", async () => {
  // 구독 계정 하나가 도구 목록의 정확한 이름 `deep_research` 를 보고 요청 전체를 400 으로 거절한다.
  assert.ok(CLAUDE_CODE_WIRE_TOOL_NAMES.includes("Deep_Research"));
  const piAiDir = runtime.packages["@earendil-works/pi-ai"].dir;
  const anthropic = await import(pathToFileURL(join(piAiDir, "dist/api/anthropic-messages.js")).href);
  const { anthropicProvider } = await import(pathToFileURL(join(piAiDir, "dist/providers/anthropic.js")).href);
  const model = anthropicProvider().getModels().find((candidate) =>
    candidate.compat?.supportsMidConvoSystemMessages && candidate.compat?.supportsMidConvoToolChanges);
  assert.ok(model);
  const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages = [
    { role: "system", content: "base prompt", toolsAdded: [tool("read"), tool("deep_research")], timestamp: 1 },
    { role: "user", content: "research it", timestamp: 1 },
    {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "toolu_dr", name: "deep_research", arguments: { question: "q" } }],
    },
    { role: "toolResult", toolCallId: "toolu_dr", toolName: "deep_research", content: [{ type: "text", text: "submitted" }], isError: false, timestamp: 1 },
    { role: "user", content: "again", timestamp: 1 },
  ];

  let payload;
  const sse = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_next", name: "Deep_Research", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"question\":\"q2\"}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const result = await anthropic.stream(model, { messages }, {
    apiKey: "sk-ant-oat01-test-not-real",
    fetch,
    onPayload: (params) => { payload = structuredClone(params); },
  }).result();

  const body = JSON.stringify(payload);
  assert.doesNotMatch(body, /"name":"deep_research"/, "no tool name on the wire is exactly deep_research");
  assert.ok(payload.tools.some((entry) => entry.name === "Deep_Research"));
  assert.match(body, /"type":"tool_use"[^}]*"name":"Deep_Research"/);
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  const call = result.content.find((block) => block.type === "toolCall");
  assert.equal(call.name, "deep_research");
  assert.deepEqual(call.arguments, { question: "q2" });
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
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 10,
        thresholdRatio: 0.01,
        idleCompactionEnabled: true,
      },
    },
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
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 10,
        thresholdRatio: 0.9,
        idleCompactionEnabled: true,
      },
    },
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
        thresholdRatio: 0.99,
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
