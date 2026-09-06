import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import { installToolOutputPreviews } from "../../src/extensions/tool-output.mjs";

const { AgentSession } = await import(pathToFileURL(join(senpiDir, "dist/core/agent-session.js")));
const { ExtensionRunner } = await import(pathToFileURL(join(senpiDir, "dist/core/extensions/runner.js")));
const text = `start\n${"output line\n".repeat(4000)}end\n`;

function sessionFixture() {
  const session = Object.create(AgentSession.prototype);
  const events = [];
  const names = ["read", "bash", "powershell", "monitor", "workflow", "eval"];
  const tools = names.map((name) => ({
    name, label: name, description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text }], details: { exitCode: 0 } }),
  }));
  session.agent = { state: { tools: [], systemPrompt: "" }, removedToolHints: {} };
  session._toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));
  session._toolDefinitions = new Map(tools.map((tool) => [tool.name, { definition: tool }]));
  session._evalOnlyToolNames = session._resolveEvalOnlyToolNames();
  session._publishedEvalOnlyHintNames = new Set();
  session._withheldEvalOnlyToolNames = new Set();
  session._rebuildSystemPrompt = () => "test prompt";
  session._extensionBindingPromptReadiness = {};
  session._toolExecutionDepth = 0;
  session._agentEventQueue = Promise.resolve();
  session.settingsManager = { getImageAutoResize: () => false };
  session._extensionRunner = {
    hasHandlers: () => true,
    emitToolCall: async (event) => { events.push(event.type); },
    emitToolResult: async (event) => { events.push(event.type); },
  };
  session.setActiveToolsByName(names);
  return { session, names, events };
}

test("installed transformed AgentSession advertises direct tools and eval together", () => {
  const { session, names } = sessionFixture();
  assert.deepEqual(session.getActiveToolNames(), names);
  assert.deepEqual(session.agent.removedToolHints, {});
  session._evalOnlyToolNamesOverride = new Set(["bash"]);
  session._evalOnlyToolNames = session._resolveEvalOnlyToolNames();
  session.setActiveToolsByName(names);
  assert.deepEqual(session.getActiveToolNames(), names.filter((name) => name !== "bash"));
  assert.match(session.agent.removedToolHints.bash, /eval/);
});

test("real executeTool bridge retains raw data and existing tool-call/result hooks", async () => {
  const { session, events } = sessionFixture();
  const output = await session.executeTool("bash", {});
  assert.equal(output.content[0].text, text);
  assert.deepEqual(events, ["tool_call", "tool_result"]);
});

test("real executeTool still enforces a blocking tool-call hook", async () => {
  const { session } = sessionFixture();
  let executed = false;
  session._toolRegistry.get("bash").execute = async () => { executed = true; };
  session._extensionRunner.emitToolCall = async () => ({ block: true, reason: "denied by test" });
  await assert.rejects(session.executeTool("bash", {}), /denied by test/);
  assert.equal(executed, false);
});

test("installed ExtensionRunner projects context only and preserves recoverable raw output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rubato-context-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "session.jsonl");
  const handlers = new Map();
  installToolOutputPreviews({ on: (name, fn) => handlers.set(name, [fn]) });
  const runner = Object.create(ExtensionRunner.prototype);
  runner.extensions = [{ path: "test-output-extension", handlers }];
  runner.createContext = () => ({ sessionManager: { getSessionFile: () => sessionFile } });
  runner.emitError = (error) => { throw new Error(error.message); };
  const raw = [{ role: "toolResult", toolName: "bash", toolCallId: "test-call",
    isError: false, content: [{ type: "text", text }], timestamp: 1 }];
  const request = await runner.prepareProviderRequest(raw);
  assert.equal(raw[0].content[0].text, text);
  assert.match(request.messages[0].content[0].text, /Original tool-result text:/);
  assert.ok(Buffer.byteLength(request.messages[0].content[0].text) < 9000);
  const artifacts = join(dir, "session-artifacts", "tool-output");
  const files = await readdir(artifacts);
  assert.equal(await readFile(join(artifacts, files[0]), "utf8"), text);
  assert.deepEqual((await runner.prepareProviderRequest(raw)).messages, request.messages);
});
