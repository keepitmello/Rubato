import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { buildMcpToolNames } from "./compat.mjs";
import {
  computeMcpExposurePolicy,
  createMcpExtension,
  createMcpService,
  isMcpSessionExpiredError,
  isRetriableMcpError,
  McpServiceError,
} from "./index.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const fakeServerPath = join(featureDir, "fake-server.mjs");

async function fixture(t, name = "fake server") {
  const root = await mkdtemp(join(tmpdir(), "rubato-mcp-test-"));
  const markerPath = join(root, "marker.log");
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    markerPath,
    server: {
      name,
      type: "stdio",
      lifecycle: "eager",
      command: process.execPath,
      args: [fakeServerPath],
      env: { RUBATO_MCP_TEST_MARKER: markerPath },
      requestTimeoutMs: 2_000,
      stderr: "pipe",
    },
  };
}

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

test("Rubato MCP names keep the current Claude-compatible prefix and deterministic collision suffixes", () => {
  assert.deepEqual(
    buildMcpToolNames([
      { serverName: "_ast_grep", toolName: "search" },
      { serverName: "same-name", toolName: "call" },
      { serverName: "same_name", toolName: "call" },
    ]),
    ["mcp__ast_grep_search", "mcp__same-name_call_5f5b", "mcp__same_name_call_f23a"],
  );
});

test("real stdio initialize/list/call/progress/error/abort/shutdown contract", async (t) => {
  const input = await fixture(t);
  const warnings = [];
  const service = createMcpService({ servers: [input.server], onWarning: (warning) => warnings.push(warning) });
  t.after(() => service.close().catch(() => undefined));

  const tools = await service.start();
  assert.equal(service.state, "started");
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["mcp__fake_server_echo", "mcp__fake_server_error", "mcp__fake_server_rich", "mcp__fake_server_slow"],
  );
  assert.deepEqual(tools[0].parameters.properties.value, { type: "string" });
  assert.equal("$schema" in tools[0].parameters, false);
  assert.equal("additionalProperties" in tools[0].parameters, false);
  assert.deepEqual(warnings, []);

  const updates = [];
  const echoed = await service.callTool("mcp__fake_server_echo", { value: "hello" }, {
    onUpdate: (update) => updates.push(update),
  });
  assert.deepEqual(echoed.content, [
    { type: "text", text: "echo:hello" },
    { type: "text", text: '{"echoed":"hello"}' },
  ]);
  assert.match(updates[0].content[0].text, /fake server\/echo progress 1\/1 working/);

  const rich = await service.callTool("mcp__fake_server_rich");
  assert.deepEqual(rich.content, [
    { type: "text", text: '{"type":"audio","data":"AA==","mimeType":"audio/wav"}' },
    { type: "text", text: '{"type":"resource_link","uri":"file:///fixture.txt","name":"fixture"}' },
  ]);
  await assert.rejects(
    service.callTool("mcp__fake_server_error"),
    (error) => error instanceof McpServiceError && error.code === "MCP_TOOL_RESULT_ERROR" && /fixture failure/.test(error.message),
  );

  const controller = new AbortController();
  const slowCall = service.callTool("mcp__fake_server_slow", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(slowCall, (error) => error?.name === "AbortError");
  await waitForMarker(input.markerPath, "cancelled:slow");

  await service.close();
  assert.equal(service.state, "closed");
  await waitForMarker(input.markerPath, "exit");
  assert.deepEqual((await markerLines(input.markerPath)).slice(0, 3), ["initialized", "list:first", "list:page-2"]);
});

test("startup errors are contextual and already-started stdio processes are rolled back", async (t) => {
  const input = await fixture(t, "healthy");
  const service = createMcpService({
    servers: [
      input.server,
      { name: "broken", type: "stdio", command: join(input.root, "does-not-exist"), requestTimeoutMs: 200 },
    ],
  });

  await assert.rejects(
    service.start(),
    (error) => error instanceof McpServiceError && error.code === "MCP_SERVER_START_FAILED" && /broken/.test(error.message),
  );
  assert.equal(service.state, "failed");
  await waitForMarker(input.markerPath, "exit");
  await service.close();
  assert.equal(service.state, "closed");
});

