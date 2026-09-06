import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import { CORE_TOOL_NAMES, withToolExposure } from "../../src/tool-surface-policy.mjs";
import { injectToolSurface, injectUniversalApplyPatch } from "../../src/transforms/core-tool-surface.mjs";
import { syncNotesToolActivation } from "../../src/context-notes/tools.mjs";

const engine = (path) => pathToFileURL(join(senpiDir, "dist", path)).href;
const { AgentSession } = await import(engine("core/agent-session.js"));
const { ToolSearchService } = await import(engine("core/extensions/builtin/tool-search/service.js"));
const { createToolSearchTool } = await import(engine("core/extensions/builtin/tool-search/tool.js"));
const { emitActivationMarker } = await import(engine("core/extensions/builtin/tool-search/engine/marker.js"));
const { registerApplyPatchExtension, getApplyPatchWireMode } = await import(engine("core/extensions/builtin/gpt-apply-patch/extension.js"));
const { registerMcpTierBTools } = await import(engine("core/extensions/builtin/mcp/expose/tier-b.js"));
const { default: videoInExtension } = await import(engine("core/extensions/builtin/video-in/index.js"));

function definition(name, extra = {}) {
  return { name, label: name, description: `${name} capability`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: name }] }), ...extra };
}

function fixture() {
  const session = Object.create(AgentSession.prototype);
  const events = [];
  const registered = ["apply_patch", "todo", "tool_search", "Agent", "team_create", "eval", "monitor", "lsp_symbols"]
    .map((name) => ({ definition: definition(name), sourceInfo: { source: "builtin", path: `/builtin/${name}.js` } }));
  session.agent = { state: { tools: [], systemPrompt: "" }, removedToolHints: {} };
  session._toolRegistry = new Map();
  session._baseToolDefinitions = new Map(["read", "bash", "edit", "write", "find"].map((name) => [name, withToolExposure(definition(name))]));
  session._customTools = [];
  session._toolDefinitions = new Map();
  session._evalOnlyToolNames = session._resolveEvalOnlyToolNames();
  session._publishedEvalOnlyHintNames = new Set();
  session._withheldEvalOnlyToolNames = new Set();
  session._isBuiltinExtensionPath = () => true;
  session._rebuildSystemPrompt = () => "test prompt";
  session._extensionBindingPromptReadiness = {};
  session._toolExecutionDepth = 0;
  session._agentEventQueue = Promise.resolve();
  session.settingsManager = { getImageAutoResize: () => false };
  session._extensionRunner = {
    getAllRegisteredTools: () => registered,
    getActiveTools: () => session.getActiveToolNames(),
    createContext: () => ({}),
    hasHandlers: () => true,
    emitToolCall: async (event) => { events.push(event.type); },
    emitToolResult: async (event) => { events.push(event.type); },
  };
  session._refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
  const runtime = { getAllTools: () => session.getAllTools(), getActiveTools: () => session.getActiveToolNames(),
    setActiveTools: (names) => session.setActiveToolsByName(names) };
  const service = new ToolSearchService(runtime);
  session._lazyToolActivators = [(name) => service.activateTool(name)];
  return { session, service, registered, events };
}

test("installed registry starts with five core tools; search activates a directly executable tool", async () => {
  const { session, service, events } = fixture();
  assert.deepEqual(session.getActiveToolNames().sort(), [...CORE_TOOL_NAMES].sort());
  const search = createToolSearchTool(service);
  await search.execute("search", { query: "lsp_symbols" });
  assert.ok(session.getActiveToolNames().includes("lsp_symbols"));
  assert.equal((await session.executeTool("lsp_symbols", {})).content[0].text, "lsp_symbols");
  assert.deepEqual(events, ["tool_call", "tool_result"]);
  session._extensionRunner.emitToolCall = async () => ({ block: true, reason: "test permission denial" });
  await assert.rejects(session.executeTool("lsp_symbols", {}), /test permission denial/);
  assert.ok(service.getCatalog().some((tool) => tool.name === "Agent"));
  assert.ok(service.getCatalog().some((tool) => tool.name === "find"));
});

