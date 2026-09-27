import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRubatoComponents } from "../../build-rubato.mjs";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { CANDIDATE_FEATURE_NAMES } from "./candidate-main.mjs";

// The app-hosted server runs every session in one process and hands each worker its
// own copy of the environment (hosted-runtime.mjs createUiScope). The compaction
// overlay reads the session's context mode from that copy, so a summary session in the
// hosted shape must get the same overlay verdicts as in a standalone CLI process.

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-hosted-context-mode-"));
const saved = Object.fromEntries(["HOME", "PI_OFFLINE", "PI_CODING_AGENT_DIR", "RUBATO_CONTEXT_MODE", "RUBATO_CONTEXT_MODE_ORIGIN"]
  .map((key) => [key, process.env[key]]));
const agentDir = join(scratch, "home", "agent");
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.RUBATO_CONTEXT_MODE;
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
mkdirSync(agentDir, { recursive: true });

const build = await buildRubatoComponents({ outputRoot: join(scratch, "build") });
const features = await loadPiFeatures(CANDIDATE_FEATURE_NAMES.filter((name) => name !== "runtime-factories"));
const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: [...features, build.feature] });
const sdk = await import(pathToFileURL(join(staged.root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
const { createRubatoExtensionFactories } = await import(pathToFileURL(join(staged.root, "rubato-features/rubato-components/bootstrap.mjs")));

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const claude = {
  provider: "anthropic", id: "claude-fable-5-1", name: "claude-fable-5-1", api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// One hosted runtime: createCliRuntimeFactory calls createExtensionFactories per runtime,
// and every runtime a worker creates (fork, /new) receives the same scope env object.
async function openHostedRuntime({ env, name, recordedMode }) {
  const cwd = join(scratch, name);
  mkdirSync(cwd, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory();
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const { extensionFactories } = createRubatoExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime, env, hosted: true,
    codemodeOptions: { complete: async () => { throw new Error("provider calls are forbidden here"); } },
    providerOptions: { env: { PI_OFFLINE: "1", RUBATO_SPEED_INDEX: "0", RUBATO_NO_KIRO_ENSURE: "1" },
      kiro: { ensureKiro: async () => { throw new Error("Kiro launch is forbidden here"); } } } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  if (recordedMode) sessionManager.appendCustomEntry("rubato.context-mode.v1", { mode: recordedMode });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager, model: claude });
  await session.bindExtensions({ mode: "rpc", uiContext: { notify() {}, setStatus() {}, confirm: async () => false } });
  const verdict = await session.extensionRunner.emit({ type: "session_before_compact", reason: "threshold",
    preparation: {}, branchEntries: [], signal: new AbortController().signal });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "unload" });
  session.dispose();
  return verdict;
}

test("a hosted summary session gets the summary compaction overlay, and the next runtime of the worker re-resolves", async () => {
  const workerEnv = { PI_OFFLINE: "1" };

  const summary = await openHostedRuntime({ env: workerEnv, name: "summary", recordedMode: "summary" });
  // The overlay, not the engine, answers for Claude: Anthropic's server compaction owns the window.
  assert.equal(summary?.cancel, true);
  assert.equal(summary?.rejectionCause, "external-owner");
  assert.match(summary?.reason ?? "", /Anthropic server compaction/);

  // /new or fork inside the same worker: the env copy still carries the previous session's mode.
  const notes = await openHostedRuntime({ env: workerEnv, name: "notes-after-summary" });
  assert.equal(notes?.cancel, true);
  assert.match(notes?.reason ?? "", /작업 노트 모드/);

  // The shared process env stays untouched: other sessions in the server never see it.
  assert.equal(process.env.RUBATO_CONTEXT_MODE, undefined);
  assert.equal(process.env.RUBATO_CONTEXT_MODE_ORIGIN, undefined);
});
