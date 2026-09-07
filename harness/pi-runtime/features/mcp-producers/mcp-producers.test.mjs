import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mcpFeature } from "../mcp/feature.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { toolSearchFeature } from "../tool-search/feature.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { mcpProducersFeature } from "./feature.mjs";
import { McpProducerError, createMcpProducerRegistry } from "./index.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const repositoryRoot = resolve(featureDir, "../../../..");
const fakeServerPath = resolve(featureDir, "../mcp/fake-server.mjs");
const astGrepSource = resolve(repositoryRoot, "packages/rubato-runtime/src/components/ast-grep/index.ts");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-mcp-producers-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({
  sourceRoot: runtimeRoot,
  outputRoot: stagedRoot,
  features: [toolExecutionFeature, toolSearchFeature, mcpFeature, mcpProducersFeature],
});

async function markerLines(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForMarker(path, marker, count = 1) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await markerLines(path)).filter((line) => line === marker).length >= count) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`Timed out waiting for marker '${marker}' x${count}`);
}

test("registry rejects invalid and missing producer declarations instead of silently omitting them", async () => {
  const registry = createMcpProducerRegistry({ registrationCwd: scratchRoot });
  assert.throws(
    () => registry.registerMcpServer("missing", {
      command: process.execPath,
      args: [join(scratchRoot, "not-staged", "server.mjs")],
      enabled: true,
    }),
    (error) => error instanceof McpProducerError && error.code === "MCP_SERVER_ENTRY_MISSING",
  );
  assert.throws(
    () => registry.registerMcpServer("invalid", { command: process.execPath, surprise: true }),
    (error) => error instanceof McpProducerError && error.code === "MCP_SERVER_INVALID" && /surprise/.test(error.message),
  );

  const disabled = registry.registerMcpServer("disabled", { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lifecycle, "lazy");
  assert.equal(disabled.exposure, "auto");
});

test("wrapped producer ownership is reload-safe and cross-owner duplicates remain visible", async () => {
  const registry = createMcpProducerRegistry({ registrationCwd: scratchRoot });
  const factory = registry.wrapFactory(
    (pi) => pi.registerMcpServer("owned", { command: process.execPath, args: [fakeServerPath] }),
    { ownerId: "rubato" },
  );
  await factory({});
  await factory({});
  assert.equal(registry.list().length, 1);
  assert.throws(
    () => registry.registerMcpServer(
      "owned",
      { command: process.execPath, args: [fakeServerPath] },
      { ownerId: "other" },
    ),
    (error) => error instanceof McpProducerError && error.code === "MCP_SERVER_DUPLICATE",
  );
});

test("actual ast-grep producer and search producer reach staged Pi execution, abort, reload, and shutdown", async (t) => {
  const cwd = join(scratchRoot, "project");
  const agentDir = join(scratchRoot, "agent");
  const astMarker = join(scratchRoot, "ast-grep.log");
  const memoryMarker = join(scratchRoot, "memory.log");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  const runtime = resolvePiRuntime({ root: stagedRoot });
  const sdk = await import(pathToFileURL(runtime.sdkEntry));
  const producerRuntime = await import(pathToFileURL(join(stagedRoot, "rubato-features/mcp-producers/index.mjs")));
  const searchRuntime = await import(pathToFileURL(join(stagedRoot, "rubato-features/tool-search/index.mjs")));
  const mcpRuntime = await import(pathToFileURL(join(stagedRoot, "rubato-features/mcp/index.mjs")));
  const { createAstGrepComponent } = await import(pathToFileURL(astGrepSource));
  const registry = producerRuntime.createMcpProducerRegistry({ registrationCwd: cwd });
  const searchService = new searchRuntime.ToolSearchService();
  const loggerErrors = [];
  const context = {
    logger: {
      info() {},
      warn() {},
      error(message, details) { loggerErrors.push({ message, details }); },
    },
    config: { getFlag: () => undefined },
  };
  const astGrep = createAstGrepComponent({
    env: { RUBATO_AST_GREP_PROJECT_CWD: astMarker },
    nodeExecutable: process.execPath,
    resolveCwd: () => cwd,
    resolveEntry: () => fakeServerPath,
  });

  const astFactory = registry.wrapFactory(
    (pi) => astGrep.register(pi, context),
    { ownerId: "rubato-ast-grep", sourcePath: astGrepSource, registrationCwd: cwd },
  );
  // This is the exact declaration shape emitted by registerMemoryToolSurface
  // when memory.tool_exposure is "search". The production memory bundle path
  // is supplied by root's Rubato build; the fake entry isolates this client test.
  const memoryFactory = registry.wrapFactory(
    (pi) => pi.registerMcpServer("rubato-memory", {
      command: process.execPath,
      args: [fakeServerPath],
      env: { RUBATO_MCP_TEST_MARKER: memoryMarker },
      exposure: "search",
      enabled: true,
      idleTimeoutMin: 0,
    }),
    { ownerId: "rubato-memory", registrationCwd: cwd },
  );
  const disabledFactory = registry.wrapFactory(
    (pi) => pi.registerMcpServer("disabled", { enabled: false }),
    { ownerId: "rubato-disabled" },
  );

  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "rubato-tool-search", factory: searchRuntime.createToolSearchExtension(searchService) },
      { name: "rubato-ast-producer", factory: astFactory },
      { name: "rubato-memory-producer", factory: memoryFactory },
      { name: "rubato-disabled-producer", factory: disabledFactory },
      { name: "rubato-mcp", factory: mcpRuntime.createMcpExtension({ servers: registry, toolSearchService: searchService }) },
    ],
  });
  await loader.reload();
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  const { session, extensionsResult } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager });
  t.after(() => session.dispose());
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });

  assert.deepEqual(extensionsResult.errors, []);
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(loggerErrors, []);
  assert.deepEqual(
    registry.list().map(({ name, enabled, lifecycle, exposure }) => ({ name, enabled, lifecycle, exposure })),
    [
      { name: "_ast_grep", enabled: true, lifecycle: "eager", exposure: "auto" },
      { name: "disabled", enabled: false, lifecycle: "lazy", exposure: "auto" },
      { name: "rubato-memory", enabled: true, lifecycle: "lazy", exposure: "search" },
    ],
  );

  const astEcho = "mcp__ast_grep_echo";
  const memoryEcho = "mcp__rubato-memory_echo";
  const memorySlow = "mcp__rubato-memory_slow";
  assert.ok(session.getActiveToolNames().includes(astEcho), "small auto-exposed ast-grep catalog stays direct");
  assert.ok(session.getActiveToolNames().includes("tool_search"));
  assert.ok(!session.getActiveToolNames().includes(memoryEcho));
  assert.equal(searchService.getCatalog().filter(({ group }) => group === "rubato-memory").length, 4);
  assert.equal(searchService.getCatalog().some(({ group }) => group === "_ast_grep"), false);
  await waitForMarker(memoryMarker, "exit");

  const direct = await session.executeTool(astEcho, { value: "direct" });
  assert.equal(direct.content[0].text, "echo:direct");
  const search = await session.executeTool("tool_search", {
    query: "echo a string value",
    source: "mcp",
    group: "rubato-memory",
  });
  assert.ok(search.details.activated.includes(memoryEcho));
  const searched = await session.executeTool(memoryEcho, { value: "searched" });
  assert.equal(searched.content[0].text, "echo:searched");

  const controller = new AbortController();
  const slow = session.executeTool(memorySlow, {}, { activateInactiveTool: true, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("producer MCP cancelled")), 30);
  const aborted = await slow;
  assert.equal(aborted.details.isError, true);
  assert.match(aborted.content[0].text, /producer MCP cancelled/);
  await waitForMarker(memoryMarker, "cancelled:slow");
  await waitForMarker(memoryMarker, "exit", 2);

  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: search.content[0].text }],
    timestamp: Date.now(),
  });
  session.setActiveToolsByName(["tool_search", astEcho]);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes(memoryEcho));
  assert.equal(registry.list().length, 3, "producer declarations replace their prior loader generation");

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  await waitForMarker(astMarker, "exit", 2);
  await waitForMarker(memoryMarker, "exit", 3);
  assert.deepEqual(extensionErrors, []);
});
