import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { sessionPromptFeature } from "../session-prompt/patches.mjs";
import { toolGuardsFeature } from "./feature.mjs";
import {
  sanitizeAnthropicToolPairs,
  sanitizeOpenAIChatCompletionsPayload,
  sanitizeOpenAIResponsesPayload,
  sanitizeToolPairs,
} from "./tool-pair.mjs";
import { demoteUnavailableToolReferences } from "./demote-unavailable.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-tool-guards-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({ sourceRoot: runtimeRoot, outputRoot: stagedRoot, features: [toolGuardsFeature] });
// The held-message delivery the loop guard relies on is an engine patch of session-prompt.
const stagedWithPromptRoot = join(scratchRoot, "runtime-session-prompt");
await stagePiRuntime({
  sourceRoot: runtimeRoot,
  outputRoot: stagedWithPromptRoot,
  features: [toolGuardsFeature, sessionPromptFeature],
});

async function createFixture(t) {
  const runtime = resolvePiRuntime({ root: stagedRoot });
  const sdk = await import(`${pathToFileURL(runtime.sdkEntry).href}?tool-guards=${Date.now()}-${Math.random()}`);
  const guards = await import(`${pathToFileURL(join(stagedRoot, "rubato-features/tool-guards/index.mjs")).href}?fixture=${Math.random()}`);
  const cwd = join(scratchRoot, `cwd-${Math.random()}`);
  const agentDir = join(scratchRoot, `agent-${Math.random()}`);
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  let downstreamCalls = 0;
  let providerPayload;
  const downstream = (pi) => {
    pi.on("tool_call", () => { downstreamCalls += 1; });
    pi.on("before_provider_request", (event) => { providerPayload = event.payload; });
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...guards.createToolGuardExtensionFactories(),
      { name: "tool-guards-downstream", factory: downstream },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  return {
    cwd,
    guards,
    session,
    get downstreamCalls() { return downstreamCalls; },
    get providerPayload() { return providerPayload; },
  };
}

test("tool-pair sanitizers preserve balanced payload identity and repair all three provider shapes", () => {
  const balanced = { messages: [{ role: "user", content: "hello" }] };
  assert.equal(sanitizeAnthropicToolPairs(balanced), balanced);
  assert.equal(sanitizeOpenAIChatCompletionsPayload(balanced), balanced);

  const anthropic = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "a", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: "ok" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "b", input: {} }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "drop" }] },
    ],
  };
  const repairedAnthropic = sanitizeAnthropicToolPairs(anthropic);
  assert.equal(repairedAnthropic.messages[2].content[0].id, "dup__dedup2");
  assert.equal(repairedAnthropic.messages[3].content[0].tool_use_id, "dup__dedup2");
  assert.equal(repairedAnthropic.messages[3].content[0].is_error, true);
  assert.equal(repairedAnthropic.messages.length, 4, "orphan-only user result is removed");
  assert.equal(anthropic.messages[2].content[0].id, "dup", "input stays immutable");

  const responses = {
    input: [
      { type: "function_call", call_id: "f1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "orphan", output: "drop" },
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "patch" },
    ],
  };
  const repairedResponses = sanitizeOpenAIResponsesPayload(responses);
  assert.deepEqual(repairedResponses.input.map(({ type, call_id: id }) => [type, id]), [
    ["function_call", "f1"],
    ["function_call_output", "f1"],
    ["custom_tool_call", "c1"],
    ["custom_tool_call_output", "c1"],
  ]);
  assert.equal(sanitizeOpenAIResponsesPayload({ ...responses, previous_response_id: "resp_1" }).input, responses.input);

  const chat = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "orphan", content: "drop" },
      { role: "user", content: "continue" },
    ],
  };
  const repairedChat = sanitizeOpenAIChatCompletionsPayload(chat);
  assert.deepEqual(repairedChat.messages.map(({ role, tool_call_id: id }) => [role, id]), [
    ["assistant", undefined],
    ["tool", "call_1"],
    ["user", undefined],
  ]);
});

