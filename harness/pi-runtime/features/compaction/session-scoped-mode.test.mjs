import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { childRuntimeFeature } from "../child-runtime/feature.mjs";
import { feature as contextNotesFeature } from "../context-notes/patches.mjs";
import { feature as contextWindowFeature } from "../context-window/patches.mjs";
import { providerExecutionFeature } from "../provider-execution/patches.mjs";
import { providersFeature } from "../providers/patches.mjs";
import { toolExecutionFeature } from "../tool-execution/patches.mjs";
import { toolGuardsFeature } from "../tool-guards/feature.mjs";
import { compactionFeature } from "./feature.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-session-scoped-mode-"));
const previousMode = process.env.RUBATO_CONTEXT_MODE;
const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
const previousHome = process.env.HOME;
const previousOffline = process.env.PI_OFFLINE;
delete process.env.RUBATO_CONTEXT_MODE;
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.HOME, { recursive: true });

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [
    toolExecutionFeature,
    providersFeature,
    providerExecutionFeature,
    contextNotesFeature,
    contextWindowFeature,
    compactionFeature,
    toolGuardsFeature,
    childRuntimeFeature,
  ],
});
const runtime = staged.runtime;
const sdk = await import(pathToFileURL(runtime.sdkEntry).href);
const childRuntime = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/child-runtime/stock-rpc-runtime.mjs",
)).href);
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)).href);
const contextConfig = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/config.mjs",
)).href);
const compaction = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/compaction/index.mjs",
)).href);

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

after(() => {
  if (previousMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousMode;
  if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  contextConfig.resetContextModeResolution();
  rmSync(scratch, { recursive: true, force: true });
});

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
      "openai-codex": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: ASTRA.id, input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        apiKey: "unused-test-key",
        models: [{ id: FABLE.id, input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
    },
  }));
}

function withFreshMode(t) {
  contextConfig.resetContextModeResolution();
  delete process.env.RUBATO_CONTEXT_MODE;
  delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  t.after(() => {
    delete process.env.RUBATO_CONTEXT_MODE;
    delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    contextConfig.resetContextModeResolution();
  });
}

function sessionIdOf(session) {
  return session?.sessionId ?? session?.sessionManager?.getSessionId?.();
}

function notesEnabledForSession(session) {
  const sessionId = sessionIdOf(session);
  assert.equal(typeof contextConfig.historyNotesEnabledForSession, "function", "historyNotesEnabledForSession must exist for session-scoped gates");
  return contextConfig.historyNotesEnabledForSession(sessionId);
}

function compactionEntries(session) {
  return session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
}

async function emitBeforeCompact(session) {
  return session.extensionRunner.emit({
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: AbortSignal.timeout(5_000),
  });
}

function isNotesCompactVeto(result) {
  return result?.cancel === true && /작업 노트/.test(String(result?.reason ?? ""));
}

async function openParent(t, { name, model }) {
  const cwd = join(scratch, name + "-cwd");
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeModels(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 10, thresholdRatio: 0.9 },
  }));
  const settingsManager = sdk.SettingsManager.inMemory();
  const factories = [
    { name: "context-notes", factory: createContextNotesExtension({ agentDir, settingsManager }) },
    ...compaction.createCompactionExtensionFactories({ settingsManager, env: process.env }),
  ];
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories,
  });
  await resourceLoader.reload();
  const errors = [];
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: modelFor(model),
    tools: ["notes_write_file", "new_context", "read"],
  });
  t.after(() => created.session.dispose());
  await created.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, confirm: async () => false },
    onError(error) { errors.push(error); },
  });
  assert.deepEqual(errors, [], name + " parent bindExtensions errors");
  return { session: created.session, settingsManager, resourceLoader };
}

async function openChild(t, { name, model }) {
  const cwd = join(scratch, name + "-cwd");
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeModels(agentDir);
  const settingsManager = sdk.SettingsManager.inMemory();
  const extensionFactories = await childRuntime.loadStockChildInProcessFactories({
    root: staged.root,
    agentDir,
    settingsManager,
  });
  assert.equal(extensionFactories.some((entry) => entry.name === "context-notes"), true);
  const session = await childRuntime.createStockChildInProcessSession({
    cwd,
    agentDir,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: modelFor(model),
  }, {
    createAgentSession: sdk.createAgentSession,
    DefaultResourceLoader: sdk.DefaultResourceLoader,
    extensionFactories,
  });
  t.after(() => session.dispose?.());
  return { session, settingsManager };
}

test("parent Fable summary overlay stays on after in-process Astra notes child adopts", async (t) => {
  withFreshMode(t);
  const parent = await openParent(t, { name: "parent-summary", model: FABLE });
  assert.equal(parent.settingsManager.getCompactionSettings().enabled, true, "parent summary baseline: overlay settings on");
  assert.equal(compaction.summaryCompactionAllowed(process.env, parent.settingsManager.getCompactionSettings()), true);
  assert.equal(notesEnabledForSession(parent.session), false, "parent summary baseline: notes gate off");

  const child = await openChild(t, { name: "child-notes", model: ASTRA });
  assert.notEqual(child.settingsManager, parent.settingsManager);
  assert.equal(notesEnabledForSession(child.session), true, "child Astra must adopt notes");
  assert.equal(child.settingsManager.getCompactionSettings().enabled, false, "child notes must disable compaction settings");
  assert.equal(isNotesCompactVeto(await emitBeforeCompact(child.session)), true, "child notes must veto compact");

  assert.equal(notesEnabledForSession(parent.session), false, "parent notes gate must stay off after child notes adopt");
  assert.equal(parent.settingsManager.getCompactionSettings().enabled, true, "parent overlay settings must stay enabled");
  assert.equal(
    compaction.summaryCompactionAllowed(process.env, parent.settingsManager.getCompactionSettings()),
    true,
    "parent summary overlay must stay allowed after child notes adopt",
  );
  assert.equal(isNotesCompactVeto(await emitBeforeCompact(parent.session)), false, "parent summary must not inherit the child notes veto");
});

test("parent Astra notes compact veto survives in-process Fable summary child adopt", async (t) => {
  withFreshMode(t);
  const parent = await openParent(t, { name: "parent-notes", model: ASTRA });
  assert.equal(parent.settingsManager.getCompactionSettings().enabled, false, "parent notes baseline: overlay settings off");
  assert.equal(notesEnabledForSession(parent.session), true, "parent notes baseline: notes gate on");
  assert.equal(isNotesCompactVeto(await emitBeforeCompact(parent.session)), true, "parent notes baseline: compact veto");
  assert.equal(compactionEntries(parent.session).length, 0);

  const child = await openChild(t, { name: "child-summary", model: FABLE });
  assert.notEqual(child.settingsManager, parent.settingsManager);
  assert.equal(notesEnabledForSession(child.session), false, "child Fable must adopt summary");
  assert.equal(child.settingsManager.getCompactionSettings().enabled, true, "child summary must not inherit the parent notes settings wrap");
  assert.equal(isNotesCompactVeto(await emitBeforeCompact(child.session)), false, "child summary must not veto compact as notes");

  assert.equal(parent.settingsManager.getCompactionSettings().enabled, false, "parent notes settings must stay disabled after child summary adopt");
  assert.equal(notesEnabledForSession(parent.session), true, "parent notes gate must stay on after child summary adopt");
  assert.equal(
    isNotesCompactVeto(await emitBeforeCompact(parent.session)),
    true,
    "parent session_before_compact must still cancel with the notes veto",
  );
  assert.equal(
    compactionEntries(parent.session).length,
    0,
    "parent notes session must not gain a stock compaction entry from the child's summary adopt",
  );
});