test("refresh preserves discovered tools without reactivating all extensions or legacy editors", () => {
  const { session, service } = fixture();
  service.activateTool("Agent");
  session._refreshToolRegistry({ activeToolNames: session.getActiveToolNames(), includeAllExtensionTools: true });
  assert.deepEqual(session.getActiveToolNames().sort(), [...CORE_TOOL_NAMES, "Agent"].sort());
  session.setActiveToolsByName([...session.getActiveToolNames(), "edit", "write"]);
  assert.ok(!session.getActiveToolNames().includes("edit"));
  assert.ok(!session.getActiveToolNames().includes("write"));
  assert.ok(session.getRegisteredTool("edit"), "native exec bridge retains its backend");
  assert.ok(!service.getCatalog().some((tool) => ["edit", "write"].includes(tool.name)));
  session._baseToolsOverride = { edit: definition("edit") };
  session.setActiveToolsByName(["read", "edit"]);
  assert.deepEqual(session.getActiveToolNames(), ["read", "edit"], "explicit SDK overrides retain their own tool contract");
});

test("exposure preserves execution/schema and removes only the contradictory patch guideline", () => {
  const original = definition("custom_code_tool");
  const deferred = withToolExposure(original);
  assert.equal(deferred.exposure, "search");
  assert.equal(deferred.execute, original.execute);
  assert.equal(deferred.parameters, original.parameters);
  assert.equal(original.exposure, undefined);
  const denied = definition("private_tool", { exposure: "search", allowLazyActivation: false });
  assert.equal(withToolExposure(denied), denied);
  const patch = definition("apply_patch", { promptGuidelines: [
    "Keep permission checks.",
    "After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
  ] });
  assert.deepEqual(withToolExposure(patch).promptGuidelines, ["Keep permission checks."]);
});

test("history can rehydrate discovered tools; explicit lazy denial stays authoritative", () => {
  const { session, service, registered } = fixture();
  registered.push({ definition: definition("denied", { exposure: "search", allowLazyActivation: false }),
    sourceInfo: { source: "builtin", path: "/builtin/denied.js" } });
  session._refreshToolRegistry();
  assert.equal(service.activateTool("denied"), false);
  const doc = service.getCatalog().find((tool) => tool.name === "Agent");
  assert.ok(doc);
  service.maybeRehydrateFromHistory([{ role: "toolResult", toolName: "tool_search", content: [{
    type: "text", text: emitActivationMarker([{ name: doc.name, registrationId: doc.registrationId }]),
  }] }]);
  assert.ok(session.getActiveToolNames().includes("Agent"));
});

test("notes are searchable only in notes mode, with no eager activation", () => {
  let active = ["read"];
  const tools = [definition("notes_read_file", { exposure: "search", allowLazyActivation: false })];
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool), getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  syncNotesToolActivation(pi, true, tools);
  assert.deepEqual(active, ["read"]);
  assert.equal(registered.at(-1).allowLazyActivation, true);
  active.push("notes_read_file");
  syncNotesToolActivation(pi, false, tools);
  assert.deepEqual(active, ["read"]);
  assert.equal(registered.at(-1).allowLazyActivation, false);
});