test("unavailable history tool_use names are demoted to text with matching results", () => {
  const payload = {
    tools: [{ name: "apply_patch" }, { name: "read" }],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "w1", name: "write", input: { path: "a.ts" } },
          { type: "tool_use", id: "r1", name: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "w1", content: "wrote" },
          { type: "tool_result", tool_use_id: "r1", content: "ok" },
        ],
      },
    ],
  };
  const demoted = demoteUnavailableToolReferences(payload);
  assert.notEqual(demoted, payload);
  assert.equal(demoted.messages[0].content[0].type, "text");
  assert.match(demoted.messages[0].content[0].text, /unavailable-tool-call name="write"/);
  assert.match(demoted.messages[0].content[0].text, /apply_patch/);
  assert.deepEqual(demoted.messages[0].content[1], payload.messages[0].content[1]);
  assert.equal(demoted.messages[1].content[0].type, "text");
  assert.match(demoted.messages[1].content[0].text, /unavailable-tool-result name="write"/);
  assert.match(demoted.messages[1].content[0].text, /wrote/);
  assert.deepEqual(demoted.messages[1].content[1], payload.messages[1].content[1]);
  assert.equal(demoteUnavailableToolReferences(payload).messages[0].content[0].type, "text");

  const alreadyAvailable = {
    tools: [{ name: "write" }, { name: "read" }],
    messages: payload.messages,
  };
  assert.equal(demoteUnavailableToolReferences(alreadyAvailable), alreadyAvailable);
});

// pi-ai 1.0.1 (inline-tools) keeps top-level `tools` fixed and defines tools loaded later
// (tool_search) by value in `tool_addition` blocks inside messages. Feed the real payload the
// staged Anthropic provider builds, for API-key and OAuth (Claude Code names) auth.
async function anthropicWirePayload(apiKey) {
  const piAiDir = resolvePiRuntime({ root: stagedRoot }).packages["@earendil-works/pi-ai"].dir;
  const anthropic = await import(pathToFileURL(join(piAiDir, "dist/api/anthropic-messages.js")).href);
  const { anthropicProvider } = await import(pathToFileURL(join(piAiDir, "dist/providers/anthropic.js")).href);
  const model = anthropicProvider().getModels().find((candidate) =>
    candidate.compat?.supportsMidConvoSystemMessages && candidate.compat?.supportsMidConvoToolChanges);
  assert.ok(model, "the 1.0.1 catalog has an Anthropic model with native mid-conversation tool changes");
  const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
  const assistant = (content) => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 1,
  });
  const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
  const result = (toolCallId, toolName, text) => ({
    role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1,
  });
  const messages = [
    { role: "system", content: "base prompt", toolsAdded: [tool("read"), tool("apply_patch")], timestamp: 1 },
    { role: "user", content: "fix it", timestamp: 1 },
    // edit/write were hidden by apply_patch from the start: never defined in this request.
    assistant([call("toolu_write", "write"), call("toolu_edit", "edit"), call("toolu_read", "read")]),
    result("toolu_write", "write", "wrote"),
    result("toolu_edit", "edit", "edited"),
    result("toolu_read", "read", "read ok"),
    // tool_search loads grep mid-conversation (OAuth maps it to Claude Code's "Grep").
    { role: "system", content: "", toolsAdded: [tool("grep")], timestamp: 1 },
    assistant([call("toolu_grep", "grep")]),
    result("toolu_grep", "grep", "grep hits"),
    { role: "user", content: "continue", timestamp: 1 },
  ];
  let payload;
  const stream = anthropic.stream(model, { messages }, {
    apiKey,
    onPayload: (params) => {
      payload = structuredClone(params);
      throw new Error("captured payload; no request is sent");
    },
  });
  await stream.result();
  assert.ok(payload, "onPayload received the request body");
  return payload;
}

function wireToolUseNames(payload) {
  return payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === "tool_use").map((block) => block.name);
}

for (const [label, apiKey, grepName, readName] of [
  ["API key", "sk-ant-api03-test-not-real", "grep", "read"],
  ["OAuth", "sk-ant-oat01-test-not-real", "Grep", "Read"],
]) {
  test(`1.0.1 Anthropic payload (${label}): a tool loaded mid-conversation keeps its call, hidden edit/write are demoted`, async () => {
    const payload = await anthropicWirePayload(apiKey);
    assert.ok(!payload.tools.some((tool) => tool.name === grepName), "grep is not a top-level tool on 1.0.1");
    assert.ok(payload.messages.some((message) => Array.isArray(message.content) && message.content.some((block) =>
      block.type === "tool_addition" && block.tool?.type === "tool_definition" && block.tool.definition?.name === grepName)),
    "grep is defined inline by tool_addition");
    assert.deepEqual(wireToolUseNames(payload), [OAUTH_OR(label, "Write", "write"), OAUTH_OR(label, "Edit", "edit"), readName, grepName]);

    const demoted = demoteUnavailableToolReferences(payload);
    assert.deepEqual(wireToolUseNames(demoted), [readName, grepName]);
    const grepUse = demoted.messages.flatMap((message) => message.content).find((block) => block.type === "tool_use" && block.name === grepName);
    const grepResult = demoted.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === "tool_result" && block.tool_use_id === grepUse.id);
    assert.ok(grepResult, "the grep tool_result stays paired");
    const texts = demoted.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.match(texts, new RegExp(`unavailable-tool-call name="${OAUTH_OR(label, "Write", "write")}"`));
    assert.match(texts, new RegExp(`unavailable-tool-result name="${OAUTH_OR(label, "Edit", "edit")}"`));
    assert.doesNotMatch(texts, /__pi_deferred_placeholder__/, "guidance never lists the deferred placeholder");
    assert.doesNotMatch(texts, new RegExp(`name="${grepName}"`));
  });
}

