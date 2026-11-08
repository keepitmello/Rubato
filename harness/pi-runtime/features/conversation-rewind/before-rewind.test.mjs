// A rewind to just before one of the person's messages (the companion room) must leave the model
// exactly the conversation before that message: the request for the edit is the earlier exchange
// and the edit, nothing of what was dropped. Drives a real Pi session with a faux model, with a
// prompt typed in the app and a messenger message delivered into the session.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { findBeforeTarget, REWIND_MARK } from "./rewind.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolvePiRuntime({ root: resolve(featureDir, "../..") }).codingAgentDir;
const scratch = mkdtempSync(join(tmpdir(), "rubato-before-rewind-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("rewinding before a message drops it and everything after, whether typed or delivered", async () => {
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
    providers: { "rewind-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } },
  }));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let clock = 1_000_000;
  const requests = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify({ messages: context.messages })));
    const message = { role: "assistant", content: [{ type: "text", text: `answer ${requests.length}` }], api: "openai-completions",
      provider: "rewind-test", model: "fake", usage, stopReason: "stop", timestamp: clock++ };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  const manager = session.sessionManager;
  const rewindBefore = async (entryId) => {
    const from = manager.getLeafId();
    const result = await session.navigateTree(findBeforeTarget(manager.getBranch(), entryId), { summarize: false });
    assert.equal(result.cancelled, false);
    assert.equal(manager.getBranch().some((entry) => entry.id === entryId), false);
    manager.appendCustomEntry(REWIND_MARK, { from });
  };
  const said = (request) => JSON.stringify(request.messages.slice(1));

  await session.prompt("first");
  await session.prompt("second");
  const typed = manager.getBranch().find((entry) => entry.type === "message" && JSON.stringify(entry.message.content).includes("second")).id;
  await session.sendCustomMessage({ customType: "rubato-session-message", content: "from the messenger", display: true,
    details: { kind: "channel" } }, { triggerTurn: true });
  await new Promise((done) => setTimeout(done, 50));
  const delivered = manager.getBranch().find((entry) => entry.type === "custom_message").id;
  assert.equal(requests.length, 3);

  // A delivered message: the next request is everything before it and the edit.
  await rewindBefore(delivered);
  await session.prompt("edited instead");
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].messages.slice(0, requests[2].messages.length - 1), requests[2].messages.slice(0, -1));
  assert.doesNotMatch(said(requests[3]), /from the messenger/);
  assert.match(JSON.stringify(requests[3].messages.at(-1).content), /edited instead/);

  // A typed prompt: the same, with the earlier rewind's branch left behind too.
  await rewindBefore(typed);
  await session.prompt("second, edited");
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].messages.slice(0, requests[1].messages.length - 1), requests[1].messages.slice(0, -1));
  assert.doesNotMatch(said(requests[4]), /"second"|from the messenger|edited instead/);
  assert.match(JSON.stringify(requests[4].messages.at(-1).content), /second, edited/);
  // The rewind mark never reaches the model.
  assert.equal(JSON.stringify(requests).includes(REWIND_MARK), false);
});
