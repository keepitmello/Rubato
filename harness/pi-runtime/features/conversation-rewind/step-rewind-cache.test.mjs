// A step rewind must keep the prompt cache: the request after the rewind starts with the
// exact bytes the model already saw. Drives a real Pi session with a faux model and
// compares what reaches the provider. Pi sends the system prompt and the tool list as the
// leading system message, so comparing messages compares those too.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { findStepTarget, REWIND_MARK } from "./rewind.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolvePiRuntime({ root: resolve(featureDir, "../..") }).codingAgentDir;
const scratch = mkdtempSync(join(tmpdir(), "rubato-step-rewind-cache-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("rewinding to a tool step keeps every byte the model saw, whether it continues or takes a message", async () => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
  const { AssistantMessageEventStream } = await import(
    pathToFileURL(join(packageDir, "../../@earendil-works/pi-ai/dist/utils/event-stream.js")).href
  ).catch(() => import(pathToFileURL(join(packageDir, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href));
  const cwd = join(scratch, "cwd");
  const agentDir = join(scratch, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "cache-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } },
  }));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let clock = 1_000_000;
  const reply = (content, stopReason) => ({ role: "assistant", content, api: "openai-completions", provider: "cache-test", model: "fake", usage, stopReason, timestamp: clock++ });
  // The model's turns, in order: two tool steps (the second calls two tools together), then an answer.
  const script = [];
  const requests = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify({ messages: context.messages })));
    const message = script.shift() ?? reply([{ type: "text", text: "done" }], "stop");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  const call = (id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } });
  script.push(
    reply([{ type: "text", text: "first" }, call("a")], "toolUse"),
    reply([{ type: "text", text: "second" }, call("b"), call("c")], "toolUse"),
    reply([{ type: "text", text: "all done" }], "stop"),
  );
  await session.prompt("fix it");
  assert.equal(requests.length, 3);
  // The request the model got right after step "b, c" answered.
  const afterStep = requests[2];
  assert.deepEqual(afterStep.messages.slice(-2).map((message) => message.role), ["toolResult", "toolResult"]);
  assert.equal(afterStep.messages[0].role, "system");
  assert.ok(afterStep.messages[0].sections && afterStep.messages[0].toolsAdded.length > 0);

  const rewind = async (callId) => {
    const manager = session.sessionManager;
    const target = findStepTarget(manager.getBranch(), callId);
    const from = manager.getLeafId();
    const result = await session.navigateTree(target, { summarize: false });
    assert.equal(result.cancelled, false);
    assert.equal(manager.getLeafId(), target);
    manager.appendCustomEntry(REWIND_MARK, { from });
  };

  // Continue: the same request again, byte for byte.
  await rewind("c");
  await session._runAgentPrompt([]);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3], afterStep);

  // Instruct: the same request with the new message after it.
  await rewind("b");
  await session.prompt("instead, keep the tests");
  const instructed = requests[4];
  assert.deepEqual(instructed.messages.slice(0, afterStep.messages.length), afterStep.messages);
  const added = instructed.messages.slice(afterStep.messages.length);
  assert.equal(added.at(-1).role, "user");
  assert.match(JSON.stringify(added.at(-1).content), /instead, keep the tests/);
  // The rewind mark never reaches the model.
  assert.equal(JSON.stringify(requests).includes(REWIND_MARK), false);
});