function OAUTH_OR(label, oauthName, apiKeyName) {
  return label === "OAuth" ? oauthName : apiKeyName;
}

test("a call after its tool_removal is demoted; a call made while the tool was defined is kept", () => {
  const payload = {
    tools: [{ name: "read" }, { name: "__pi_deferred_placeholder__", defer_loading: true }],
    messages: [
      { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "grep" } } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "g1", name: "grep", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "hits" }] },
      { role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "grep" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "g2", name: "grep", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "g2", content: "late" }] },
    ],
  };
  const demoted = demoteUnavailableToolReferences(payload);
  assert.deepEqual(demoted.messages[1], payload.messages[1]);
  assert.deepEqual(demoted.messages[2], payload.messages[2]);
  assert.equal(demoted.messages[4].content[0].type, "text");
  assert.match(demoted.messages[4].content[0].text, /unavailable-tool-call name="grep"/);
  assert.match(demoted.messages[4].content[0].text, /call your own tools: read\./);
  assert.equal(demoted.messages[5].content[0].type, "text");
});

test("sanitizeToolPairs demotes missing names before inventing pair results", () => {
  const payload = {
    tools: [{ name: "apply_patch" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "edit", input: {} }] },
    ],
  };
  const sanitized = sanitizeToolPairs(payload);
  assert.equal(sanitized.messages.length, 1);
  assert.equal(sanitized.messages[0].content[0].type, "text");
  assert.match(sanitized.messages[0].content[0].text, /unavailable-tool-call name="edit"/);
});

test("actual stock ExtensionRunner chains repaired provider payload into later handlers", async (t) => {
  const fixture = await createFixture(t);
  const payload = { input: [{ type: "function_call", call_id: "f1", name: "read", arguments: "{}" }] };
  const repaired = await fixture.session.extensionRunner.emitBeforeProviderRequest(payload);
  assert.notEqual(repaired, payload);
  assert.equal(fixture.providerPayload, repaired);
  assert.deepEqual(repaired.input.at(-1), {
    type: "function_call_output",
    call_id: "f1",
    output: "Tool output unavailable (interrupted before result)",
  });
});

test("actual stock ExtensionRunner lets six identical attempts through, then loop guard vetoes before later hooks", async (t) => {
  const fixture = await createFixture(t);
  const runner = fixture.session.extensionRunner;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const toolCallId = `same-${attempt}`;
    const args = { value: "unchanged" };
    await runner.emit({ type: "tool_execution_start", toolCallId, toolName: "fixture", args });
    const decision = await runner.emitToolCall({ type: "tool_call", toolCallId, toolName: "fixture", input: args });
    if (attempt <= 6) assert.equal(decision, undefined, `attempt ${attempt} is admitted`);
    else {
      assert.equal(decision.block, true);
      assert.equal(decision.terminate, false);
      assert.match(decision.reason, /Loop guard blocked repeated call/);
    }
  }
  assert.equal(fixture.downstreamCalls, 6, "blocked calls never reach later hook or permission handlers");

  await runner.emit({ type: "input", text: "new user direction", images: [], source: "interactive" });
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    // This is the generic executeTool event shape: no tool_execution_start.
    const decision = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: `generic-${attempt}`,
      toolName: "fixture",
      input: { value: "unchanged" },
    });
    assert.equal(decision?.block ?? false, attempt >= 7);
  }
  assert.equal(fixture.downstreamCalls, 12, "generic calls share the same loop policy, hard stop, and veto order");
});

