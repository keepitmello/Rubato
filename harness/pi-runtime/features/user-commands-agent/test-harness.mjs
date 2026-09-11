import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { createUserCommandsAgentFactories } from "./index.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
export const runtimeRoot = resolve(featureDir, "../..");
export const runtime = resolvePiRuntime({ root: runtimeRoot });
export const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);

export function withoutNodeOptions(env, extra = {}) {
  const clean = { ...env, ...extra };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_COMPILE_CACHE;
  return clean;
}

export function makeModel(id = "alpha") {
  return {
    provider: "fixture",
    id,
    name: "Fixture " + id,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: "openai-completions",
    provider: "fixture",
    model: "alpha",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

export function complete(text) {
  const message = typeof text === "string" || Array.isArray(text) ? assistantMessage(text, Array.isArray(text) ? "toolUse" : "stop") : text;
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  if (typeof text === "string") stream.push({ type: "text_delta", delta: text });
  stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  return stream;
}

export function isolateHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = join(root, "cwd");
  const homeDir = join(root, "home");
  const agentDir = join(homeDir, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, cwd, homeDir, agentDir };
}

export function applyIsolatedEnv(homeDir, agentDir) {
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
  };
  process.env.HOME = homeDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  return () => {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
    if (previous.PI_OFFLINE === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous.PI_OFFLINE;
  };
}

export async function createCommandSession(options = {}) {
  const dirs = isolateHome("rubato-user-commands-");
  const restoreEnv = applyIsolatedEnv(dirs.homeDir, dirs.agentDir);
  writeFileSync(join(dirs.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [
          { id: "alpha", name: "Fixture alpha", input: ["text"], contextWindow: 100000, maxTokens: 4096 },
          { id: "beta", name: "Fixture beta", input: ["text"], contextWindow: 100000, maxTokens: 4096 },
        ],
      },
    },
  }));
  if (options.disabled?.length) {
    writeFileSync(join(dirs.agentDir, "rubato-features.json"), JSON.stringify({ disabled: options.disabled }));
  }
  const settingsManager = sdk.SettingsManager.create(dirs.cwd, dirs.agentDir, { projectTrusted: true });
  const captures = options.captures ?? [];
  const streamSimple = options.streamSimple ?? ((model, context) => {
    captures.push({ model: model.provider + "/" + model.id, context });
    const last = context.messages?.at?.(-1);
    const text = typeof last?.content === "string" ? last.content : "fixture reply";
    return complete(options.btwReply ?? (String(text).includes("side") ? "side-answer" : "ok"));
  });
  const factoryOptions = {
    agentDir: dirs.agentDir,
    env: { HOME: dirs.homeDir, PI_CODING_AGENT_DIR: dirs.agentDir, PI_OFFLINE: "1", ...options.env },
    todoNag: options.todoNag,
    todoNagText: options.todoNagText,
    timerPort: options.timerPort,
    now: options.now,
    fetch: options.fetch,
  };
  let factories = createUserCommandsAgentFactories(factoryOptions);
  if (options.only) factories = factories.filter((entry) => options.only.includes(entry.name));
  factories = applyFeatureToggles(factories, readDisabledFeatures({ agentDir: dirs.agentDir, env: factoryOptions.env })).extensionFactories;
  if (options.persisted) mkdirSync(join(dirs.agentDir, "sessions"), { recursive: true });
  const sessionManager = options.persisted
    ? sdk.SessionManager.create(dirs.cwd, join(dirs.agentDir, "sessions"))
    : sdk.SessionManager.inMemory(dirs.cwd);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "fixture-providers", factory: (pi) => {
        pi.registerProvider("fixture", {
          name: "Fixture",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "offline-fixture-key",
          streamSimple,
          models: [makeModel("alpha"), makeModel("beta")].map(({ provider: _p, baseUrl: _b, ...config }) => config),
        });
      } },
      ...factories,
      ...(options.extraFactories ?? []),
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    model: makeModel(options.modelId ?? "alpha"),
    settingsManager,
    resourceLoader,
    sessionManager,
    noTools: options.noTools ?? (options.tools ? undefined : "all"),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  const notices = [];
  const errors = [];
  const switches = [];
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
      setWidget() {},
    },
    commandContextActions: {
      async switchSession(sessionPath) {
        const opened = sdk.SessionManager.open(sessionPath);
        switches.push({ path: sessionPath, id: opened.getSessionId(), cwd: opened.getCwd() });
        return { cancelled: false };
      },
      async newSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async navigateTree() { return { cancelled: false }; },
      async reload() { await result.session.reload(); },
    },
    onError(error) { errors.push(error); },
  });
  return { ...result, ...dirs, settingsManager, notices, errors, captures, switches, restoreEnv, factories };
}

export function commandNames(session) {
  return session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName ?? command.name);
}

export async function waitIdle(session, ms = 4000) {
  const start = Date.now();
  while (session.isStreaming || session.pendingMessageCount > 0) {
    if (Date.now() - start > ms) throw new Error("session did not go idle");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