test("video admission enables discovery, not eager exposure; losing capability withdraws it", async () => {
  const handlers = new Map();
  let definition;
  let active = ["read"];
  const pi = { registerTool: (tool) => { definition = tool; }, on: (name, fn) => handlers.set(name, fn),
    getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  videoInExtension(pi);
  assert.equal(definition.allowLazyActivation, false);
  await handlers.get("session_start")({}, { model: { input: ["text", "image", "video"] } });
  assert.equal(definition.allowLazyActivation, true);
  assert.deepEqual(active, ["read"]);
  active.push("read_video");
  await handlers.get("model_select")({ model: { input: ["text"] } });
  assert.equal(definition.allowLazyActivation, false);
  assert.deepEqual(active, ["read"]);
});

test("MCP direct and stub modes become searchable, preserve promotions and remove withdrawn tools", () => {
  const entries = ["search", "rewrite"].map((tool) => ({
    server: "ast", tool, description: `AST ${tool}`, schema: { type: "object", properties: {} },
  }));
  for (const searchMode of [false, true]) {
    const definitions = new Map();
    let active = [...CORE_TOOL_NAMES];
    const pi = {
      registerTool: (tool) => definitions.set(tool.name, withToolExposure(tool)),
      getAllTools: () => [...definitions.values()].map((tool) => ({
        ...tool, allowLazyActivation: tool.allowLazyActivation !== false,
        sourceInfo: { source: "builtin", path: "<builtin:mcp>" },
      })),
      getActiveTools: () => active,
      setActiveTools: (names) => { active = names; },
    };
    const service = new ToolSearchService(pi);
    const input = { registeredEntries: entries, activeEntries: entries, searchMode, settings: { stubSwap: true },
      utilityTools: [definition("mcp_list_resources")] };
    registerMcpTierBTools(pi, input, service);
    assert.deepEqual(active.sort(), [...CORE_TOOL_NAMES].sort());
    const doc = service.getCatalog().find((entry) => entry.source === "mcp" && entry.label === "search");
    assert.ok(doc);
    assert.equal(service.getCatalog().filter((entry) => entry.name === doc.name).length, 1, "one catalog owner");
    assert.equal(service.activateTool("mcp_list_resources"), true);
    assert.equal(service.activateTool(doc.name), true);
    assert.ok(active.includes(doc.name));
    assert.equal(definitions.get(doc.name).description, "AST search", "full tool, not a placeholder stub");
    registerMcpTierBTools(pi, input, service);
    assert.ok(active.includes(doc.name), "catalog refresh preserves explicit discovery");
    registerMcpTierBTools(pi, { ...input, registeredEntries: [], activeEntries: [], utilityTools: [] }, service);
    assert.ok(!active.includes(doc.name));
    assert.equal(service.activateTool(doc.name), false, "withdrawn registration cannot be rediscovered");
    assert.equal(service.activateTool("mcp_list_resources"), false);
  }
});

test("apply_patch uses one editor across model families and executes JSON patches", async (t) => {
  assert.equal(getApplyPatchWireMode({ id: "gpt-test", api: "openai-codex-responses" }), "freeform");
  for (const api of ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses", "cursor-agent"]) {
    assert.equal(getApplyPatchWireMode({ id: "non-gpt", api }), "json");
  }
  const root = await mkdtemp(join(tmpdir(), "rubato-one-editor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const tools = new Map();
  let active = [...CORE_TOOL_NAMES];
  const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerLazyToolActivator() {},
    on: (event, handler) => handlers.set(event, handler), getActiveTools: () => active,
    setActiveTools: (names) => { active = names; }, getAllTools: () => [...tools.values()] };
  registerApplyPatchExtension(pi);
  const ctx = { cwd: root, model: { id: "claude-test", api: "anthropic-messages" } };
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual(active, [...CORE_TOOL_NAMES]);
  const patch = "*** Begin Patch\n*** Add File: sample.txt\n+before\n*** End Patch\n";
  await tools.get("apply_patch").execute("add", { input: patch }, undefined, undefined, ctx);
  assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "before\n");
  await tools.get("apply_patch").execute("edit", { input: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch\n" }, undefined, undefined, ctx);
  assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "after\n");
  await handlers.get("model_select")({ model: { id: "gpt-test", api: "openai-codex-responses" } });
  assert.ok(active.includes("apply_patch"));
  await handlers.get("model_select")({ model: ctx.model });
  assert.ok(!active.includes("edit") && !active.includes("write"));
  await handlers.get("model_select")({ model: { id: "grok-4.6", provider: "xai", api: "openai-responses" } });
  assert.equal(tools.get("apply_patch").freeform, undefined, "xAI Responses rejects custom/freeform tool types");
  assert.deepEqual(await handlers.get("tool_result")({ toolName: "apply_patch", details: { result: { failures: [{}] } } }), { isError: true });
});

test("surface transforms apply once and reject drift", () => {
  const source = readFileSync(join(senpiDir, "dist/core/agent-session.js"), "utf8");
  const transformed = injectToolSurface(source);
  assert.match(transformed, /: \["read", "bash"\];/);
  assert.throws(() => injectToolSurface(transformed), /drift/);
  const patch = readFileSync(join(senpiDir, "dist/core/extensions/builtin/gpt-apply-patch/extension.js"), "utf8");
  assert.throws(() => injectUniversalApplyPatch(injectUniversalApplyPatch(patch)), /drift/);
});
