import assert from "node:assert/strict";
import http2 from "node:http2";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { providersFeature } from "../providers/patches.mjs";
import { toolExecutionFeature } from "../tool-execution/patches.mjs";
import { toolGuardsFeature } from "../tool-guards/feature.mjs";
import { providerExecutionFeature } from "./patches.mjs";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const sourceRuntimeRoot = join(import.meta.dirname, "../..");
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-provider-execution-"));
const stagedRoot = join(scratchRoot, "runtime");
const isolatedHome = join(scratchRoot, "home");
mkdirSync(isolatedHome);

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({
  sourceRoot: sourceRuntimeRoot,
  outputRoot: stagedRoot,
  features: [toolExecutionFeature, providersFeature, providerExecutionFeature, toolGuardsFeature],
});

const runtime = resolvePiRuntime({ root: stagedRoot });
const piAiRoot = runtime.packages["@earendil-works/pi-ai"].dir;
const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
const providers = await import(
  pathToFileURL(join(piAiRoot, "dist/rubato-features/providers/extension.mjs")).href
);
const providerExecution = await import(
  pathToFileURL(join(piAiRoot, "dist/rubato-features/provider-execution/extension.mjs")).href
);
const guards = await import(
  pathToFileURL(join(stagedRoot, "rubato-features/tool-guards/index.mjs")).href
);
process.env.CURSOR_CONVERSATION_ID_STORE = join(scratchRoot, "cursor-rotation.json");
const proto = await import(
  pathToFileURL(join(piAiRoot, "dist/api/cursor-agent/gen/agent_pb.js")).href
);

function connectFrame(bytes) {
  const frame = Buffer.alloc(5 + bytes.length);
  frame.writeUInt32BE(bytes.length, 1);
  Buffer.from(bytes).copy(frame, 5);
  return frame;
}

function cursorInteraction(caseName, value) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(proto.InteractionUpdateSchema, {
          message: { case: caseName, value },
        }),
      },
    }),
  );
}

function cursorExecRead(path) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(proto.ExecServerMessageSchema, {
          id: 7,
          execId: "local-exec-1",
          message: {
            case: "piReadArgs",
            value: create(proto.PiReadExecArgsSchema, { path }),
          },
        }),
      },
    }),
  );
}

function cursorExecNativeRead(path, toolCallId, index) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(proto.ExecServerMessageSchema, {
          id: 200 + index,
          execId: `session-exec-${index}`,
          message: {
            case: "readArgs",
            value: create(proto.ReadArgsSchema, { path, toolCallId }),
          },
        }),
      },
    }),
  );
}

function cursorExecShell(command, workingDirectory, toolCallId, index, execId = `guard-exec-${index}`) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(proto.ExecServerMessageSchema, {
          id: 100 + index,
          execId,
          message: {
            case: "shellArgs",
            value: create(proto.ShellArgsSchema, { command, workingDirectory, toolCallId }),
          },
        }),
      },
    }),
  );
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitFor(promise, label, timeoutMs = 5_000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}


function cursorExecWrite(path, fileText, toolCallId, index, execId = `write-exec-${index}`) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(proto.ExecServerMessageSchema, {
          id: 300 + index,
          execId,
          message: {
            case: "writeArgs",
            value: create(proto.WriteArgsSchema, { path, fileText, toolCallId }),
          },
        }),
      },
    }),
  );
}

function cursorExecPiEdit(path, edits, index, execId = `edit-exec-${index}`) {
  return toBinary(
    proto.AgentServerMessageSchema,
    create(proto.AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(proto.ExecServerMessageSchema, {
          id: 400 + index,
          execId,
          message: {
            case: "piEditArgs",
            value: create(proto.PiEditExecArgsSchema, {
              path,
              edits: edits.map((edit) => create(proto.PiEditReplacementSchema, edit)),
            }),
          },
        }),
      },
    }),
  );
}

function writeFakeCursorAuth(agentDir, label) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
    cursor: {
      type: "oauth",
      access: `${label}-access-not-real`,
      refresh: `${label}-refresh-not-real`,
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });
}

function selectedModel(baseUrl) {
  return {
    provider: "cursor",
    id: "cursor-local-exec",
    name: "Cursor local exec fixture",
    api: "cursor-agent",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 64_000,
    maxTokens: 4_096,
    cost: { ...ZERO_COST },
  };
}

