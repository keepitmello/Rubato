import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const CANDIDATE = process.env.RUBATO_PI_SDK?.trim() || "/tmp/rubato-pi-candidate-3bd2ec525";
const PI_SDK = join(repoRoot, "packages", "senpi-task", "src", "pi-sdk", "index.ts");
const COMPOSE = join(repoRoot, "packages", "rubato-runtime", "src", "extension", "compose.ts");
const COMPONENTS = join(repoRoot, "packages", "rubato-runtime", "src", "extension", "component-list.ts");
const TASK = join(repoRoot, "packages", "rubato-runtime", "src", "components", "task", "index.ts");
const IN_PROCESS = join(repoRoot, "packages", "senpi-task", "src", "runners", "in-process.ts");
const SPAWN = join(repoRoot, "packages", "senpi-task", "src", "runners", "rpc", "spawn.ts");
const MEMORY_LAUNCH = join(repoRoot, "packages", "rubato-runtime", "src", "components", "memory", "worker", "senpi-command.ts");

function candidateProblem() {
  if (!existsSync(join(CANDIDATE, "package.json"))) return `stock candidate missing: ${CANDIDATE}`;
  const pkg = JSON.parse(readFileSync(join(CANDIDATE, "package.json"), "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== "0.84.2") {
    return `candidate is ${pkg.name}@${pkg.version}`;
  }
  return null;
}

const SKIP = candidateProblem();

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home, RUBATO_PI_SDK: CANDIDATE };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

test("child factories no longer import @code-yeongyu/senpi at runtime", () => {
  const inProcess = readFileSync(IN_PROCESS, "utf8");
  const spawn = readFileSync(SPAWN, "utf8");
  const launch = readFileSync(MEMORY_LAUNCH, "utf8");
  assert.match(inProcess, /loadStockSdk/);
  assert.doesNotMatch(inProcess, /import \{[^\n]*createAgentSession/);
  assert.match(inProcess, /import type \{[^}]*CreateAgentSessionOptions/);
  assert.match(spawn, /stockRpcEntry/);
  assert.doesNotMatch(spawn, /from "@code-yeongyu\/senpi\/rpc-entry"/);
  assert.match(launch, /stockCliEntry/);
  assert.doesNotMatch(launch, /join\("@code-yeongyu", "senpi"\)/);

});

test("codemode host types are Rubato-owned, not Senpi package imports", () => {
  const index = readFileSync(join(repoRoot, "harness", "rubato-pi", "src", "codemode", "index.ts"), "utf8");
  const notifier = readFileSync(join(repoRoot, "harness", "rubato-pi", "src", "codemode", "extension", "eval-notifier.ts"), "utf8");
  assert.match(index, /host-types/);
  assert.doesNotMatch(index, /@code-yeongyu\/senpi/);
  assert.match(notifier, /host-types/);
  assert.doesNotMatch(notifier, /@code-yeongyu\/senpi/);
});

test("product defineTool imports stock host-runtime not Senpi", () => {
  const tool = readFileSync(join(repoRoot, "packages", "senpi-task", "src", "tools", "task", "tool.ts"), "utf8");
  const send = readFileSync(join(repoRoot, "packages", "senpi-task", "src", "tools", "control", "send.ts"), "utf8");
  assert.match(tool, /pi-sdk\/host-runtime/);
  assert.doesNotMatch(tool, /import \{ defineTool.*from "@code-yeongyu\/senpi"/);
  assert.match(send, /pi-sdk\/host-runtime/);
});

test("composeRubatoExtension+createTaskComponent loads on stock ExtensionRunner and AgentSession", {
  skip: SKIP ?? undefined,
  timeout: 60_000,
}, () => {
  const home = mkdtempSync(join(tmpdir(), "pi-rubato-adapter-home-"));
  const script = `
    import { mkdtempSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    import { loadStockSdk, attachRequestRunTracker, resolveStockCodingAgent } from ${JSON.stringify(pathToFileURL(PI_SDK).href)};
    import { composeRubatoExtension } from ${JSON.stringify(pathToFileURL(COMPOSE).href)};
    import { createRubatoComponents } from ${JSON.stringify(pathToFileURL(COMPONENTS).href)};
    import { createTaskComponent } from ${JSON.stringify(pathToFileURL(TASK).href)};
    const env = { RUBATO_PI_SDK: ${JSON.stringify(CANDIDATE)} };
    const sdk = await loadStockSdk(env);
    const root = resolveStockCodingAgent(env);
    const loader = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
    const bus = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
    const cwd = mkdtempSync(join(tmpdir(), "pi-task-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-session-dir-"));
    const warnings = [];
    const logger = {
      info() {},
      warn(message, details) { warnings.push({ message, details }); },
      error(message, details) { warnings.push({ message, details }); },
    };
    const factory = composeRubatoExtension(createRubatoComponents(createTaskComponent({
      resolveCwd: () => cwd,
    })), { logger });
    const runtime = loader.createExtensionRuntime();
    const eventBus = bus.createEventBus();
    const extension = await loader.loadExtensionFromFactory(factory, cwd, eventBus, runtime, "<rubato-inline>");
    const toolNames = [...extension.tools.keys()];
    const flagNames = [...extension.flags.keys()];
    const mismatch = warnings.find((entry) => String(entry.message).includes("ExtensionAPI version mismatch"));
    if (mismatch) {
      process.stderr.write(JSON.stringify(mismatch) + "\\n");
      process.exit(3);
    }
    if (!toolNames.includes("Agent")) {
      process.stderr.write(JSON.stringify({ toolNames, warnings }) + "\\n");
      process.exit(4);
    }
    const emptyLoader = {
      getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources() {},
      async reload() {},
    };
    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      sessionManager: sdk.SessionManager.create(cwd, sessionDir),
      settingsManager: sdk.SettingsManager.inMemory({}),
      noTools: "all",
      resourceLoader: emptyLoader,
    });
    if (created?.session == null) process.exit(5);
    const attached = attachRequestRunTracker(created.session);
    const page = await created.session.readConversationPage({ limit: 10 });
    process.stdout.write(JSON.stringify({
      toolNames,
      flagNames,
      version: sdk.VERSION,
      session: typeof created.session,
      pageEntries: Array.isArray(page?.entries) ? page.entries.length : -1,
      hasReadConversationPage: typeof created.session.readConversationPage === "function",
      tracker: Boolean(attached.tracker),
      warnings: warnings.map((entry) => entry.message),
    }) + "\\n");
  `;
  const result = spawnSync("bun", ["--eval", script], {
    env: isolatedEnv(home),
    encoding: "utf8",
    timeout: 45000,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, "0.84.2");
  assert.ok(report.toolNames.includes("Agent"));
  assert.ok(report.flagNames.includes("rubato-disabled"));
  assert.ok(report.flagNames.includes("rubato-task"));
  assert.equal(report.session, "object");
  assert.equal(report.hasReadConversationPage, true);
  assert.equal(report.tracker, true);
  assert.ok(report.pageEntries >= 0);
});
