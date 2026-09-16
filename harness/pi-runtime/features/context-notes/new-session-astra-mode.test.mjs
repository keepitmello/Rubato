import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-new-session-astra-mode-"));
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

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

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

async function raceWithoutConfirm(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} awaited a confirm instead of adopting the model default`));
        }, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("brand-new session selecting Astra adopts notes without a confirm", async (t) => {
  withFreshMode(t);
  const cwd = join(scratch, "fresh-astra-cwd");
  const agentDir = join(scratch, "fresh-astra-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeModels(agentDir);

  const settingsManager = sdk.SettingsManager.inMemory();
  const hostedEnv = {};
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      {
        name: "context-notes",
        factory: createContextNotesExtension({
          agentDir,
          settingsManager,
          env: hostedEnv,
          propagateEnv: false,
        }),
      },
    ],
  });
  await resourceLoader.reload();

  const confirms = [];
  const errors = [];
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    // T3 starts the runtime before set_model(astra). A non-notes default
    // here is the hosted path: session_start has no Astra in hand.
    model: modelFor(FABLE),
  });
  t.after(() => created.session.dispose());
  await created.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      notify() {},
      setStatus() {},
      confirm(title, message) {
        confirms.push({ title, message });
        return new Promise(() => {});
      },
    },
    onError(error) { errors.push(error); },
  });
  assert.deepEqual(errors, [], "session_start must bind without errors");
  assert.equal(
    modePolicy.recordedModeFromBranch(created.session.sessionManager.getBranch()),
    undefined,
    "session_start must not persist a provisional mode before the real model lands",
  );

  await raceWithoutConfirm(
    created.session.extensionRunner.emit({
      type: "model_select",
      model: modelFor(ASTRA),
      source: "set",
    }),
    "model_select",
  );

  assert.deepEqual(confirms, [], "first Astra select on a blank session must not raise 문맥 모드");
  assert.equal(
    contextConfig.historyNotesEnabledForSession(sessionIdOf(created.session), hostedEnv),
    true,
    "Astra's model default must win once set_model lands",
  );
  assert.equal(
    modePolicy.recordedModeFromBranch(created.session.sessionManager.getBranch()),
    contextConfig.HISTORY_NOTES_MODE,
  );
  assert.deepEqual(errors, []);
});