test("actual stock AgentSession drains one Cursor exec and records exactly one paired result", async (t) => {
  const cwd = join(scratchRoot, "cwd");
  const agentDir = join(scratchRoot, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const filePath = join(cwd, "fixture.txt");
  writeFileSync(filePath, "native cursor bridge\n");
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
    cursor: {
      type: "oauth",
      access: "cursor-exec-test-not-real",
      refresh: "cursor-exec-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const clientMessages = [];
  let sendExec;
  let sendFinal;
  let requestNumber = 0;
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let execSent = false;
    let finalSent = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !execSent) {
          execSent = true;
          requestNumber += 1;
          if (requestNumber > 1) {
            finalSent = true;
            stream.write(connectFrame(cursorInteraction(
              "textDelta",
              create(proto.TextDeltaUpdateSchema, { text: "second-turn" }),
            )));
            stream.write(connectFrame(cursorInteraction(
              "turnEnded",
              create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }),
            )));
            continue;
          }
          stream.write(connectFrame(cursorExecRead(filePath)));
          sendExec?.();
        }
        if (
          message.message.case === "execClientMessage" &&
          message.message.value.message.case === "piReadResult" &&
          !finalSent
        ) {
          finalSent = true;
          stream.write(connectFrame(cursorInteraction(
            "textDelta",
            create(proto.TextDeltaUpdateSchema, { text: "after-read" }),
          )));
          stream.write(connectFrame(cursorInteraction(
            "turnEnded",
            create(proto.TurnEndedUpdateSchema, { inputTokens: 2n, outputTokens: 1n }),
          )));
          sendFinal?.();
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const requestSent = new Promise((resolve) => { sendExec = resolve; });
  const responseSent = new Promise((resolve) => { sendFinal = resolve; });
  let releaseTool;
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  let toolStarted;
  const toolStartedPromise = new Promise((resolve) => { toolStarted = resolve; });
  const hookCalls = [];
  const lifecycle = [];
  const execution = providerExecution.createProviderExecution();
  let extensionApi;
  const env = {
    HOME: isolatedHome,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: agentDir,
    CURSOR_CONVERSATION_ID_STORE: join(scratchRoot, "cursor-rotation.json"),
    PATH: process.env.PATH,
  };
  const observer = (pi) => {
    extensionApi = pi;
    pi.on("tool_call", async (event) => {
      hookCalls.push(["call", event.toolCallId, event.toolName]);
      toolStarted();
      await toolGate;
    });
    pi.on("tool_result", (event) => {
      hookCalls.push(["result", event.toolCallId, event.toolName]);
    });
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...guards.createToolGuardExtensionFactories(),
      {
        name: "rubato-providers",
        factory: providers.createProvidersExtension({
          env,
          routeFactories: { cursor: execution.cursorRouteFactory },
          kiro: { ensureKiro: async () => {} },
        }),
      },
      { name: "rubato-provider-execution", factory: execution.extension },
      { name: "observer", factory: observer },
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: selectedModel(baseUrl),
    tools: ["read"],
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  t.after(() => result.session.dispose());
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.bindExtensions({ onError: (error) => assert.fail(error) });
  await assert.rejects(
    extensionApi.executeTool("read", { path: filePath }, { toolCallId: "  " }),
    /toolCallId must be a non-empty string/,
  );
  assert.deepEqual(hookCalls, [], "invalid provider call ids fail before extension hooks or execution");
  result.session.subscribe((event) => {
    if (event.type.startsWith("tool_execution_")) lifecycle.push(event);
  });

  let promptSettled = false;
  const prompt = result.session.prompt("read the fixture").finally(() => { promptSettled = true; });
  await waitFor(requestSent, "Cursor run request");
  await waitFor(toolStartedPromise, "Cursor tool preflight");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(promptSettled, false, "turn must wait while server-driven local work is pending");
  assert.equal(clientMessages.some((message) => message.message.case === "execClientMessage"), false);

  releaseTool();
  await waitFor(responseSent, "Cursor exec response");
  await waitFor(prompt, "Cursor AgentSession completion");

  const assistant = result.session.agent.state.messages.find((message) => message.role === "assistant");
  const toolResults = result.session.agent.state.messages.filter((message) => message.role === "toolResult");
  const toolCalls = assistant.content.filter((part) => part.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(
    toolResults.length,
    1,
    `resolved Cursor tool must be paired exactly once: ${JSON.stringify({ hookCalls, lifecycle, messages: result.session.agent.state.messages })}`,
  );
  assert.equal(toolResults[0].toolCallId, toolCalls[0].id);
  assert.equal(toolResults[0].toolName, "read");
  assert.match(toolResults[0].content[0].text, /native cursor bridge/);
  assert.match(assistant.content.filter((part) => part.type === "text").map((part) => part.text).join(""), /after-read/);
  assert.deepEqual(hookCalls, [
    ["call", toolCalls[0].id, "read"],
    ["result", toolCalls[0].id, "read"],
  ]);
  assert.deepEqual(
    lifecycle.map((event) => [event.type, event.toolCallId, event.toolName]),
    [
      ["tool_execution_start", toolCalls[0].id, "read"],
      ["tool_execution_end", toolCalls[0].id, "read"],
    ],
  );
  hookCalls.length = 0;
  await extensionApi.executeTool("read", { path: filePath });
  assert.match(hookCalls[0][1], /^rubato-[0-9a-f-]+$/u);
  assert.equal(hookCalls[1][1], hookCalls[0][1], "default generated id remains paired across hooks");
  const wireResult = clientMessages.find(
    (message) => message.message.case === "execClientMessage" &&
      message.message.value.message.case === "piReadResult",
  );
  assert.equal(wireResult.message.value.message.value.result.case, "success");
  assert.match(wireResult.message.value.message.value.result.value.output, /native cursor bridge/);
  const pairCountBeforeNextTurn = result.session.agent.state.messages.filter(
    (message) => message.role === "toolResult" && message.toolCallId === toolCalls[0].id,
  ).length;
  const wireCountBeforeNextTurn = clientMessages.filter(
    (message) => message.message.case === "execClientMessage" &&
      message.message.value.message.case === "piReadResult",
  ).length;
  await waitFor(result.session.prompt("continue without replaying prior local work"), "second Cursor turn");
  assert.equal(
    result.session.agent.state.messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId === toolCalls[0].id,
    ).length,
    pairCountBeforeNextTurn,
    "a later turn keeps the resolved pair as history without executing or appending it again",
  );
  assert.equal(
    clientMessages.filter(
      (message) => message.message.case === "execClientMessage" &&
        message.message.value.message.case === "piReadResult",
    ).length,
    wireCountBeforeNextTurn,
    "a later turn does not replay the previous exec result on the wire",
  );
  assert.deepEqual(execution.getState(), { bound: true, generation: 1 });
});

test("actual Cursor shell execs honor the selected loop guard before side effects and never replay", async (t) => {
  const cwd = join(scratchRoot, "guard-cwd");
  const agentDir = join(scratchRoot, "guard-agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
    cursor: {
      type: "oauth",
      access: "cursor-guard-test-not-real",
      refresh: "cursor-guard-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const command = "printf x >> guard-side-effects.txt";
  const toolCallIds = Array.from({ length: 7 }, (_, index) => `guard-call-${index + 1}`);
  const clientMessages = [];
  let providerRuns = 0;
  let finishedGuardSequence;
  const guardSequenceFinished = new Promise((resolve) => { finishedGuardSequence = resolve; });
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let responseCount = 0;
    let initialRun = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest") {
          providerRuns += 1;
          initialRun = providerRuns === 1;
          if (initialRun) {
            stream.write(connectFrame(cursorExecShell(command, cwd, toolCallIds[0], 1)));
          } else {
            stream.write(connectFrame(cursorInteraction(
              "textDelta",
              create(proto.TextDeltaUpdateSchema, { text: "no-replay" }),
            )));
            stream.write(connectFrame(cursorInteraction(
              "turnEnded",
              create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }),
            )));
          }
          continue;
        }
        if (
          initialRun &&
          message.message.case === "execClientMessage" &&
          message.message.value.message.case === "shellResult"
        ) {
          responseCount += 1;
          if (responseCount < toolCallIds.length) {
            stream.write(connectFrame(cursorExecShell(
              command,
              cwd,
              toolCallIds[responseCount],
              responseCount + 1,
            )));
          } else {
            stream.write(connectFrame(cursorInteraction(
              "turnEnded",
              create(proto.TurnEndedUpdateSchema, { inputTokens: 2n, outputTokens: 1n }),
            )));
            finishedGuardSequence?.();
          }
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const execution = providerExecution.createProviderExecution();
  const admittedCalls = [];
  const observer = (pi) => {
    pi.on("tool_call", (event) => admittedCalls.push(event.toolCallId));
  };
  const env = {
    HOME: isolatedHome,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: agentDir,
    CURSOR_CONVERSATION_ID_STORE: join(scratchRoot, "cursor-guard-rotation.json"),
    PATH: process.env.PATH,
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...guards.createToolGuardExtensionFactories(),
      {
        name: "rubato-providers",
        factory: providers.createProvidersExtension({
          env,
          routeFactories: { cursor: execution.cursorRouteFactory },
          kiro: { ensureKiro: async () => {} },
        }),
      },
      { name: "rubato-provider-execution", factory: execution.extension },
      { name: "provider-execution-guard-observer", factory: observer },
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: selectedModel(baseUrl),
    tools: ["bash"],
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  t.after(() => result.session.dispose());
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.bindExtensions({ onError: (error) => assert.fail(error) });

  await waitFor(result.session.prompt("run the guarded shell fixture"), "guarded Cursor turn");
  await waitFor(guardSequenceFinished, "guarded Cursor exec sequence");
  assert.equal(readFileSync(join(cwd, "guard-side-effects.txt"), "utf8"), "xxxxxx");
  assert.deepEqual(admittedCalls, toolCallIds.slice(0, 6), "the veto runs before later hooks and the bash tool");

  const wireResults = clientMessages.filter(
    (message) => message.message.case === "execClientMessage" &&
      message.message.value.message.case === "shellResult",
  );
  assert.equal(wireResults.length, 7);
  assert.deepEqual(wireResults.map((message) => message.message.value.execId),
    Array.from({ length: 7 }, (_, index) => `guard-exec-${index + 1}`));
  assert.deepEqual(
    wireResults.map((message) => message.message.value.message.value.result.case),
    ["success", "success", "success", "success", "success", "success", "failure"],
  );

  const assistantCalls = result.session.agent.state.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
  const toolResults = result.session.agent.state.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(assistantCalls.map((call) => call.id), toolCallIds);
  assert.deepEqual(toolResults.map((message) => message.toolCallId), toolCallIds);
  assert.equal(toolResults.at(-1).isError, true);
  assert.match(toolResults.at(-1).content[0].text, /Loop guard blocked repeated call/);

  const resultCountBeforeNextTurn = toolResults.length;
  const wireCountBeforeNextTurn = wireResults.length;
  await waitFor(result.session.prompt("continue after the guarded call"), "post-guard Cursor turn");
  assert.equal(readFileSync(join(cwd, "guard-side-effects.txt"), "utf8"), "xxxxxx");
  assert.equal(
    result.session.agent.state.messages.filter((message) => message.role === "toolResult").length,
    resultCountBeforeNextTurn,
  );
  assert.equal(
    clientMessages.filter(
      (message) => message.message.case === "execClientMessage" &&
        message.message.value.message.case === "shellResult",
    ).length,
    wireCountBeforeNextTurn,
  );
});

test("one stock ModelRuntime routes Cursor execs to the owning AgentSession across reload", async (t) => {
  const sharedAgentDir = join(scratchRoot, "shared-runtime-agent");
  const sessionSpecs = [
    { name: "a", cwd: join(scratchRoot, "shared-cwd-a"), agentDir: join(scratchRoot, "shared-agent-a") },
    { name: "b", cwd: join(scratchRoot, "shared-cwd-b"), agentDir: join(scratchRoot, "shared-agent-b") },
  ];
  mkdirSync(sharedAgentDir);
  for (const spec of sessionSpecs) {
    mkdirSync(spec.cwd);
    mkdirSync(spec.agentDir);
    writeFileSync(join(spec.cwd, "fixture.txt"), `session-${spec.name}\n`);
  }
  writeFileSync(join(sharedAgentDir, "auth.json"), `${JSON.stringify({
    cursor: {
      type: "oauth",
      access: "cursor-shared-runtime-test-not-real",
      refresh: "cursor-shared-runtime-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  let requestIndex = 0;
  const clientMessages = [];
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentExec = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !sentExec) {
          sentExec = true;
          requestIndex += 1;
          stream.write(connectFrame(cursorExecNativeRead(
            "fixture.txt",
            `session-call-${requestIndex}`,
            requestIndex,
          )));
          continue;
        }
        if (
          message.message.case === "execClientMessage" &&
          message.message.value.message.case === "readResult"
        ) {
          stream.write(connectFrame(cursorInteraction(
            "turnEnded",
            create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }),
          )));
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const sharedRuntime = await sdk.ModelRuntime.create({
    authPath: join(sharedAgentDir, "auth.json"),
    modelsPath: join(sharedAgentDir, "models.json"),
  });
  const execution = providerExecution.createProviderExecution();
  const sessions = [];
  for (const spec of sessionSpecs) {
    const settingsManager = sdk.SettingsManager.inMemory();
    const env = {
      HOME: isolatedHome,
      PI_OFFLINE: "1",
      RUBATO_SPEED_INDEX: "0",
      RUBATO_NO_KIRO_ENSURE: "1",
      RUBATO_PI_CODING_AGENT_DIR: spec.agentDir,
      CURSOR_CONVERSATION_ID_STORE: join(scratchRoot, "cursor-shared-rotation.json"),
      PATH: process.env.PATH,
    };
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: spec.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "rubato-providers",
          factory: providers.createProvidersExtension({
            env,
            routeFactories: { cursor: execution.cursorRouteFactory },
            kiro: { ensureKiro: async () => {} },
          }),
        },
        { name: "rubato-provider-execution", factory: execution.extension },
      ],
    });
    await resourceLoader.reload();
    const created = await sdk.createAgentSession({
      cwd: spec.cwd,
      agentDir: spec.agentDir,
      model: selectedModel(baseUrl),
      tools: ["read"],
      settingsManager,
      resourceLoader,
      modelRuntime: sharedRuntime,
      sessionManager: sdk.SessionManager.inMemory(spec.cwd),
    });
    t.after(() => created.session.dispose());
    assert.deepEqual(created.extensionsResult.errors, []);
    await created.session.bindExtensions({ onError: (error) => assert.fail(error) });
    sessions.push(created.session);
  }

  const assertOwnedRead = async (session, expected, label) => {
    const before = session.agent.state.messages.length;
    await waitFor(session.prompt(label), label);
    const messages = session.agent.state.messages.slice(before);
    const assistant = messages.find((message) => message.role === "assistant");
    const toolResult = messages.find((message) => message.role === "toolResult");
    assert.ok(assistant);
    assert.ok(toolResult);
    const call = assistant.content.find((part) => part.type === "toolCall");
    assert.equal(call.id, `session-call-${requestIndex}`);
    assert.equal(toolResult.toolCallId, call.id);
    assert.match(toolResult.content[0].text, new RegExp(expected));
  };

  // B bound last: a provider-global binding would wrongly execute A's read in B's cwd.
  await assertOwnedRead(sessions[0], "session-a", "shared runtime session A");
  await assertOwnedRead(sessions[1], "session-b", "shared runtime session B");
  await sessions[0].reload();
  // A now registered last: B must still retain its own cwd, hooks, and tool registry.
  await assertOwnedRead(sessions[1], "session-b", "session B after A reload");
  await assertOwnedRead(sessions[0], "session-a", "reloaded session A");

  const nativeReadResults = clientMessages.filter(
    (message) => message.message.case === "execClientMessage" &&
      message.message.value.message.case === "readResult",
  );
  assert.equal(nativeReadResults.length, 4);
  assert.deepEqual(nativeReadResults.map((message) => message.message.value.execId), [
    "session-exec-1", "session-exec-2", "session-exec-3", "session-exec-4",
  ]);
  assert.deepEqual(execution.getState(), { bound: true, generation: 3 });
});

test("an aborted actual Cursor shell exec records one error pair and no late side effect", async (t) => {
  const cwd = join(scratchRoot, "abort-cwd");
  const agentDir = join(scratchRoot, "abort-agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
    cursor: {
      type: "oauth",
      access: "cursor-abort-test-not-real",
      refresh: "cursor-abort-refresh-test-not-real",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const sideEffectPath = join(cwd, "aborted-side-effect.txt");
  const clientMessages = [];
  let providerRuns = 0;
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentExec = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case !== "runRequest" || sentExec) continue;
        sentExec = true;
        providerRuns += 1;
        if (providerRuns === 1) {
          stream.write(connectFrame(cursorExecShell(
            "/bin/sleep 10; printf late >> aborted-side-effect.txt",
            cwd,
            "abort-call-1",
            99,
          )));
        } else {
          stream.write(connectFrame(cursorInteraction(
            "textDelta",
            create(proto.TextDeltaUpdateSchema, { text: "after-abort" }),
          )));
          stream.write(connectFrame(cursorInteraction(
            "turnEnded",
            create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }),
          )));
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const execution = providerExecution.createProviderExecution();
  let session;
  let abortPromise;
  let requestAbort;
  const abortRequested = new Promise((resolve) => { requestAbort = resolve; });
  const hookCalls = [];
  const abortingObserver = (pi) => {
    pi.on("tool_call", (event) => {
      hookCalls.push(["call", event.toolCallId]);
      if (event.toolCallId !== "abort-call-1") return;
      setTimeout(() => {
        abortPromise = session.abort();
        requestAbort();
      }, 50);
    });
    pi.on("tool_result", (event) => hookCalls.push(["result", event.toolCallId, event.isError]));
  };
  const env = {
    HOME: isolatedHome,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: agentDir,
    CURSOR_CONVERSATION_ID_STORE: join(scratchRoot, "cursor-abort-rotation.json"),
    PATH: process.env.PATH,
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...guards.createToolGuardExtensionFactories(),
      {
        name: "rubato-providers",
        factory: providers.createProvidersExtension({
          env,
          routeFactories: { cursor: execution.cursorRouteFactory },
          kiro: { ensureKiro: async () => {} },
        }),
      },
      { name: "rubato-provider-execution", factory: execution.extension },
      { name: "provider-execution-abort-observer", factory: abortingObserver },
    ],
  });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: selectedModel(baseUrl),
    tools: ["bash"],
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  session = created.session;
  t.after(() => session.dispose());
  assert.deepEqual(created.extensionsResult.errors, []);
  await session.bindExtensions({ onError: (error) => assert.fail(error) });
  const lifecycle = [];
  session.subscribe((event) => {
    if (event.type.startsWith("tool_execution_")) lifecycle.push(event);
  });

  const prompt = session.prompt("start then abort the native shell fixture");
  await waitFor(abortRequested, "native Cursor abort request");
  await waitFor(Promise.all([prompt, abortPromise]), "aborted Cursor settlement");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => readFileSync(sideEffectPath, "utf8"), (error) => error?.code === "ENOENT");

  const assistant = session.agent.state.messages.find((message) =>
    message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === "abort-call-1"));
  const toolResults = session.agent.state.messages.filter((message) =>
    message.role === "toolResult" && message.toolCallId === "abort-call-1");
  assert.ok(assistant, "the aborted exec still has one terminal assistant block");
  assert.equal(toolResults.length, 1, "the aborted exec still has exactly one paired result");
  assert.equal(toolResults[0].isError, true);
  assert.match(toolResults[0].content[0].text, /abort/i);
  assert.deepEqual(hookCalls, [
    ["call", "abort-call-1"],
    ["result", "abort-call-1", true],
  ]);
  assert.deepEqual(
    lifecycle
      .filter((event) => event.type !== "tool_execution_update")
      .map((event) => [event.type, event.toolCallId, event.isError]),
    [
      ["tool_execution_start", "abort-call-1", undefined],
      ["tool_execution_end", "abort-call-1", true],
    ],
  );
  assert.ok(lifecycle.every((event) => event.toolCallId === "abort-call-1"));

  const beforeNextTurn = session.agent.state.messages.length;
  await waitFor(session.prompt("continue after abort without replay"), "post-abort Cursor turn");
  assert.throws(() => readFileSync(sideEffectPath, "utf8"), (error) => error?.code === "ENOENT");
  assert.equal(session.agent.state.messages.slice(beforeNextTurn).some((message) =>
    message.role === "toolResult" && message.toolCallId === "abort-call-1"), false);
});

async function bindCursorSession(t, spec) {
  const { cwd, agentDir, tools, observer, modelRuntime, baseUrl, rotationName } = spec;
  mkdirSync(cwd, { recursive: true });
  writeFakeCursorAuth(agentDir, rotationName ?? "a7");
  const execution = providerExecution.createProviderExecution();
  const env = {
    HOME: isolatedHome,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    RUBATO_PI_CODING_AGENT_DIR: agentDir,
    CURSOR_CONVERSATION_ID_STORE: join(scratchRoot, `${rotationName ?? "a7"}-rotation.json`),
    PATH: process.env.PATH,
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const factories = [
    ...guards.createToolGuardExtensionFactories(),
    {
      name: "rubato-providers",
      factory: providers.createProvidersExtension({
        env,
        routeFactories: { cursor: execution.cursorRouteFactory },
        kiro: { ensureKiro: async () => {} },
      }),
    },
    { name: "rubato-provider-execution", factory: execution.extension },
  ];
  if (observer) factories.push({ name: "a7-observer", factory: observer });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
  });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    model: selectedModel(baseUrl),
    tools,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    ...(modelRuntime ? { modelRuntime } : {}),
  });
  t.after(() => created.session.dispose());
  assert.deepEqual(created.extensionsResult.errors, []);
  await created.session.bindExtensions({ onError: (error) => assert.fail(error) });
  return { ...created, execution };
}

test("same Cursor exec identity does not run twice when the transport redelivers it concurrently and sequentially", async (t) => {
  const cwd = join(scratchRoot, "dedup-cwd");
  const agentDir = join(scratchRoot, "dedup-agent");
  const sideEffect = join(cwd, "once.txt");
  const command = "printf x >> once.txt";
  const originalToolCallId = "shared-call-id";
  const sameExecId = "same-frame-exec";
  const otherExecId = "other-frame-exec";
  const clientMessages = [];
  let shellResults = 0;
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentInitial = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !sentInitial) {
          sentInitial = true;
          stream.write(connectFrame(cursorExecShell(command, cwd, originalToolCallId, 1, sameExecId)));
          stream.write(connectFrame(cursorExecShell(command, cwd, originalToolCallId, 2, sameExecId)));
          continue;
        }
        if (message.message.case !== "execClientMessage" || message.message.value.message.case !== "shellResult") continue;
        shellResults += 1;
        if (shellResults === 2) {
          stream.write(connectFrame(cursorExecShell(command, cwd, originalToolCallId, 3, sameExecId)));
        } else if (shellResults === 3) {
          stream.write(connectFrame(cursorExecShell(command, cwd, originalToolCallId, 4, otherExecId)));
        } else if (shellResults >= 4) {
          stream.write(connectFrame(cursorInteraction("turnEnded", create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }))));
          finished?.();
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const { session } = await bindCursorSession(t, { cwd, agentDir, tools: ["bash"], baseUrl, rotationName: "dedup" });
  await waitFor(session.prompt("run once even if the frame is redelivered"), "dedup Cursor turn");
  await waitFor(done, "dedup exec sequence");
  assert.equal(readFileSync(sideEffect, "utf8"), "xx", "same execId runs once; a different execId with the same original toolCallId is a second frame");
  const toolResults = session.agent.state.messages.filter((message) => message.role === "toolResult");
  const toolCalls = session.agent.state.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
  assert.equal(toolCalls.length, 2, "transcript keeps one block per exec identity, not per suffixed redelivery");
  assert.equal(toolResults.length, 2);
  assert.equal(toolCalls[0].id, originalToolCallId);
  assert.equal(toolCalls[1].id, `${originalToolCallId}-2`);
  const wire = clientMessages.filter((message) => message.message.case === "execClientMessage" && message.message.value.message.case === "shellResult");
  assert.equal(wire.length, 4, "each delivered frame still gets a wire answer");
  assert.deepEqual(wire.map((message) => message.message.value.execId), [sameExecId, sameExecId, sameExecId, otherExecId]);
});

test("Cursor exec journal replays a completed identity and refuses unknown after a crash", async (t) => {
  const cwd = join(scratchRoot, "journal-cwd");
  const agentDir = join(scratchRoot, "journal-agent");
  const command = "printf ran >> journal-side.txt";
  const execId = "durable-exec-1";
  const crashExecId = "crashed-exec-1";
  const clientMessages = [];
  let shellResults = 0;
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentInitial = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !sentInitial) {
          sentInitial = true;
          stream.write(connectFrame(cursorExecShell(command, cwd, "journal-call-1", 1, execId)));
          continue;
        }
        if (message.message.case !== "execClientMessage" || message.message.value.message.case !== "shellResult") continue;
        shellResults += 1;
        if (shellResults === 1) {
          stream.write(connectFrame(cursorExecShell(command, cwd, "journal-call-1", 2, execId)));
        } else {
          stream.write(connectFrame(cursorInteraction("turnEnded", create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }))));
          finished?.();
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const { session } = await bindCursorSession(t, { cwd, agentDir, tools: ["bash"], baseUrl, rotationName: "journal" });
  await waitFor(session.prompt("journal a native shell exec"), "journal Cursor turn");
  await waitFor(done, "journal exec sequence");
  assert.equal(readFileSync(join(cwd, "journal-side.txt"), "utf8"), "ran");
  const journalPath = join(agentDir, "cursor-exec-journal.json");
  assert.equal(existsSync(journalPath), true, "journal is durable under the session agentDir");
  assert.equal(journalPath.startsWith(agentDir), true);
  assert.equal(journalPath.includes(".cursor"), false);
  const lineageId = session.sessionId;
  assert.equal(typeof lineageId, "string");
  assert.notEqual(lineageId, "");
  const restarted = providerExecution.createCursorExecJournal({ journalPath, agentDir });
  const replay = restarted.prepare({ lineageId, execId, toolCallId: "journal-call-1", toolName: "bash" });
  assert.equal(replay.decision, "replay");
  assert.equal(replay.entry.isError, false);
  assert.equal(readFileSync(join(cwd, "journal-side.txt"), "utf8"), "ran");
  const raw = JSON.parse(readFileSync(journalPath, "utf8"));
  raw.entries[`${lineageId}\u0000${crashExecId}`] = {
    lineageId,
    execId: crashExecId,
    toolName: "bash",
    state: "executing",
    pid: 999999,
    updatedAt: Date.now(),
  };
  writeFileSync(journalPath, `${JSON.stringify(raw)}\n`);
  const afterCrash = providerExecution.createCursorExecJournal({
    journalPath,
    agentDir,
    isOwnerAlive: () => false,
  });
  const refused = afterCrash.prepare({ lineageId, execId: crashExecId, toolCallId: "journal-call-crash", toolName: "bash" });
  assert.equal(refused.decision, "refuse");
  assert.equal(refused.entry.state, "unknown");
  assert.equal(readFileSync(join(cwd, "journal-side.txt"), "utf8"), "ran");
});

test("afterToolCall turning a Cursor exec into a failure is delivered as failure, preserving usage and addedToolNames", async (t) => {
  const cwd = join(scratchRoot, "hook-cwd");
  const agentDir = join(scratchRoot, "hook-agent");
  const command = "printf ok >> hook-side.txt";
  const clientMessages = [];
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentExec = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !sentExec) {
          sentExec = true;
          stream.write(connectFrame(cursorExecShell(command, cwd, "hook-call-1", 1, "hook-exec-1")));
          continue;
        }
        if (message.message.case === "execClientMessage" && message.message.value.message.case === "shellResult") {
          stream.write(connectFrame(cursorInteraction("turnEnded", create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }))));
          finished?.();
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const observer = (pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "bash") return undefined;
      return { isError: true, usage: { input: 7 }, addedToolNames: ["from-hook"] };
    });
  };
  const { session } = await bindCursorSession(t, { cwd, agentDir, tools: ["bash"], baseUrl, observer, rotationName: "hook" });
  await waitFor(session.prompt("turn a successful exec into a failure"), "hook Cursor turn");
  await waitFor(done, "hook exec sequence");
  assert.equal(readFileSync(join(cwd, "hook-side.txt"), "utf8"), "ok", "afterToolCall runs after the side effect");
  const toolResult = session.agent.state.messages.find((message) => message.role === "toolResult");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /no output/, "hook omitted content, so the original bash result is kept");
  assert.deepEqual(toolResult.usage, { input: 7 });
  assert.deepEqual(toolResult.addedToolNames, ["from-hook"]);
  const wire = clientMessages.find((message) => message.message.case === "execClientMessage" && message.message.value.message.case === "shellResult");
  assert.equal(wire.message.value.message.value.result.case, "failure", "a hooked failure must not be a wire success");
});

test("Cursor native write/edit persist through hostWrite/hostEdit without activating model-hidden tools", async (t) => {
  const cwd = join(scratchRoot, "host-cwd");
  const agentDir = join(scratchRoot, "host-agent");
  const clientMessages = [];
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sentWrite = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        clientMessages.push(message);
        if (message.message.case === "runRequest" && !sentWrite) {
          sentWrite = true;
          stream.write(connectFrame(cursorExecWrite("host.txt", "alpha\n", "write-call-1", 1, "host-write-exec")));
          continue;
        }
        if (message.message.case === "execClientMessage" && message.message.value.message.case === "writeResult") {
          stream.write(connectFrame(cursorExecPiEdit("host.txt", [{ oldText: "alpha", newText: "beta" }], 1, "host-edit-exec")));
          continue;
        }
        if (message.message.case === "execClientMessage" && message.message.value.message.case === "piEditResult") {
          stream.write(connectFrame(cursorInteraction("turnEnded", create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }))));
          finished?.();
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  let api;
  const observer = (pi) => { api = pi; };
  const { session } = await bindCursorSession(t, { cwd, agentDir, tools: ["read"], baseUrl, observer, rotationName: "host" });
  await waitFor(session.prompt("write then edit without exposing those tools"), "host mutation turn");
  await waitFor(done, "host mutation sequence");
  assert.equal(readFileSync(join(cwd, "host.txt"), "utf8"), "beta\n");
  const active = api.getActiveTools();
  assert.equal(active.includes("write"), false, "write stays model-hidden");
  assert.equal(active.includes("edit"), false, "edit stays model-hidden");
  await assert.rejects(
    api.executeTool("write", { path: "host.txt", content: "nope" }),
    /inactive|Unknown tool|not available/i,
  );
  const writeWire = clientMessages.find((message) => message.message.case === "execClientMessage" && message.message.value.message.case === "writeResult");
  const editWire = clientMessages.find((message) => message.message.case === "execClientMessage" && message.message.value.message.case === "piEditResult");
  assert.equal(writeWire.message.value.message.value.result.case, "success");
  assert.equal(editWire.message.value.message.value.result.case, "success");
});

test("Cursor exec write and bash on a child-like session with shared ModelRuntime stay in the child cwd", async (t) => {
  const parentCwd = join(scratchRoot, "child-parent-cwd");
  const childCwd = join(scratchRoot, "child-session-cwd");
  const parentAgent = join(scratchRoot, "child-parent-agent");
  const childAgent = join(scratchRoot, "child-session-agent");
  const sharedAgentDir = join(scratchRoot, "child-shared-agent");
  mkdirSync(parentCwd, { recursive: true });
  mkdirSync(sharedAgentDir, { recursive: true });
  writeFakeCursorAuth(sharedAgentDir, "child-shared");
  writeFileSync(join(parentCwd, "parent-only.txt"), "parent\n");
  let requestIndex = 0;
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let buffer = Buffer.alloc(0);
    let sent = false;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const message = fromBinary(proto.AgentClientMessageSchema, buffer.subarray(5, 5 + length));
        buffer = buffer.subarray(5 + length);
        if (message.message.case === "runRequest" && !sent) {
          sent = true;
          requestIndex += 1;
          if (requestIndex === 1) {
            stream.write(connectFrame(cursorExecWrite("cursor-child.txt", "from-child\n", "child-write-1", 1, "child-write-exec")));
          } else {
            stream.write(connectFrame(cursorExecShell("pwd > cursor-bash-cwd.txt && pwd", "", "child-bash-1", 2, "child-bash-exec")));
          }
          continue;
        }
        if (message.message.case === "execClientMessage") {
          stream.write(connectFrame(cursorInteraction("turnEnded", create(proto.TurnEndedUpdateSchema, { inputTokens: 1n, outputTokens: 1n }))));
        }
      }
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const sharedRuntime = await sdk.ModelRuntime.create({
    authPath: join(sharedAgentDir, "auth.json"),
    modelsPath: join(sharedAgentDir, "models.json"),
  });
  await bindCursorSession(t, { cwd: parentCwd, agentDir: parentAgent, tools: ["read", "bash"], baseUrl, modelRuntime: sharedRuntime, rotationName: "child-parent" });
  const child = await bindCursorSession(t, { cwd: childCwd, agentDir: childAgent, tools: ["read", "bash"], baseUrl, modelRuntime: sharedRuntime, rotationName: "child-session" });
  await waitFor(child.session.prompt("write in the child cwd"), "child write turn");
  assert.equal(readFileSync(join(childCwd, "cursor-child.txt"), "utf8"), "from-child\n");
  assert.equal(existsSync(join(parentCwd, "cursor-child.txt")), false);
  await waitFor(child.session.prompt("bash pwd in the child cwd"), "child bash turn");
  const bashCwd = readFileSync(join(childCwd, "cursor-bash-cwd.txt"), "utf8").trim();
  assert.equal(existsSync(join(parentCwd, "cursor-bash-cwd.txt")), false);
  assert.ok(bashCwd.endsWith("child-session-cwd"), bashCwd);
});
