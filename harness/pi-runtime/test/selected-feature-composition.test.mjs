import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadPiFeatures, PI_FEATURE_NAMES } from "../feature-catalog.mjs";
import { stagePiRuntime } from "../stage-runtime.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

test("all selected hooks compose in one isolated stock SDK and standard binary", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-selected-composition-"));
  let session;
  t.after(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    await rm(scratch, { recursive: true, force: true });
  });
  const features = await loadPiFeatures(PI_FEATURE_NAMES);
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features });
  assert.equal(staged.receipt.fullRubatoParity, false);
  assert.deepEqual(new Set(staged.receipt.features), new Set(PI_FEATURE_NAMES));
  assert.equal(existsSync(join(staged.root, "node_modules/@code-yeongyu/senpi")), false);
  const sdk = await import(pathToFileURL(staged.runtime.sdkEntry));
  const cwd = join(scratch, "project");
  const agentDir = join(scratch, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await mkdir(join(cwd, ".senpi"));
  await writeFile(join(cwd, ".senpi/codemode.json"), JSON.stringify({
    languages: { py: false, js: true, rb: false, jl: false },
    cellTimeoutSeconds: 10, foregroundWindowSeconds: 10, hardLimitSeconds: 15,
  }));
  const env = { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_COMPILE_CACHE;
  const cli = await run(process.execPath, [staged.runtime.patchableCliEntry, "--version"], { cwd, env, timeout: 10_000 });
  assert.equal(cli.stdout.trim(), "0.85.1");
  const bin = join(staged.root, staged.receipt.binEntry);
  const binResult = process.platform === "win32"
    ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${bin}.cmd" --version"`], { cwd, env, timeout: 10_000, windowsVerbatimArguments: true })
    : await run(bin, ["--version"], { cwd, env, timeout: 10_000 });
  assert.equal(binResult.stdout.trim(), "0.85.1");
  let api;
  const hooks = [];
  const inputs = [];
  const dispositions = [];
  let veto = true;
  const settingsManager = sdk.SettingsManager.inMemory();
  settingsManager.setModelServiceTier("openai-codex", "fixture", "priority");
  assert.equal(settingsManager.getModelServiceTier("openai-codex", "fixture"), "priority");
  const { createServiceTierFeature } = await import(pathToFileURL(join(staged.root, "rubato-features/service-tier/extension.mjs")));
  const serviceTier = createServiceTierFeature({ agentDir, settingsManagerFactory: () => settingsManager });
  const { createMcpExtension } = await import(pathToFileURL(join(staged.root, "rubato-features/mcp/index.mjs")));
  const { createToolSearchExtension, ToolSearchService } = await import(pathToFileURL(join(staged.root, "rubato-features/tool-search/index.mjs")));
  const toolSearch = new ToolSearchService();
  const codemode = await import(pathToFileURL(join(staged.root, "rubato-features/codemode/src/index.ts")));
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "service-tier", factory: serviceTier.extension },
      { name: "codemode", factory: (pi) => codemode.default(pi, { complete: async () => { throw new Error("Provider completion is outside this local test"); } }) },
      { name: "tool-search", factory: createToolSearchExtension(toolSearch) },
      { name: "mcp", factory: createMcpExtension({ toolSearchService: toolSearch, servers: [{ name: "selected", type: "stdio", exposure: "search", command: process.execPath,
        args: [join(sourceRoot, "features/mcp/fake-server.mjs")], requestTimeoutMs: 2_000,
      }] }) },
      { name: "composition-contract", factory: (pi) => {
      api = pi;
      pi.registerTool({ name: "composition_echo", label: "Echo", description: "Local composition fixture",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} }),
      });
      pi.on("tool_call", (event) => { hooks.push(["call", event.toolName]); });
      pi.on("tool_result", (event) => { hooks.push(["result", event.toolName]); });
      pi.on("input", (event) => { inputs.push(event.inputId); return { action: "handled" }; });
      pi.on("input_disposition", (event) => { dispositions.push(event); });
      pi.on("session_before_reload", () => veto ? { cancel: true, reason: "selected-features test" } : undefined);
    } }],
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd) }));
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const before = await api.executeTool("composition_echo", { value: "before reload" });
  assert.equal(before.content[0].text, "before reload");
  assert.deepEqual(await session.reload(), { cancelled: true, reason: "selected-features test" });
  veto = false;
  assert.deepEqual(await session.reload(), { cancelled: false });
  const after = await api.executeTool("composition_echo", { value: "after reload" });
  assert.equal(after.content[0].text, "after reload");
  assert.deepEqual(hooks, [["call", "composition_echo"], ["result", "composition_echo"], ["call", "composition_echo"], ["result", "composition_echo"]]);
  assert.equal(api.getActiveTools().includes("mcp__selected_echo"), false);
  const catalogNames = toolSearch.getCatalog().map(({ name }) => name);
  assert.equal(new Set(catalogNames).size, catalogNames.length, "one owning catalog entry per tool");
  const found = await api.executeTool("tool_search", { query: "echo", source: "mcp" });
  assert.ok(found.details.activated.includes("mcp__selected_echo"));
  const mcpResult = await api.executeTool("mcp__selected_echo", { value: "all selected features" }, { activateInactiveTool: true });
  assert.equal(mcpResult.content[0].text, "echo:all selected features");
  assert.deepEqual(hooks.slice(-2), [["call", "mcp__selected_echo"], ["result", "mcp__selected_echo"]]);
  // Force the nested eval call to exercise owner-controlled lazy activation,
  // rather than simply calling the tool activated by tool_search above.
  session.setActiveToolsByName(api.getActiveTools().filter((name) => name !== "mcp__selected_echo"));
  const evaluated = await api.executeTool("eval", {
    language: "js", code: 'await tool.mcp__selected_echo({value: "eval to MCP"})', summary: "All feature tool bridge",
  });
  assert.match(evaluated.content.filter(({ type }) => type === "text").map(({ text }) => text).join("\n"), /echo:eval to MCP/);
  assert.deepEqual(hooks.slice(-4), [["call", "eval"], ["call", "mcp__selected_echo"], ["result", "mcp__selected_echo"], ["result", "eval"]]);
  await session.prompt("same input");
  await session.prompt("same input");
  assert.equal(new Set(inputs).size, 2);
  assert.deepEqual(dispositions, inputs.map((inputId) => ({ type: "input_disposition", inputId, disposition: "handled" })));
  assert.equal(typeof serviceTier.getState().active, "boolean");
  assert.deepEqual(errors, []);
});