test("session-expiry retry renews the mutable connection once", async (t) => {
  const input = await fixture(t, "retry server");
  const retryStatePath = join(input.root, "retry.state");
  input.server.env.RUBATO_MCP_TEST_RETRY_STATE = retryStatePath;
  const service = createMcpService({ servers: [input.server] });
  t.after(() => service.close().catch(() => undefined));

  const tools = await service.start();
  const retry = tools.find(({ mcpToolName }) => mcpToolName === "retry");
  assert.ok(retry);
  const result = await service.callTool(retry.name);
  assert.equal(result.content[0].text, "retry:ok");
  await waitForMarker(input.markerPath, "initialized", 2);
  assert.equal((await markerLines(input.markerPath)).filter((line) => line === "call:retry").length, 2);

  await service.close();
  await waitForMarker(input.markerPath, "exit", 2);
});

test("oversized output spills mode-0600 artifacts and shutdown removes only service-owned files", async (t) => {
  const input = await fixture(t, "large server");
  input.server.env.RUBATO_MCP_TEST_LARGE = "1";
  const agentDir = join(input.root, "agent");
  const service = createMcpService({
    servers: [input.server],
    agentDir,
    outputGuard: { maxBytes: 128, maxLines: 5 },
  });
  t.after(() => service.close().catch(() => undefined));

  const tools = await service.start();
  const large = tools.find(({ mcpToolName }) => mcpToolName === "large");
  assert.ok(large);
  const result = await service.callTool(large.name);
  assert.match(result.content[0].text, /MCP tool output exceeded outputGuard/);
  const artifact = result.content[0].text.match(/Full output saved to: (.+)/)?.[1];
  assert.ok(artifact);
  assert.match(await readFile(artifact, "utf8"), /large-line-99/);
  assert.equal((await stat(artifact)).mode & 0o777, 0o600);

  await service.close();
  await assert.rejects(access(artifact), (error) => error?.code === "ENOENT");
});

test("exposure policy and retry classification preserve Senpi direct/search signals", () => {
  const tools = [{ name: "read" }, { name: "write" }, { name: "admin_delete" }];
  const policy = computeMcpExposurePolicy(tools, {
    name: "policy",
    exposure: "search",
    includeTools: ["*"],
    excludeTools: ["admin_*"],
    directTools: ["read"],
  });
  assert.equal(policy.mode, "search");
  assert.deepEqual(policy.registeredTools.map(({ name }) => name), ["read", "write"]);
  assert.deepEqual([...policy.activeToolNames], ["read"]);
  const nested = { cause: { response: { status: 404 } } };
  assert.equal(isMcpSessionExpiredError(nested), true);
  assert.equal(isRetriableMcpError({ cause: new Error("transport closed") }), true);
});

test("stock AgentSession registers, activates, calls, shuts down, and restarts proxies on one runner", async (t) => {
  const input = await fixture(t);
  const runtime = resolvePiRuntime({ root: runtimeRoot });
  const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(runtime.sdkEntry));
  const agentDir = join(input.root, "agent");
  const cwd = join(input.root, "project");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: "rubato-mcp", factory: createMcpExtension({ servers: [input.server] }) }],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });
  t.after(() => session.dispose());
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });

  assert.deepEqual(extensionsResult.errors, []);
  assert.deepEqual(extensionErrors, []);
  assert.ok(session.getAllTools().some(({ name }) => name === "mcp__fake_server_echo"));
  assert.ok(session.getActiveToolNames().includes("mcp__fake_server_echo"));
  const firstDefinition = session.getToolDefinition("mcp__fake_server_echo");
  assert.ok(firstDefinition);
  const firstResult = await firstDefinition.execute("call-1", { value: "first" }, undefined, undefined, undefined);
  assert.equal(firstResult.content[0].text, "echo:first");

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
  await waitForMarker(input.markerPath, "exit");
  const firstCycleMarkers = await markerLines(input.markerPath);
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  const secondDefinition = session.getToolDefinition("mcp__fake_server_echo");
  assert.ok(secondDefinition);
  assert.notEqual(secondDefinition, firstDefinition);
  const secondResult = await secondDefinition.execute("call-2", { value: "second" }, undefined, undefined, undefined);
  assert.equal(secondResult.content[0].text, "echo:second");
  assert.equal((await markerLines(input.markerPath)).filter((line) => line === "initialized").length, 2);
  assert.ok((await markerLines(input.markerPath)).length > firstCycleMarkers.length);

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  assert.equal((await markerLines(input.markerPath)).filter((line) => line === "exit").length, 2);
});
