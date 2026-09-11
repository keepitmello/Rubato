import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { runtimeFactoriesFeature } from "../runtime-factories/feature.mjs";
import { compactionFeature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-summary-parity-"));
const isolatedHome = join(scratch, "home");
mkdirSync(isolatedHome);

const previousEnv = {
  HOME: process.env.HOME,
  PI_OFFLINE: process.env.PI_OFFLINE,
  RUBATO_CONTEXT_MODE: process.env.RUBATO_CONTEXT_MODE,
};
process.env.HOME = isolatedHome;
process.env.PI_OFFLINE = "1";
delete process.env.RUBATO_CONTEXT_MODE;

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
const anthropicMessages = await import(pathToFileURL(join(
  runtime.packages["@earendil-works/pi-ai"].dir,
  "dist/api/anthropic-messages.js",
)).href);
const stockCompaction = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/core/compaction/compaction.js",
)).href);
const compaction = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/compaction/index.mjs",
)).href);

const { COMPACTION_BRIEFING_GUIDANCE } = compaction;
const CONTEXT_WINDOW = 200_000;
const PRODUCT_RATIO = 0.9;
const SERVER_TRIGGER_RATIO = 0.65;
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

after(() => {
  restoreEnv("HOME", previousEnv.HOME);
  restoreEnv("PI_OFFLINE", previousEnv.PI_OFFLINE);
  restoreEnv("RUBATO_CONTEXT_MODE", previousEnv.RUBATO_CONTEXT_MODE);
  rmSync(scratch, { recursive: true, force: true });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withMode(t, mode) {
  if (mode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = mode;
  t.after(() => delete process.env.RUBATO_CONTEXT_MODE);
}

function assistant(text = "<summary>briefing</summary>") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "parity-test",
    model: "fake-model",
    usage: {
      input: 4000,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4004,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function complete(message) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}

function pad(label) {
  return label + " " + "x".repeat(5000);
}

function model(overrides = {}) {
  return {
    provider: overrides.provider ?? "parity-test",
    id: overrides.id ?? "fake-model",
    name: overrides.name ?? "Offline parity fixture",
    api: overrides.api ?? "openai-completions",
    baseUrl: overrides.baseUrl ?? "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: overrides.contextWindow ?? CONTEXT_WINDOW,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function textSse(text) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_local",
        type: "message",
        role: "assistant",
        model: "local",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function contextText(context) {
  const parts = [];
  if (typeof context?.systemPrompt === "string") parts.push(context.systemPrompt);
  for (const message of context?.messages ?? []) {
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function compactEdit(body) {
  const edits = body?.context_management?.edits;
  if (!Array.isArray(edits)) return undefined;
  return edits.find((entry) => entry && entry.type === "compact_20260112");
}

function betaList({ headers, body }) {
  const fromHeader = String(headers?.["anthropic-beta"] ?? headers?.["Anthropic-Beta"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const fromBody = Array.isArray(body?.betas) ? body.betas.map(String) : [];
  return [...new Set([...fromHeader, ...fromBody])];
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  if (last?.type === "error") throw new Error(String(last.error?.errorMessage ?? last.error).slice(0, 400));
  return events;
}

async function captureAnthropicRequest(mode) {
  process.env.RUBATO_CONTEXT_MODE = mode;
  const captured = { url: undefined, headers: undefined, body: undefined };
  const stream = anthropicMessages.streamSimple(
    model({
      ...FABLE,
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9",
      contextWindow: CONTEXT_WINDOW,
    }),
    {
      systemPrompt: "parity-system",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    },
    {
      apiKey: "sk-ant-test-offline",
      maxRetries: 0,
      env: process.env,
      fetch: async (input, init = {}) => {
        const request = typeof input === "string" || input instanceof URL ? undefined : input;
        captured.url = typeof input === "string" ? input : input?.url ?? String(input);
        captured.headers = Object.fromEntries(new Headers(request?.headers ?? init.headers ?? {}).entries());
        const raw = init.body ?? (request ? await request.clone().text() : undefined);
        captured.body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw ?? "null").toString("utf8"));
        return sseResponse(textSse("ok"));
      },
    },
  );
  await drain(stream);
  return captured;
}

function project(name) {
  const cwd = join(scratch, name);
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

async function createFixture({ cwd, agentDir, includeOverlay = true, settings }) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "parity-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [{ id: "fake-model", input: ["text"], contextWindow: CONTEXT_WINDOW, maxTokens: 4096 }],
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
  return { ...result, services, settingsManager, errors };
}

test("stock shouldCompact uses product 0.9 and settings.thresholdRatio", () => {
  const defaultSettings = sdk.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 10 },
  }).getCompactionSettings();
  const ratioSettings = sdk.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 10, thresholdRatio: 0.88 },
  }).getCompactionSettings();

  assert.equal(defaultSettings.thresholdRatio, undefined);
  assert.equal(ratioSettings.thresholdRatio, 0.88);

  const window = 100_000;
  const productTrigger = Math.floor(window * PRODUCT_RATIO);
  assert.equal(stockCompaction.shouldCompact(productTrigger, window, { enabled: true }), true);
  assert.equal(stockCompaction.shouldCompact(productTrigger - 1, window, { enabled: true }), false);
  assert.equal(stockCompaction.shouldCompact(productTrigger, window, defaultSettings), true);
  assert.equal(stockCompaction.shouldCompact(productTrigger - 1, window, defaultSettings), false);

  const overrideTrigger = Math.floor(window * 0.88);
  assert.equal(stockCompaction.shouldCompact(overrideTrigger, window, { enabled: true, thresholdRatio: 0.88 }), true);
  assert.equal(stockCompaction.shouldCompact(overrideTrigger - 1, window, { enabled: true, thresholdRatio: 0.88 }), false);
  assert.equal(stockCompaction.shouldCompact(overrideTrigger, window, ratioSettings), true);
  assert.equal(stockCompaction.shouldCompact(overrideTrigger - 1, window, ratioSettings), false);
});

test("client compact prompt contains COMPACTION_BRIEFING_GUIDANCE", async (t) => {
  withMode(t, "summary");
  const dirs = project("client-prompt");
  const fixture = await createFixture({
    ...dirs,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 10,
        thresholdRatio: PRODUCT_RATIO,
      },
    },
  });
  t.after(() => fixture.session.dispose());
  const prompts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    prompts.push(contextText(context));
    return complete(assistant());
  };
  await fixture.session.prompt(pad("turn-one"));
  await fixture.session.prompt(pad("turn-two"));
  await fixture.session.compact();
  const summarizer = prompts.find((text) => text.includes("conversation to summarize") || text.includes(COMPACTION_BRIEFING_GUIDANCE));
  assert.ok(summarizer, "stock compact did not issue a summarizer request");
  assert.equal(summarizer.includes(COMPACTION_BRIEFING_GUIDANCE), true);
});

test("Anthropic summary-mode request carries compact-2026-01-12, compact_20260112 edit with briefing guidance and 65% trigger", async (t) => {
  t.after(() => delete process.env.RUBATO_CONTEXT_MODE);
  const captured = await captureAnthropicRequest("summary");
  assert.ok(captured.body, "mock fetch was not called");
  assert.equal(betaList(captured).includes("compact-2026-01-12"), true);
  const edit = compactEdit(captured.body);
  assert.ok(edit, "missing compact_20260112 edit");
  assert.equal(edit.instructions, COMPACTION_BRIEFING_GUIDANCE);
  assert.deepEqual(edit.trigger, {
    type: "input_tokens",
    value: Math.floor(CONTEXT_WINDOW * SERVER_TRIGGER_RATIO),
  });
});

test("notes mode does not rewrite Anthropic request", async (t) => {
  t.after(() => delete process.env.RUBATO_CONTEXT_MODE);
  const captured = await captureAnthropicRequest("history-notes");
  assert.ok(captured.body, "mock fetch was not called");
  assert.equal(betaList(captured).includes("compact-2026-01-12"), false);
  assert.equal(compactEdit(captured.body), undefined);
  assert.equal(captured.body.context_management, undefined);
});
