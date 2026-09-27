import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-mode-switch-resume-"));
const previousHome = process.env.HOME;
const previousOffline = process.env.PI_OFFLINE;
const previousMode = process.env.RUBATO_CONTEXT_MODE;
const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
delete process.env.RUBATO_CONTEXT_MODE;
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
mkdirSync(process.env.HOME, { recursive: true });

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["context-notes"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const featureRoot = join(runtime.codingAgentDir, "dist/rubato-features/context-notes");
const contextConfig = await import(pathToFileURL(join(featureRoot, "src/context-notes/config.mjs")));
const engineGate = await import(pathToFileURL(join(featureRoot, "src/context-notes/engine-gate.mjs")));
const protocol = await import(pathToFileURL(join(featureRoot, "src/context-notes/protocol.mjs")));
const { createContextNotesExtension } = await import(pathToFileURL(join(featureRoot, "extension.mjs")));
engineGate.installSettingsGate(sdk.SettingsManager);

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  if (previousMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousMode;
  if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
  contextConfig.resetContextModeResolution();
  rmSync(scratch, { recursive: true, force: true });
});

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };
const GROK = { provider: "xai", id: "grok-4.7" };
const EXTERNAL = { provider: "claude-sdk-oauth", id: "claude-fable-5-1" };

function modelFor(ref) {
  return {
    ...ref, name: ref.id,
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", reasoning: false,
    input: ["text"], contextWindow: 100_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function writeModels(agentDir) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: Object.fromEntries([ASTRA, FABLE, GROK, EXTERNAL].map((ref) => [ref.provider, {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused-test-key",
      models: [{ id: ref.id, input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
    }])),
  }));
}

function freshMode(t) {
  contextConfig.resetContextModeResolution();
  delete process.env.RUBATO_CONTEXT_MODE;
  delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  t.after(() => {
    delete process.env.RUBATO_CONTEXT_MODE;
    delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    contextConfig.resetContextModeResolution();
  });
}

function assistant(text = "noted") {
  return {
    role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "openai-codex", model: "gpt-6-astra",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

async function openSession(t, { name, model, env = {}, sessionManager, confirm } = {}) {
  const cwd = join(scratch, name + "-cwd");
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeModels(agentDir);
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: 8 },
  });
  const spy = {};
  const confirms = [];
  const errors = [];
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "context-notes", factory: createContextNotesExtension({ agentDir, settingsManager, env, propagateEnv: false }) },
      { name: "spy", factory: (pi) => { spy.pi = pi; } },
    ],
  });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: sessionManager ?? sdk.SessionManager.inMemory(cwd),
    model: modelFor(model),
  });
  t.after(() => created.session.dispose());
  let bindError;
  try {
    await created.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        notify() {}, setStatus() {},
        confirm: confirm ?? (async (title, message) => { confirms.push({ title, message }); return false; }),
      },
      onError(error) { errors.push(error?.error ?? error?.message ?? String(error)); },
    });
  } catch (error) {
    bindError = error?.message ?? String(error);
  }
  return { session: created.session, settingsManager, confirms, errors, bindError, spy };
}

function reopen(seeded, name) {
  const copyDir = join(scratch, name + "-copy");
  mkdirSync(copyDir, { recursive: true });
  const copyPath = join(copyDir, name + ".jsonl");
  copyFileSync(seeded.getSessionFile(), copyPath);
  return sdk.SessionManager.open(copyPath, copyDir, seeded.getCwd());
}

function inits(session) {
  return session.sessionManager.getEntries().filter((entry) => entry.customType === protocol.INIT_ENTRY);
}

async function selectModel(session, model) {
  return session.extensionRunner.emit({ type: "model_select", model: modelFor(model), source: "set" });
}

test("first model_select after session_start adopts summary without waiting on confirm", async (t) => {
  freshMode(t);
  const opened = await openSession(t, { name: "late-select", model: FABLE });
  assert.equal(opened.bindError, undefined);
  assert.equal(inits(opened.session).length > 0, true);
  const pending = selectModel(opened.session, EXTERNAL);
  const winner = await Promise.race([
    pending.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 400)),
  ]);
  assert.equal(winner, "done");
  await pending;
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.session.sessionManager.getSessionId()), false);
  assert.equal(opened.confirms.length, 0);
});

test("a used unrecorded summary session stays summary when the user declines", async (t) => {
  freshMode(t);
  const opened = await openSession(t, { name: "silent-switch", model: EXTERNAL });
  opened.session.sessionManager.appendMessage({
    role: "user", content: [{ type: "text", text: "summary session already in use" }], timestamp: Date.now(),
  });
  await selectModel(opened.session, ASTRA);
  assert.equal(opened.confirms.length, 1);
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.session.sessionManager.getSessionId()), false);
  assert.equal(inits(opened.session).length, 0);
});

