import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { providersFeature } from "../providers/patches.mjs";
import { providerExecutionFeature } from "../provider-execution/patches.mjs";
import { toolExecutionFeature } from "../tool-execution/patches.mjs";
import { feature as contextNotesFeature } from "../context-notes/patches.mjs";
import { feature as contextWindowFeature } from "../context-window/patches.mjs";
import { toolGuardsFeature } from "../tool-guards/feature.mjs";
import { childRuntimeFeature } from "../child-runtime/feature.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-child-mode-"));
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
const contextConfig = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/config.mjs",
)).href);
const notesExtension = join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
);

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

async function openInProcessChild(t, { name, model }) {
  const cwd = join(scratch, name + "-cwd");
  const agentDir = join(scratch, name + "-agent");
  const sessionDir = join(scratch, name + "-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory();
  const extensionFactories = await childRuntime.loadStockChildInProcessFactories({
    root: staged.root,
    agentDir,
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
  return session;
}

function withoutNodeOptions(env) {
  const copy = { ...env };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

async function runRpcChild({ name, model, mode, origin }) {
  const cwd = join(scratch, "rpc-" + name + "-cwd");
  const agentDir = join(scratch, "rpc-" + name + "-agent");
  const sessionDir = join(scratch, "rpc-" + name + "-sessions");
  const homeDir = join(scratch, "rpc-" + name + "-home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [model.provider]: {
        baseUrl: model.provider === "anthropic" ? "https://api.anthropic.com" : "http://127.0.0.1:9/v1",
        api: model.provider === "anthropic" ? "anthropic-messages" : "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: model.id, input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
      },
    },
  }));
  const probe = join(scratch, "rpc-" + name + "-probe.mjs");
  const probeOut = join(scratch, "rpc-" + name + "-mode.json");
  writeFileSync(probe, [
    "import { writeFileSync } from \"node:fs\";",
    "export default (pi) => {",
    "  pi.on(\"session_start\", (_event, ctx) => {",
    "    writeFileSync(" + JSON.stringify(probeOut) + ", JSON.stringify({",
    "      mode: process.env.RUBATO_CONTEXT_MODE ?? null,",
    "      origin: process.env.RUBATO_CONTEXT_MODE_ORIGIN ?? null,",
    "      modelProvider: ctx?.model?.provider ?? null,",
    "      modelId: ctx?.model?.id ?? null,",
    "    }));",
    "  });",
    "};",
    "",
  ].join("\n"));
  const env = withoutNodeOptions({
    ...process.env,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
    RUBATO_CONTEXT_MODE: mode,
  });
  if (origin === undefined) delete env.RUBATO_CONTEXT_MODE_ORIGIN;
  else env.RUBATO_CONTEXT_MODE_ORIGIN = origin;
  const child = spawn(process.execPath, [
    runtime.patchableRpcEntry,
    "--offline",
    "--approve",
    "--provider", model.provider,
    "--model", model.id,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir", sessionDir,
    "--extension", notesExtension,
    "--extension", probe,
  ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    frames.push(JSON.parse(line));
    for (const notify of waiters) notify();
  });
  const waitFor = (predicate, label) => new Promise((resolvePromise, reject) => {
    const finish = () => {
      const found = frames.find(predicate);
      if (found) {
        clearTimeout(timer);
        waiters.delete(finish);
        resolvePromise(found);
      }
    };
    const timer = setTimeout(() => {
      waiters.delete(finish);
      reject(new Error(label + ": " + (stderr || "no stderr")));
    }, 20_000);
    waiters.add(finish);
    finish();
  });
  try {
    child.stdin.write(JSON.stringify({ id: "ready", type: "get_state" }) + "\n");
    await waitFor((frame) => frame.type === "response" && frame.id === "ready", "rpc get_state");
    const deadline = Date.now() + 8_000;
    while (!existsSync(probeOut) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(existsSync(probeOut), true, "rpc session_start did not write resolved mode: " + stderr);
    const resolved = JSON.parse(readFileSync(probeOut, "utf8"));
    const files = readdirSync(sessionDir).filter((entry) => entry.endsWith(".jsonl"));
    const transcript = files.map((entry) => readFileSync(join(sessionDir, entry), "utf8")).join("\n");
    return { resolved, transcript, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))]);
      }
    }
  }
}

test("in-process child re-resolves inherited ORIGIN=session: Fable summary, Astra notes", async (t) => {
  withFreshMode(t, { mode: "history-notes", origin: "session" });
  await openInProcessChild(t, { name: "inproc-fable", model: FABLE });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "summary");
  assert.equal(process.env.RUBATO_CONTEXT_MODE_ORIGIN, "session");

  withFreshMode(t, { mode: "summary", origin: "session" });
  await openInProcessChild(t, { name: "inproc-astra", model: ASTRA });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "history-notes");
  assert.equal(process.env.RUBATO_CONTEXT_MODE_ORIGIN, "session");
});

test("in-process child keeps user-explicit env without origin marker", async (t) => {
  withFreshMode(t, { mode: "history-notes" });
  await openInProcessChild(t, { name: "inproc-explicit-notes", model: FABLE });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "history-notes");
  assert.equal(process.env.RUBATO_CONTEXT_MODE_ORIGIN, undefined);

  withFreshMode(t, { mode: "summary" });
  await openInProcessChild(t, { name: "inproc-explicit-summary", model: ASTRA });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, "summary");
  assert.equal(process.env.RUBATO_CONTEXT_MODE_ORIGIN, undefined);
});

test("RPC child re-resolves inherited ORIGIN=session through the default notes factory", async () => {
  const fable = await runRpcChild({
    name: "fable",
    model: FABLE,
    mode: "history-notes",
    origin: "session",
  });
  assert.equal(fable.resolved.mode, "summary");
  assert.equal(fable.resolved.origin, "session");
  assert.equal(fable.resolved.modelProvider, FABLE.provider);
  assert.equal(fable.resolved.modelId, FABLE.id);

  const astra = await runRpcChild({
    name: "astra",
    model: ASTRA,
    mode: "summary",
    origin: "session",
  });
  assert.equal(astra.resolved.mode, "history-notes");
  assert.equal(astra.resolved.origin, "session");
  assert.equal(astra.resolved.modelProvider, ASTRA.provider);
  assert.equal(astra.resolved.modelId, ASTRA.id);

  const explicit = await runRpcChild({
    name: "explicit",
    model: ASTRA,
    mode: "summary",
  });
  assert.equal(explicit.resolved.mode, "summary");
  assert.equal(explicit.resolved.origin, null);
});
