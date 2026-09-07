import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2], exposure = process.argv[3] ?? "direct";
const sdk = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
const { createRubatoExtensionFactories } = await import(pathToFileURL(join(root, "rubato-features/rubato-components/bootstrap.mjs")));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = sdk.SettingsManager.inMemory();
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const assembled = createRubatoExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime,
  codemodeOptions: { complete: async () => { throw new Error("Provider calls are forbidden in component fixture"); } },
  providerOptions: { env: { PI_OFFLINE: "1", RUBATO_SPEED_INDEX: "0", RUBATO_NO_KIRO_ENSURE: "1" },
    kiro: { ensureKiro: async () => { throw new Error("Kiro daemon launch is forbidden in component fixture"); } } },
});
let api;
const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [...assembled.extensionFactories, { name: "fixture-api", factory: (pi) => { api = pi; } }],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, [], "every required component must register");
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
  sessionManager: sdk.SessionManager.inMemory(cwd),
});
const errors = [];
try {
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [], "all component session_start handlers must bind");
  const tools = api.getAllTools().map(({ name }) => name);
  for (const name of ["Agent", "AgentCancel", "AgentOutput", "lsp_diagnostics", "lsp_symbols", "team_create", "bash_input", "bash_output", "bash_resize", "kill_bash", "monitor"]) {
    assert.ok(tools.includes(name), `existing Rubato tool missing: ${name}`);
  }
  assert.equal(assembled.servers.list().some(({ name }) => name === "_ast_grep"), true);
  let memoryTool = "memory";
  if (exposure === "search") {
    assert.equal(tools.includes("memory"), false, "search configuration removes the direct memory surface");
    assert.equal(tools.includes("memory_apply_patch"), false);
    assert.equal(assembled.servers.list().some(({ name, exposure: value }) => name === "rubato-memory" && value === "search"), true);
    memoryTool = "mcp__rubato-memory_memory";
    assert.equal(api.getActiveTools().includes(memoryTool), false);
    const search = await api.executeTool("tool_search", { query: "memory create edit blocks", source: "mcp", group: "rubato-memory" });
    assert.ok(search.details.activated.includes(memoryTool), JSON.stringify(search));
  } else {
    assert.equal(api.getActiveTools().includes("memory"), true, "memory stays direct by default");
    assert.equal(tools.includes("memory_apply_patch"), true);
  }
  const memory = await api.executeTool(memoryTool, { command: "create", file_path: "facts/fixture.md",
    description: "Component integration evidence", file_text: "stock Pi memory write", reason: "local integration fixture",
  });
  assert.notEqual(memory.isError, true, JSON.stringify(memory));
  const memoryStatus = await session.extensionRunner.requestRpc("rubato.memory.status");
  assert.equal(memoryStatus.schemaVersion, 1);
  assert.ok(memoryStatus.repo.headSha, "actual memory commit is visible to the existing RPC consumer");
  const writeNotices = session.sessionManager.getEntries().filter((entry) => entry.customType === "rubato-memory:write-updated");
  assert.equal(writeNotices.length, exposure === "search" ? 1 : 0, "MCP receipt feeds exactly one write notice; direct rendering does not duplicate it");
  const tier = await session.extensionRunner.requestRpc("rubato.service-tier.status");
  assert.equal(tier.active, false);
  assert.equal(session.sessionManager.getEntries().some((entry) => entry.customType === "senpi-memory.session-binding"), true);
  const declaration = assembled.servers.list().find(({ name }) => name === "_ast_grep");
  assert.match(declaration.args[0], /rubato-features\/rubato-components\/runtime\/ast-grep-mcp\/cli\.js$/);
  process.stdout.write(`RUBATO_COMPONENT_RESULT ${JSON.stringify({ tools: tools.length, exposure, memorySha: memoryStatus.repo.headSha,
    declaredServers: assembled.servers.list().map(({ name }) => name), requestTimeline: typeof session.requestTimelineSnapshot === "function" })}\n`);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
}
