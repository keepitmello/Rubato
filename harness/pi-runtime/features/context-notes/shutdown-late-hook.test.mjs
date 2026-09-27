import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

// The hosted pi-server runs every session in one process, so the per-session
// gate registry is shared by a session's old and new runtime. A hook that still
// fires after session_shutdown must not open a controller the old runtime never
// closes: the reopened session then refused every turn ("문맥 관리자가 이미 실행 중").

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-context-notes-shutdown-"));
const previousHome = process.env.HOME;
const previousOffline = process.env.PI_OFFLINE;
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.HOME, { recursive: true });

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["context-notes"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)));

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(scratch, { recursive: true, force: true });
});

const model = {
  provider: "anthropic", id: "claude-fable-5-1", name: "claude-fable-5-1",
  api: "anthropic-messages", baseUrl: "https://api.anthropic.com", reasoning: false,
  input: ["text"], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function openSession({ cwd, agentDir, sessionManager }) {
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{
      name: "context-notes",
      factory: createContextNotesExtension({
        agentDir, settingsManager, propagateEnv: false,
        env: { RUBATO_CONTEXT_MODE: "history-notes", RUBATO_CONTEXT_MODE_ORIGIN: "user" },
      }),
    }],
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager, model });
  const errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { notify() {}, setStatus() {}, confirm: async () => false },
    onError(error) { errors.push(error?.error ?? error?.message ?? String(error)); },
  });
  return { session, errors };
}

test("a hook after session_shutdown does not keep the session's gate from its next runtime", async () => {
  const cwd = join(scratch, "cwd");
  const agentDir = join(scratch, "agent");
  const sessionDir = join(scratch, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const first = await openSession({ cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, sessionDir) });
  assert.deepEqual(first.errors, []);
  const runner = first.session.extensionRunner;
  await runner.emit({ type: "session_shutdown", reason: "unload" });
  // The aborted turn can still finish while other extensions handle the shutdown.
  await runner.emit({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
  first.session.dispose();

  const second = await openSession({ cwd, agentDir, sessionManager: first.session.sessionManager });
  second.session.dispose();
  assert.deepEqual(second.errors, []);
});