test("actual registered apply_patch switches wire mode, edits files, marks partial failure, and aborts cleanly", async (t) => {
  const fixture = await createFixture(t);
  const { session, cwd } = fixture;
  assert.ok(session.getActiveToolNames().includes("apply_patch"));
  assert.ok(!session.getActiveToolNames().includes("edit"));
  assert.ok(!session.getActiveToolNames().includes("write"));

  await session.extensionRunner.emit({
    type: "model_select",
    model: { id: "gpt-5.6", api: "openai-codex-responses", provider: "openai-codex" },
    source: "set",
  });
  assert.equal(session.getToolDefinition("apply_patch").constrainedSampling?.type, "grammar");
  await session.extensionRunner.emit({
    type: "model_select",
    model: { id: "grok-4.7", api: "xai-responses", provider: "xai" },
    source: "set",
  });
  assert.equal(session.getToolDefinition("apply_patch").constrainedSampling, undefined);

  const tool = session.agent.state.tools.find(({ name }) => name === "apply_patch");
  assert.ok(tool, "apply_patch is an actual active AgentTool");
  const updates = [];
  const success = await tool.execute("patch-success", {
    input: [
      "*** Begin Patch",
      "*** Add File: sample.txt",
      "+before",
      "*** Update File: sample.txt",
      "@@",
      "-before",
      "+after",
      "*** Add File: move-me.txt",
      "+moving",
      "*** Update File: move-me.txt",
      "*** Move to: moved.txt",
      "@@",
      "-moving",
      "+moved",
      "*** Add File: delete-me.txt",
      "+delete",
      "*** Delete File: delete-me.txt",
      "*** End Patch",
      "",
    ].join("\n"),
  }, undefined, (update) => updates.push(update.details.progress));
  assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "moved.txt"), "utf8"), "moved\n");
  await assert.rejects(access(join(cwd, "move-me.txt")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(cwd, "delete-me.txt")), (error) => error?.code === "ENOENT");
  assert.deepEqual(success.details.result.appliedFiles, [
    "sample.txt", "sample.txt", "move-me.txt", "moved.txt", "delete-me.txt", "delete-me.txt",
  ]);
  assert.equal(updates.at(-1).applied, 6);

  await assert.rejects(
    tool.execute("patch-invalid", { input: "not a patch" }, undefined, undefined),
    /expected \*\*\* Begin Patch/,
  );
  const partial = await tool.execute("patch-partial", {
    input: "*** Begin Patch\n*** Add File: kept.txt\n+kept\n*** Update File: missing.txt\n@@\n-nope\n+changed\n*** End Patch\n",
  }, undefined, undefined);
  assert.equal(await readFile(join(cwd, "kept.txt"), "utf8"), "kept\n");
  assert.equal(partial.details.result.hasPartialSuccess, true);
  const rewritten = await session.extensionRunner.emitToolResult({
    type: "tool_result",
    toolCallId: "patch-partial",
    toolName: "apply_patch",
    input: {},
    content: partial.content,
    details: partial.details,
    isError: false,
  });
  assert.equal(rewritten.isError, true);

  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(tool.execute("patch-abort", {
    input: "*** Begin Patch\n*** Add File: aborted.txt\n+nope\n*** End Patch\n",
  }, controller.signal, undefined), (error) => error?.name === "AbortError");
  await assert.rejects(access(join(cwd, "aborted.txt")), (error) => error?.code === "ENOENT");
  assert.equal(fixture.guards.getPendingMutationCount(), 0);
  assert.deepEqual((await readdir(cwd)).filter((name) => name.includes(".tmp.")), []);

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  assert.equal(fixture.guards.getPendingMutationCount(), 0);
});

test("abort from progress preserves the committed operation and reports the next operation as unapplied", async (t) => {
  const fixture = await createFixture(t);
  const tool = fixture.session.agent.state.tools.find(({ name }) => name === "apply_patch");
  const controller = new AbortController();
  const result = await tool.execute("patch-progress-abort", {
    input: [
      "*** Begin Patch",
      "*** Add File: first.txt",
      "+first",
      "*** Add File: second.txt",
      "+second",
      "*** End Patch",
      "",
    ].join("\n"),
  }, controller.signal, (update) => {
    if (update.details.progress?.applied === 1) controller.abort(new DOMException("stop", "AbortError"));
  });

  assert.equal(await readFile(join(fixture.cwd, "first.txt"), "utf8"), "first\n");
  await assert.rejects(access(join(fixture.cwd, "second.txt")), (error) => error?.code === "ENOENT");
  assert.deepEqual(result.details.result.appliedFiles, ["first.txt"]);
  assert.deepEqual(result.details.result.failures, [{
    operationIndex: 1,
    filePath: "second.txt",
    operation: "add",
    message: "Operation aborted",
    code: "ABORT_ERR",
  }]);
  assert.equal(result.details.result.hasPartialSuccess, true);
  assert.deepEqual(result.details.result.recoveryInstructions.failedFiles, ["second.txt"]);
  assert.equal(fixture.guards.getPendingMutationCount(), 0);
  assert.deepEqual((await readdir(fixture.cwd)).filter((name) => name.includes(".tmp.")), []);
});

