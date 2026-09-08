import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolGuardsFeature } from "./feature.mjs";
import {
  sanitizeAnthropicToolPairs,
  sanitizeOpenAIChatCompletionsPayload,
  sanitizeOpenAIResponsesPayload,
} from "./tool-pair.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-tool-guards-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({ sourceRoot: runtimeRoot, outputRoot: stagedRoot, features: [toolGuardsFeature] });

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
    model: { id: "grok-4.6", api: "xai-responses", provider: "xai" },
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
