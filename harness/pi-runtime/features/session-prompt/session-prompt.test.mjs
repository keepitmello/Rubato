import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { sessionPromptFeature } from "./patches.mjs";

const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-session-prompt-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const staged = await stagePiRuntime({
  sourceRoot: join(import.meta.dirname, "../.."),
  outputRoot: join(scratchRoot, "runtime"),
  features: [sessionPromptFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
const { AssistantMessageEventStream } = await import(
  pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js")).href
);

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(content, stopReason = "stop") {
  return {
    role: "assistant", content, api: "openai-completions", provider: "sp-test", model: "fake-model",
    usage: emptyUsage, stopReason, timestamp: Date.now(),
  };
}
function streamOf(message) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}
const textOf = (message) => typeof message.content === "string"
  ? message.content
  : (message.content ?? []).map((part) => part.text ?? "").join("");

// 0.86 handed held custom messages to the running loop as prepared messages, because the
// loop built requests from its own copy of the context. 0.87 made the SessionManager
// projection canonical for every request, and the migration deleted that sub-patch. This
// pins what it protected: a context-only notice sent while a tool runs reaches the next
// request of the same run, once, right after that tool's result, and stays there.
test("a custom message held during a tool reaches the next request of the same run right after the tool result", async () => {
  const cwd = join(scratchRoot, "cwd");
  const agentDir = join(scratchRoot, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "sp-test": {
        baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused",
        models: [{ id: "fake-model", input: ["text"] }],
      },
    },
  }));
  const extension = (pi) => {
    pi.registerTool({
      name: "probe",
      label: "probe",
      description: "test probe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        pi.sendMessage({ customType: "held-notice", content: "HELD-NOTICE", display: false }, { triggerTurn: false });
        return { content: [{ type: "text", text: "probe-result" }], details: {} };
      },
    });
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "held", factory: extension }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  session.setActiveToolsByName([...session.getActiveToolNames(), "probe"]);

  const requests = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(context.messages.map((message) => ({ role: message.role, text: textOf(message) })));
    if (requests.length === 1) {
      return streamOf(assistant([{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], "toolUse"));
    }
    return streamOf(assistant([{ type: "text", text: `done-${requests.length}` }]));
  };

  await session.prompt("first");
  assert.equal(requests.length, 2, "the tool call is followed by one more request in the same run");
  const second = requests[1].filter((message) => message.role !== "system");
  const resultIndex = second.findIndex((message) => message.role === "toolResult");
  const noticeIndexes = second.flatMap((message, index) => message.text.includes("HELD-NOTICE") ? [index] : []);
  assert.ok(resultIndex >= 0, "the second request carries the tool result");
  assert.deepEqual(noticeIndexes, [resultIndex + 1], "the notice comes once, right after the tool result");

  await session.prompt("next");
  const third = requests[2].filter((message) => message.role !== "system");
  assert.deepEqual(third.slice(0, second.length + 1).slice(0, second.length), second,
    "the next run replays the same history in the same order (cache prefix unchanged)");
  assert.equal(third.filter((message) => message.text.includes("HELD-NOTICE")).length, 1);
});

// A context handler that changes the conversation must not move a mid-session tool
// declaration into the leading system message (stock 0.87+ collapses every system message
// into one head). Rubato's handlers rewrite messages on most requests, and a collapsed head
// changes the provider's top-level tools from token 0, a full prompt-cache miss.
for (const [label, rewrite] of [
  ["a same-length rewrite", (messages) => messages.map((message) => message.role === "user" ? { ...message } : message)],
  ["an insert plus a drop", (messages) => [
    { role: "user", content: [{ type: "text", text: "INSERTED" }], timestamp: 1 },
    ...messages.slice(1),
  ]],
  // history-notes: every message is re-created with an item-id marker and a reminder is
  // inserted, so neither identity nor position matches (checker repro, 2026-10-03).
  ["copies with markers plus an inserted reminder", (messages) => {
    const marked = messages.map((message) => ({
      ...message,
      content: [...(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content), { type: "text", text: "[history: item_id=x]" }],
    }));
    return [{ role: "user", content: [{ type: "text", text: "BOOTSTRAP" }], timestamp: 0 }, ...marked,
      { role: "user", content: [{ type: "text", text: "<context_notes_nudge>notes</context_notes_nudge>" }], timestamp: Date.now() }];
  }],
]) {
  test(`a mid-session tool declaration stays in place after ${label} by a context handler`, async () => {
    const cwd = join(scratchRoot, `slots-${label.replaceAll(" ", "-")}`);
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "sp-test": {
          baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused",
          models: [{ id: "fake-model", input: ["text"] }],
        },
      },
    }));
    let rewriting = false;
    const extension = (pi) => {
      pi.registerTool({
        name: "late_tool", label: "late", description: "loaded mid-session", defaultActive: false,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
      });
      pi.on("context", (event) => rewriting ? { messages: rewrite(event.messages) } : undefined);
    };
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      extensionFactories: [{ name: "slots", factory: extension }],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await sdk.createAgentSession({
      cwd, agentDir, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd),
    });
    const requests = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(context.messages);
      return streamOf(assistant([{ type: "text", text: `done-${requests.length}` }]));
    };
    await session.prompt("one");
    assert.ok(!session.getActiveToolNames().includes("late_tool"));
    session.setActiveToolsByName([...session.getActiveToolNames(), "late_tool"]);
    rewriting = true;
    await session.prompt("two");

    const sent = requests.at(-1);
    const toolNames = (message) => (message.toolsAdded ?? []).map((tool) => tool.name);
    assert.equal(sent[0].role, "system");
    assert.ok(!toolNames(sent[0]).includes("late_tool"), "the leading tool list keeps only the first declaration");
    const lateIndex = sent.findIndex((message, index) => index > 0 && message.role === "system" && toolNames(message).includes("late_tool"));
    assert.ok(lateIndex > 0, "the mid-session declaration is still a later system message");
    assert.match(textOf(sent[lateIndex + 1]), /^two/, "it stays right before the message it preceded");
  });
}
