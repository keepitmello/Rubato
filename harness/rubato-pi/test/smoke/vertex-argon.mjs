// Live Vertex smoke: Gemini 4 Argon through a real Rubato session.
// Path: stock pi session → Rubato providers extension → Keychain `vertex` → pi-ai google-vertex → Vertex AI.
// The session gets an empty auth.json and no Google env, so the Keychain item is the only credential.
// Never prints the credential. Usage: node harness/rubato-pi/test/smoke/vertex-argon.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ARGON = "gemini-4-argon";
const piRuntimeRoot = join(import.meta.dirname, "../../../pi-runtime");
const { stagePiRuntime } = await import(pathToFileURL(join(piRuntimeRoot, "stage-runtime.mjs")).href);
const { resolvePiRuntime } = await import(pathToFileURL(join(piRuntimeRoot, "resolve-runtime.mjs")).href);
const { providersFeature } = await import(pathToFileURL(join(piRuntimeRoot, "features/providers/patches.mjs")).href);

const scratch = mkdtempSync(join(tmpdir(), "rubato-vertex-smoke-"));
let failed = false;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failed = true;
};

try {
  const staged = await stagePiRuntime({ sourceRoot: piRuntimeRoot, outputRoot: join(scratch, "runtime"), features: [providersFeature] });
  const runtime = resolvePiRuntime({ root: staged.root });
  const piAiRoot = runtime.packages["@earendil-works/pi-ai"].dir;
  const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
  const feature = await import(pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/extension.mjs")).href);

  const cwd = join(scratch, "cwd");
  const agentDir = join(scratch, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  const env = {
    HOME: join(scratch, "home"),
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: agentDir,
    PATH: process.env.PATH,
    ...(process.env.RUBATO_VERTEX_KEYCHAIN_ACCOUNT ? { RUBATO_VERTEX_KEYCHAIN_ACCOUNT: process.env.RUBATO_VERTEX_KEYCHAIN_ACCOUNT } : {}),
  };

  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "rubato-providers",
      factory: feature.createProvidersExtension({ env, kiro: { ensureKiro: async () => {} } }),
    }],
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    noTools: "all",
  });
  await session.bindExtensions({ onError: (error) => fail(`extension: ${error?.error ?? error}`) });

  const availableModels = await session.modelRuntime.getAvailable("google-vertex");
  console.log(`available google-vertex models: ${JSON.stringify(availableModels.map((entry) => `${entry.provider}/${entry.id}`))}`);
  const model = availableModels.find((entry) => entry.id === ARGON);
  if (!model) {
    fail("gemini-4-argon is not available — is the Keychain item `vertex` there?");
  } else {
    const auth = await session.modelRuntime.getAuth(model);
    console.log(`auth source: ${auth?.source}; project: ${auth?.env?.GOOGLE_CLOUD_PROJECT}; location: ${auth?.env?.GOOGLE_CLOUD_LOCATION}`);
    await session.setModel(model);
    session.setThinkingLevel?.("low");
    const started = Date.now();
    await session.prompt("Reply with exactly one word: pong");
    const message = session.agent.state.messages.at(-1);
    const text = (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    console.log(`turn: ${Date.now() - started}ms stop=${message?.stopReason} model=${message?.provider}/${message?.model}`);
    console.log(`text: ${JSON.stringify(text)}`);
    console.log(`usage: ${JSON.stringify({ input: message?.usage?.input, output: message?.usage?.output, reasoning: message?.usage?.reasoning, cost: message?.usage?.cost?.total })}`);
    if (message?.stopReason !== "stop" || !/pong/i.test(text)) fail(`unexpected reply: ${message?.errorMessage ?? text}`);
  }
  session.dispose();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else console.log("ok gemini-4-argon answered through the Keychain Vertex lane");
