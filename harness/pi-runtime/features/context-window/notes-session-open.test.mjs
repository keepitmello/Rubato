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
const scratch = mkdtempSync(join(tmpdir(), "rubato-notes-session-open-"));
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
  features: [...await loadPiFeatures(["context-notes", "context-window"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const protocol = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/protocol.mjs",
)));
const modePolicy = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/mode-policy.mjs",
)));
const contextConfig = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/config.mjs",
)));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)));

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

function usage() {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function withMode(t, { mode, origin } = {}) {
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

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function writeNotesSession(name) {
  const cwd = join(scratch, name + "-cwd");
  const sessionDir = join(scratch, name + "-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = sdk.SessionManager.create(cwd, sessionDir);
  const window0 = protocol.initialWindow();
  manager.appendCustomEntry(protocol.INIT_ENTRY, { window: window0 });
  manager.appendCustomEntry(protocol.MODE_ENTRY, { mode: "history-notes" });
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "keep this session as a notes window" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "noted" }],
    api: "openai-completions",
    provider: "notes-session-open-test",
    model: "fake-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const window1 = protocol.nextWindow(window0);
  manager.appendCompaction(
    protocol.encodeBootstrap(window1, "handoff.md"),
    manager.getLeafId(),
    24,
    { source: protocol.SOURCE, window: window1 },
  );
  return { cwd, sessionDir, sourcePath: manager.getSessionFile() };
}

function copySession(sourcePath, name) {
  const sessionDir = join(scratch, name + "-copies");
  mkdirSync(sessionDir, { recursive: true });
  const copyPath = join(sessionDir, name + ".jsonl");
  copyFileSync(sourcePath, copyPath);
  return { sessionDir, copyPath };
}

const source = writeNotesSession("notes-source");

function writeModels(agentDir) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "openai-codex": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: "gpt-6-astra", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
    },
  }));
}

const ASTRA = {
  provider: "openai-codex",
  id: "gpt-6-astra",
  name: "gpt-6-astra",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function resumeNotesSession(t, { name, cwd, env }) {
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(agentDir, { recursive: true });
  writeModels(agentDir);
  const { copyPath, sessionDir } = copySession(source.sourcePath, name);
  const opened = sdk.SessionManager.open(copyPath, sessionDir, cwd);
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "context-notes", factory: createContextNotesExtension({ agentDir, settingsManager, env, propagateEnv: false }) },
    ],
  });
  await resourceLoader.reload();
  const errors = [];
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: opened,
    model: ASTRA,
  });
  t.after(() => created.session.dispose());
  await created.session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, confirm: async () => false },
    onError(error) { errors.push(error); },
  });
  return { session: created.session, errors, opened };
}

test("copied notes-window session still builds context when process env is user-explicit summary", (t) => {
  withMode(t, { mode: "summary" });
  const { copyPath, sessionDir } = copySession(source.sourcePath, "open-summary-context");
  const opened = sdk.SessionManager.open(copyPath, sessionDir, source.cwd);
  const context = opened.buildSessionContext();
  assert.ok(context.messages.some((message) => textOf(message).startsWith(protocol.BOOTSTRAP_PREFIX)));
});

test("copied notes-window session opens without NOTES_RESUME_IN_SUMMARY when env is unset", (t) => {
  withMode(t);
  const { copyPath, sessionDir } = copySession(source.sourcePath, "open-default");
  const opened = sdk.SessionManager.open(copyPath, sessionDir, source.cwd);
  const context = opened.buildSessionContext();
  assert.ok(context.messages.some((message) => textOf(message).startsWith(protocol.BOOTSTRAP_PREFIX)));
});

test("createAgentSession resumes a history-notes session when process env is user-explicit history-notes", async (t) => {
  withMode(t, { mode: "history-notes" });
  const { errors, opened } = await resumeNotesSession(t, { name: "resume-explicit-notes", cwd: source.cwd, env: { RUBATO_CONTEXT_MODE: "history-notes" } });
  assert.equal(contextConfig.historyNotesEnabledForSession(opened.getSessionId()), true);
  assert.deepEqual(errors.map((error) => error?.message ?? String(error)).filter((message) => message.includes("작업 노트 방식")), []);
});

test("createAgentSession resumes a history-notes session after a neighbor resolved summary", async (t) => {
  withMode(t, { mode: "history-notes" });
  contextConfig.setContextMode("summary");
  const { errors } = await resumeNotesSession(t, { name: "resume-after-neighbor", cwd: source.cwd, env: { RUBATO_CONTEXT_MODE: "summary", RUBATO_CONTEXT_MODE_ORIGIN: "session" } });
  const refused = errors.map((error) => error?.message ?? String(error)).filter((message) => message.includes("작업 노트 방식"));
  assert.deepEqual(refused, []);
});

