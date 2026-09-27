import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2], exposure = process.argv[3] ?? "direct";
const sdk = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
const { createRubatoExtensionFactories, createRubatoChildExtensionFactories, createStockTaskRunnerFactories } = await import(pathToFileURL(join(root, "rubato-features/rubato-components/bootstrap.mjs")));
const childRuntime = await import(pathToFileURL(join(root, "rubato-features/child-runtime/stock-rpc-runtime.mjs")));
// The host parent deliberately has the opposite memory exposure. Session cwd,
// not process cwd, must select both tool configuration and local storage.
const cwd = join(process.cwd(), "session-cwd"), agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(join(cwd, ".rubato"), { recursive: true });
// The layer schema is strict, so a key it does not know (the retired `facts` layer) rejects the
// whole file and the defaults silently win. Keep this in step with RubatoMemorySettingsLayerSchema.
await writeFile(join(cwd, ".rubato/rubato.jsonc"), JSON.stringify({ memory: {
  agent: "stock-integration", tool_exposure: exposure,
} }));
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
  assert.equal(existsSync(join(cwd, ".rubato/task/tasks")), true, "task lifecycle uses the session cwd");
  assert.equal(existsSync(join(process.cwd(), ".rubato/task/tasks")), false, "host cwd must not be swept by another session");
  // MCP attaches in the background at session_start. Use its real pre-turn
  // readiness gate before inspecting/executing tools, without calling a model.
  // 0.86.0 은 emitBeforeAgentStart 를 (prompt, images, systemPromptOptions) 로 바꿨다.
  // 0.85.1 처럼 세 번째에 프롬프트 문자열을 넘기면 그게 옵션으로 해석돼
  // cwd 가 undefined 가 되고 렌더가 터진다.
  await session.extensionRunner.emitBeforeAgentStart("offline component fixture", undefined, { cwd });
  assert.deepEqual(errors, [], "pre-turn component readiness must not fail");
  const tools = api.getAllTools().map(({ name }) => name);
  // AgentOutput is not here on purpose: the task component stopped registering it, so a delegated
  // result arrives as a completion pointer plus a result file path instead of a transcript peek.
  for (const name of ["Agent", "AgentCancel", "lsp_diagnostics", "lsp_symbols", "team_create", "bash_input", "bash_output", "bash_resize", "kill_bash", "monitor"]) {
    assert.ok(tools.includes(name), `existing Rubato tool missing: ${name}`);
  }
  const active = session.getActiveToolNames();
  assert.ok(active.includes("Agent"), "Agent is on from the first request");
  assert.ok(!active.includes("AgentSend") && !active.includes("AgentCancel"), "the rest of the task family waits for tool_search");
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
    // "direct" is the transport (an extension tool, not an MCP server); like other tools it
    // waits in the tool_search catalog until activated.
    assert.equal(api.getActiveTools().includes("memory"), false, "memory registers directly but starts inactive");
    assert.equal(tools.includes("memory_apply_patch"), true);
  }
  const memory = await api.executeTool(memoryTool, { command: "create", file_path: "facts/fixture.md",
    description: "Component integration evidence", file_text: "stock Pi memory write", reason: "local integration fixture",
  }, { activateInactiveTool: true });
  assert.notEqual(memory.isError, true, JSON.stringify(memory));
  const memorySha = /committed(?: locally)? \(([0-9a-f]{7,})\)/.exec(JSON.stringify(memory))?.[1];
  assert.ok(memorySha, `the memory write commits into the named store: ${JSON.stringify(memory)}`);
  const tier = await session.extensionRunner.requestRpc("rubato.service-tier.status");
  assert.equal(tier.active, false);
  assert.equal(session.sessionManager.getEntries().some((entry) => entry.customType === "senpi-memory.session-binding"), true);
  const declaration = assembled.servers.list().find(({ name }) => name === "_ast_grep");
  assert.equal(declaration.env.RUBATO_AST_GREP_PROJECT_CWD, cwd, "AST MCP receives the session project, not the engine cwd");
  assert.match(declaration.args[0], /rubato-features\/rubato-components\/runtime\/ast-grep-mcp\/cli\.js$/);
  // A task child works with the lead's tools. The only differences are the ones stated here:
  // memory is bound to the lead's identity, team management is the lead's, and Agent is a team
  // member's (a plain subagent is at the depth limit).
  const leadOnly = ["memory", "memory_apply_patch", "mcp__rubato-memory_memory", "mcp__rubato-memory_memory_apply_patch", "team_create", "team_replace_member", "team_delete", "team_send",
    "team_shutdown_request", "team_approve_shutdown", "team_reject_shutdown",
    "team_task_create", "team_task_get", "team_task_list", "team_task_update"];
  const agentFamily = ["Agent", "AgentSend", "AgentCancel"];
  let childRunners;
  createStockTaskRunnerFactories({ agentDir, modelRuntime, createTaskRunnerFactories: (options) => { childRunners = options; return {}; } });
  const childTools = async ({ member = false, inProcess = false }) => {
    const childCwd = join(cwd, `child-${member ? "member" : "agent"}-${inProcess ? "in-process" : "rpc"}`);
    await mkdir(childCwd, { recursive: true });
    const childSettings = sdk.SettingsManager.inMemory();
    let child;
    if (inProcess) {
      // The in-process runner hands a child the lead's captured component tools (lsp here; the task
      // family and memory are filtered out before they reach it).
      const sharedParentTools = api.getAllTools().filter(({ name }) => name.startsWith("lsp_"))
        .map((info) => ({ ...info, execute: async () => ({ content: [] }) }));
      child = await childRunners.createInProcessSession({ cwd: childCwd, agentDir, settingsManager: childSettings, modelRuntime,
        sessionManager: sdk.SessionManager.inMemory(childCwd), customTools: sharedParentTools });
    } else {
      // What child-rpc-entry assembles: the child profile modules plus the child extensions.
      const extensionFactories = [
        ...await childRuntime.loadPiChildInProcessFactories({ root, agentDir, settingsManager: childSettings, propagateEnv: false }),
        ...createRubatoChildExtensionFactories({ cwd: childCwd, agentDir, settingsManager: childSettings, member,
          ...(member ? { createTaskOptions: ({ createTaskRunnerFactories }) => ({ resolveCwd: () => childCwd,
            runnerFactories: createStockTaskRunnerFactories({ agentDir, modelRuntime, createTaskRunnerFactories }) }) } : {}) }),
      ];
      child = await childRuntime.createStockChildInProcessSession({ cwd: childCwd, agentDir, settingsManager: childSettings,
        modelRuntime, sessionManager: sdk.SessionManager.inMemory(childCwd) }, { createAgentSession: sdk.createAgentSession,
        DefaultResourceLoader: sdk.DefaultResourceLoader, extensionFactories });
    }
    try {
      await child.extensionRunner.emitBeforeAgentStart("offline child fixture", undefined, { cwd: childCwd });
      return child.getAllTools().map(({ name }) => name);
    } finally {
      await child.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      child.dispose();
    }
  };
  const difference = (left, right) => left.filter((name) => !right.includes(name)).sort();
  for (const shape of [{}, { inProcess: true }, { member: true }]) {
    // A member process is marked by its identity; its team_send and board arrive with the member
    // bundle, which this fixture does not load.
    if (shape.member) process.env.RUBATO_TASK_MEMBER = "11111111-1111-4111-8111-111111111111::alice";
    const names = await childTools(shape).finally(() => { delete process.env.RUBATO_TASK_MEMBER; });
    const expectedMissing = [...leadOnly, ...(shape.member ? [] : agentFamily)].filter((name) => tools.includes(name)).sort();
    assert.deepEqual(difference(tools, names), expectedMissing, `child ${JSON.stringify(shape)} lacks a lead tool`);
    assert.deepEqual(difference(names, tools), [], `child ${JSON.stringify(shape)} has a tool the lead lacks`);
  }
  process.stdout.write(`RUBATO_COMPONENT_RESULT ${JSON.stringify({ tools: tools.length, exposure, memorySha,
    declaredServers: assembled.servers.list().map(({ name }) => name), requestTimeline: typeof session.requestTimelineSnapshot === "function" })}\n`);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
}
