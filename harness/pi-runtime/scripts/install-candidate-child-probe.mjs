import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1];
}

function parseJsonLine(buffer) {
  return buffer.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
}

async function rpcGetState(execPath, rpcEntry, env, sessionDir, packageDir) {
  const child = spawn(execPath, [rpcEntry, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], {
    env: {
      ...env,
      PI_CODING_AGENT_SESSION_DIR: `${sessionDir}/`,
      PI_PACKAGE_DIR: packageDir,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const response = await new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => reject(new Error(`child RPC timeout: ${stderr || stdout}`)), 20_000);
      const check = () => {
        const line = parseJsonLine(stdout);
        if (!line) return;
        clearTimeout(timer);
        try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); }
      };
      child.stdout.on("data", check);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdin.write('{"type":"get_state","id":"isolated-child"}\n');
      check();
    });
    return {
      pid: child.pid,
      execPath,
      rpcEntry,
      id: response.id,
      success: response.success,
      sessionFile: response.data?.sessionFile,
      command: response.command,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

async function inProcessProbe({ root, home, env }) {
  const runtimeUrl = pathToFileURL(join(root, "rubato-features/child-runtime/stock-rpc-runtime.mjs")).href;
  const sdkUrl = pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
  const [{ loadStockChildInProcessFactories, createStockChildInProcessSession, createStockRpcSpawnRuntime, resolveStockRpcEntry }, sdk] = await Promise.all([
    import(runtimeUrl),
    import(sdkUrl),
  ]);
  const cwd = join(home, "in-process-cwd");
  const agentDir = join(home, "in-process-agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const factories = await loadStockChildInProcessFactories({ root, agentDir });
  const modelRuntime = await sdk.ModelRuntime.create({
    agentDir,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = {
    id: "local/mock",
    name: "Local Mock",
    api: "openai-completions",
    provider: "local",
    baseUrl: "http://127.0.0.1:9",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const sessionManager = sdk.SessionManager.create(cwd, join(agentDir, "sessions"));
  const session = await createStockChildInProcessSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    sessionManager,
    settingsManager: sdk.SettingsManager.inMemory(),
  }, {
    createAgentSession: sdk.createAgentSession,
    DefaultResourceLoader: sdk.DefaultResourceLoader,
    extensionFactories: factories,
  });
  const probePath = join(cwd, "cwd-probe.txt");
  await writeFile(probePath, "in-process-child");
  const spawnRuntime = createStockRpcSpawnRuntime({
    rpcEntry: resolveStockRpcEntry({ root }),
    execPath: process.execPath,
    parentEnv: env,
  });
  const factoryNames = factories.map((entry) => entry.name);
  const extensions = session.getExtensions?.() ?? session.resourceLoader?.getExtensions?.();
  session.dispose?.();
  return {
    cwd,
    probePath,
    factoryNames,
    extensionCount: Array.isArray(extensions) ? extensions.length : extensions?.extensions?.length ?? factoryNames.length,
    rpcEntry: spawnRuntime.resolveRpcEntry(),
    senpiExecutable: spawnRuntime.resolveSenpiExecutable(spawnRuntime),
  };
}

const root = arg("--root");
const home = arg("--home");
const report = arg("--report");
if (!root || !home || !report || !isAbsolute(root) || !isAbsolute(home) || !isAbsolute(report)) {
  throw new Error("Usage: node install-candidate-child-probe.mjs --root /install --home /empty --report /file.json");
}

const env = { ...process.env };
const rpcEntryUrl = (await import(pathToFileURL(join(resolve(root), "rubato-features/child-runtime/stock-rpc-runtime.mjs")).href));
const rpcEntry = rpcEntryUrl.resolveStockRpcEntry({ root: resolve(root) });
const sessionDir = join(home, "rpc-sessions", "child");
await mkdir(sessionDir, { recursive: true });
const packageDir = join(resolve(root), "node_modules/@earendil-works/pi-coding-agent");
process.env.PI_PACKAGE_DIR = packageDir;
const rpc = await rpcGetState(process.execPath, rpcEntry, env, sessionDir, packageDir);
const inProcess = await inProcessProbe({ root: resolve(root), home, env: { ...env, PI_PACKAGE_DIR: packageDir } });
const receipt = {
  ok: rpc.success === true && inProcess.senpiExecutable === null,
  rpc,
  inProcess,
};
await writeFile(report, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