test("a notes boundary that lands during confirm still refuses summary", async (t) => {
  freshMode(t);
  const opened = await openSession(t, {
    name: "stale-confirm",
    model: ASTRA,
    confirm: async () => {
      const window0 = inits(opened.session)[0].data.window;
      const window1 = protocol.nextWindow(window0);
      opened.session.sessionManager.appendCompaction(
        protocol.encodeBootstrap(window1, "checkpoint"),
        opened.session.sessionManager.getLeafId(),
        24,
        { source: protocol.SOURCE, window: window1 },
      );
      return true;
    },
  });
  opened.session.sessionManager.appendMessage({
    role: "user", content: [{ type: "text", text: "talked before the switch" }], timestamp: Date.now(),
  });
  await selectModel(opened.session, EXTERNAL);
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.session.sessionManager.getSessionId()), true);
});

test("user-explicit summary resume of a notes session refuses before enabling compaction", async (t) => {
  freshMode(t);
  const cwd = join(scratch, "resume-cwd");
  const sessionDir = join(scratch, "resume-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const seeded = sdk.SessionManager.create(cwd, sessionDir);
  const window0 = protocol.initialWindow();
  seeded.appendCustomEntry(protocol.INIT_ENTRY, { window: window0 });
  seeded.appendCustomEntry(protocol.MODE_ENTRY, { mode: "history-notes" });
  seeded.appendMessage({ role: "user", content: [{ type: "text", text: "keep notes" }], timestamp: Date.now() });
  const window1 = protocol.nextWindow(window0);
  seeded.appendCompaction(protocol.encodeBootstrap(window1), seeded.getLeafId(), 8, { source: protocol.SOURCE, window: window1 });
  seeded.appendMessage(assistant("kept"));
  const opened = await openSession(t, {
    name: "resume-notes", model: ASTRA,
    env: { RUBATO_CONTEXT_MODE: "summary" },
    sessionManager: reopen(seeded, "resume-notes"),
  });
  const refused = [opened.bindError, ...opened.errors].filter((message) => String(message ?? "").includes("작업 노트 방식"));
  assert.equal(refused.length > 0, true);
  assert.equal(opened.settingsManager.getCompactionSettings().enabled, false);
});

test("returning to a notes branch restores notes tools that were active", async (t) => {
  freshMode(t);
  const cwd = join(scratch, "tools-cwd");
  const sessionDir = join(scratch, "tools-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const seeded = sdk.SessionManager.create(cwd, sessionDir);
  seeded.appendMessage({ role: "user", content: [{ type: "text", text: "visible" }], timestamp: Date.now() });
  seeded.appendMessage(assistant("reply"));
  const opened = await openSession(t, { name: "tools-back", model: ASTRA, sessionManager: reopen(seeded, "tools-back") });
  const pi = opened.spy.pi;
  const leaf = opened.session.sessionManager.getLeafId();
  const root = opened.session.sessionManager.getEntries().find((entry) => entry.parentId == null);
  pi.setActiveTools([...pi.getActiveTools(), "notes_write_file"]);
  const jumped = await opened.session.navigateTree(root.id, { summarize: false });
  assert.equal(jumped.cancelled, false);
  assert.equal(pi.getActiveTools().includes("notes_write_file"), false);
  const back = await opened.session.navigateTree(leaf, { summarize: false });
  assert.equal(back.cancelled, false);
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.session.sessionManager.getSessionId()), true);
  assert.equal(pi.getActiveTools().includes("notes_write_file"), true);
});

test("a model switch after jumping before the notes window asks and does not plant a window when declined", async (t) => {
  freshMode(t);
  const cwd = join(scratch, "root-switch-cwd");
  const sessionDir = join(scratch, "root-switch-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const seeded = sdk.SessionManager.create(cwd, sessionDir);
  seeded.appendMessage({ role: "user", content: [{ type: "text", text: "visible" }], timestamp: Date.now() });
  seeded.appendMessage(assistant("reply"));
  const opened = await openSession(t, { name: "root-switch", model: ASTRA, sessionManager: reopen(seeded, "root-switch") });
  const root = opened.session.sessionManager.getEntries().find((entry) => entry.parentId == null);
  const before = inits(opened.session).length;
  await opened.session.navigateTree(root.id, { summarize: false });
  await selectModel(opened.session, GROK);
  assert.equal(opened.confirms.length, 1);
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.session.sessionManager.getSessionId()), false);
  assert.equal(inits(opened.session).length, before);
});