test("abort after move progress observes a completed move and never exposes a copied destination", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.cwd, "source.txt"), "before\n");
  const tool = fixture.session.agent.state.tools.find(({ name }) => name === "apply_patch");
  const controller = new AbortController();
  const result = await tool.execute("patch-move-abort", {
    input: [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "*** Move to: destination.txt",
      "@@",
      "-before",
      "+after",
      "*** Add File: later.txt",
      "+later",
      "*** End Patch",
      "",
    ].join("\n"),
  }, controller.signal, (update) => {
    if (update.details.progress?.applied === 1) controller.abort(new DOMException("stop", "AbortError"));
  });

  assert.equal(await readFile(join(fixture.cwd, "destination.txt"), "utf8"), "after\n");
  await assert.rejects(access(join(fixture.cwd, "source.txt")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(fixture.cwd, "later.txt")), (error) => error?.code === "ENOENT");
  assert.deepEqual(result.details.result.appliedFiles, ["destination.txt"]);
  assert.deepEqual(result.details.result.details.appliedOperations, [{
    operationIndex: 0,
    filePath: "destination.txt",
    operation: "update",
    fuzz: 0,
  }]);
  assert.equal(result.details.result.failures[0]?.code, "ABORT_ERR");
  assert.equal(result.details.result.failures[0]?.filePath, "later.txt");
  assert.equal(fixture.guards.getPendingMutationCount(), 0);
  assert.deepEqual((await readdir(fixture.cwd)).filter((name) => name.includes(".tmp.")), []);
});

test("a loop-guard notice is appended after the latest tool result and never rewrites an earlier request", async (t) => {
  const runtime = resolvePiRuntime({ root: stagedWithPromptRoot });
  const sdk = await import(`${pathToFileURL(runtime.sdkEntry).href}?prefix=${Math.random()}`);
  const guards = await import(`${pathToFileURL(join(stagedWithPromptRoot, "rubato-features/tool-guards/index.mjs")).href}?prefix=${Math.random()}`);
  const { AssistantMessageEventStream } = await import(pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js",
  )).href);
  const cwd = join(scratchRoot, `prefix-cwd-${Math.random()}`);
  const agentDir = join(scratchRoot, `prefix-agent-${Math.random()}`);
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(join(cwd, "same.txt"), "unchanged\n");
  await writeFile(join(cwd, "other.txt"), "other\n");
  const model = {
    provider: "tool-guards-test",
    id: "fake-model",
    name: "Offline loop guard fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "tool-guards-test": {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: "offline-fixture-key",
        models: [{ id: model.id, name: model.name, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
      },
    },
  }));
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: guards.createToolGuardExtensionFactories(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    model,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});

  const assistant = (content, stopReason) => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  });
  const readSame = (index) => assistant([{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "same.txt" } }], "toolUse");
  // Three identical reads fire the notice during the third call. The run keeps working for
  // another tool turn, so a notice left at its old place would sit inside the next run's prefix.
  const script = [readSame(1), readSame(2), readSame(3),
    assistant([{ type: "toolCall", id: "read-other", name: "read", arguments: { path: "other.txt" } }], "toolUse"),
    assistant([{ type: "text", text: "done" }], "stop"),
    assistant([{ type: "text", text: "ok" }], "stop")];
  const requests = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const message = script[requests.length - 1];
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };

  await session.prompt("read it");
  await session.prompt("again");

  assert.equal(requests.length, 6);
  const hasNotice = (messages) => messages.some((message) => JSON.stringify(message).includes("LOOP GUARD - IDENTICAL TOOL CALLS"));
  assert.equal(hasNotice(requests[2]), false);
  assert.equal(hasNotice(requests[3]), true, "the notice reaches the model in the run that triggered it");
  const last = requests[3].at(-1);
  assert.equal(last.role, "user", "the notice follows the tool result it was raised on");
  assert.match(JSON.stringify(last), /LOOP GUARD/);
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1];
    const next = requests[index];
    assert.ok(next.length > previous.length);
    assert.deepEqual(next.slice(0, previous.length), previous, `request ${index} keeps request ${index - 1} as its prefix`);
  }
});
