import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { feature as contextNotesFeature } from "../context-notes/patches.mjs";
import { feature as contextWindowFeature } from "../context-window/patches.mjs";
import { compactionFeature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-summary-mode-"));
const previousMode = process.env.RUBATO_CONTEXT_MODE;
const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
delete process.env.RUBATO_CONTEXT_MODE;
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;

const dependencies = await loadPiFeatures([
  "reload",
  "session-catalog",
]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...dependencies, contextNotesFeature, contextWindowFeature, compactionFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)).href);
const contextConfig = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/config.mjs",
)).href);
const modePolicy = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/mode-policy.mjs",
)).href);
const compaction = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/compaction/index.mjs",
)).href);
const stockCompaction = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/core/compaction/compaction.js",
)).href);

after(() => {
  if (previousMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousMode;
  if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
  contextConfig.resetContextModeResolution();
  rmSync(scratch, { recursive: true, force: true });
});

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function usage() {
  return {
    input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(text = "done") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "summary-mode-test",
    model: "fake-model",
    usage: usage(),
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

function modelFor(ref) {
  return {
    ...ref,
    name: ref.id,
    api: ref.provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    baseUrl: ref.provider === "anthropic" ? "https://api.anthropic.com" : "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function writeModels(agentDir) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "summary-mode-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: "fake-model", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
    },
  }));
}

function withFreshMode(t, { mode, origin } = {}) {
  contextConfig.resetContextModeResolution();
  if (mode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = mode;
  if (origin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = origin;
  t.after(() => {
    delete process.env.RUBATO_CONTEXT_MODE;
    delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    contextConfig.resetContextModeResolution();
  });
}

async function openSession(t, { name, model, includeOverlay = true, includeNotes = true, sessionManager, persist = false }) {
  const cwd = join(scratch, `${name}-cwd`);
  const agentDir = join(scratch, `${name}-agent`);
  const sessionDir = join(scratch, `${name}-sessions`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeModels(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 10, thresholdRatio: 0.9 },
  }));
  const settingsManager = persist
    ? sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true })
    : sdk.SettingsManager.inMemory();
  const factories = [];
  if (includeNotes) factories.push({ name: "context-notes", factory: createContextNotesExtension({ agentDir }) });
  if (includeOverlay) {
    factories.push(...compaction.createCompactionExtensionFactories({ settingsManager, env: process.env }));
  }
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories,
  });
  await resourceLoader.reload();
  const errors = [];
  const notices = [];
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: sessionManager ?? (persist ? sdk.SessionManager.create(cwd, sessionDir) : sdk.SessionManager.inMemory(cwd)),
    model: modelFor(model),
    tools: includeNotes ? ["notes_write_file", "new_context"] : ["read"],
  });
  t.after(() => created.session.dispose());
  await created.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify(message, level) { notices.push({ message, level }); }, setStatus() {}, confirm: async () => false },
    onError(error) { errors.push(error); },
  });
  created.session.agent.streamFunction = () => complete(assistant());
  return { ...created, settingsManager, errors, notices, cwd, agentDir, sessionDir };
}

test("stock-locked patches compose and keep the product guidance string", () => {
  assert.equal(compactionFeature.patches.length, 3);
  const patched = readFileSync(join(runtime.codingAgentDir, "dist/core/compaction/compaction.js"), "utf8");
  assert.match(patched, /COMPACTION_BRIEFING_GUIDANCE/);
  assert.match(patched, /resolveClientCompactionThresholdRatio/);
  assert.equal(stockCompaction.shouldCompact(90_000, 100_000, { enabled: true }), true);
  assert.equal(stockCompaction.shouldCompact(80_000, 100_000, { enabled: true }), false);
  assert.equal(stockCompaction.shouldCompact(88_000, 100_000, { enabled: true, thresholdRatio: 0.88 }), true);
  assert.match(compaction.COMPACTION_BRIEFING_GUIDANCE, /next worker will start from/);
  for (const entry of compactionFeature.files.filter((file) => file.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", entry.sourcePath], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
});

test("product mode table: Astra notes, other models summary, env wins, inherited origin re-resolves", () => {
  assert.equal(modePolicy.defaultContextModeForModel(ASTRA), contextConfig.HISTORY_NOTES_MODE);
  assert.equal(modePolicy.defaultContextModeForModel(FABLE), contextConfig.SUMMARY_MODE);
  assert.equal(modePolicy.adoptContextMode({ env: {}, model: ASTRA }), contextConfig.HISTORY_NOTES_MODE);
  assert.equal(modePolicy.adoptContextMode({ env: {}, model: FABLE }), contextConfig.SUMMARY_MODE);
  assert.equal(modePolicy.adoptContextMode({ env: { RUBATO_CONTEXT_MODE: "summary" }, model: ASTRA }), contextConfig.SUMMARY_MODE);
  assert.equal(modePolicy.adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: "history-notes", RUBATO_CONTEXT_MODE_ORIGIN: "session" },
    branch: [],
    model: FABLE,
  }), contextConfig.SUMMARY_MODE);
});

test("session_start default model activates summary overlay; Astra stays notes; env wins", async (t) => {
  withFreshMode(t);
  const summary = await openSession(t, { name: "default-summary", model: FABLE });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "summary");
  assert.equal(summary.settingsManager.getCompactionSettings().enabled, true);
  assert.equal(compaction.summaryCompactionAllowed(process.env, summary.settingsManager.getCompactionSettings()), true);

  withFreshMode(t);
  const notes = await openSession(t, { name: "default-notes", model: ASTRA });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "history-notes");
  assert.equal(notes.settingsManager.getCompactionSettings().enabled, false);
  assert.equal(compaction.summaryCompactionAllowed(process.env, { enabled: true }), false);

  withFreshMode(t, { mode: "summary" });
  const override = await openSession(t, { name: "env-wins", model: ASTRA });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "summary");
  assert.equal(override.settingsManager.getCompactionSettings().enabled, true);
});
