import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { mcpFeature } from "../mcp/feature.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolSearchFeature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const fakeServerPath = resolve(featureDir, "../mcp/fake-server.mjs");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-tool-search-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({
  sourceRoot: runtimeRoot,
  outputRoot: stagedRoot,
  features: [toolExecutionFeature, toolSearchFeature, mcpFeature],
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

test("actual staged Pi discovers inactive MCP tools, invokes one in the same turn, rehydrates, aborts, and closes", async (t) => {
  const cwd = join(scratchRoot, "project");
  const agentDir = join(scratchRoot, "agent");
  const markerPath = join(scratchRoot, "mcp.log");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);

  const runtime = resolvePiRuntime({ root: stagedRoot });
  const sdk = await import(pathToFileURL(runtime.sdkEntry));
  const searchRuntime = await import(pathToFileURL(join(stagedRoot, "rubato-features/tool-search/index.mjs")));
  const mcpRuntime = await import(pathToFileURL(join(stagedRoot, "rubato-features/mcp/index.mjs")));
  const searchService = new searchRuntime.ToolSearchService();
  const server = {
    name: "fake server",
    type: "stdio",
    lifecycle: "eager",
    exposure: "search",
    command: process.execPath,
    args: [fakeServerPath],
    env: { RUBATO_MCP_TEST_MARKER: markerPath },
    requestTimeoutMs: 2_000,
    stderr: "pipe",
  };
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
      { name: "rubato-mcp", factory: mcpRuntime.createMcpExtension({ servers: [server], toolSearchService: searchService }) },
    ],
  });
  await loader.reload();
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });

  const echoName = "mcp__fake_server_echo";
  assert.equal(errors.length, 0);
  assert.ok(session.getActiveToolNames().includes("tool_search"));
  assert.ok(!session.getActiveToolNames().includes(echoName));
  assert.equal(session.getAllTools().find(({ name }) => name === echoName)?.allowLazyActivation, true);
  assert.equal(searchService.getCatalog().filter(({ name }) => name === echoName).length, 1);

  const search = await session.executeTool("tool_search", { query: "echo value", source: "mcp" });
  assert.deepEqual(search.details.activated, [echoName]);
  assert.match(search.content[0].text, /\[tool_search:activated:v2\]/);
  assert.ok(session.getActiveToolNames().includes(echoName));

  // This is intentionally the next host call in the same turn: it uses the
  // general executor and cannot bypass validation or extension middleware.
  const echo = await session.executeTool(echoName, { value: "same-turn" });
  assert.equal(echo.content[0].text, "echo:same-turn");

  const controller = new AbortController();
  const slow = session.executeTool("mcp__fake_server_slow", {}, {
    activateInactiveTool: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("search MCP cancelled")), 30);
  const aborted = await slow;
  assert.equal(aborted.details.isError, true);
  assert.match(aborted.content[0].text, /search MCP cancelled/);
  await waitForMarker(markerPath, "cancelled:slow");

  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: search.content[0].text }],
    timestamp: Date.now(),
  });
  session.setActiveToolsByName(["tool_search"]);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes(echoName), "ownership-valid history restores the MCP tool");
  assert.equal((await markerLines(markerPath)).filter((line) => line === "initialized").length, 2);

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  await waitForMarker(markerPath, "exit", 2);
  assert.equal(errors.length, 0);
});
