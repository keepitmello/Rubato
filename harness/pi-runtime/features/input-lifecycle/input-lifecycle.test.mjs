import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const pristinePackage =
  process.env.PI_INPUT_LIFECYCLE_TEST_PACKAGE ??
  resolvePiRuntime({ root: runtimeRoot }).codingAgentDir;
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-pi-input-lifecycle-"));
const patchedPackage = join(scratchRoot, "pi-coding-agent");

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function withoutNodeOptions(env) {
  const copy = { ...env };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function preparePatchedPackage() {
  mkdirSync(patchedPackage, { recursive: true });
  cpSync(join(pristinePackage, "dist"), join(patchedPackage, "dist"), { recursive: true });
  copyFileSync(join(pristinePackage, "package.json"), join(patchedPackage, "package.json"));
  symlinkSync(join(pristinePackage, "node_modules"), join(patchedPackage, "node_modules"), "dir");
  for (const file of files) {
    const target = join(patchedPackage, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourcePath, target);
  }
  for (const spec of patches) {
    const target = join(patchedPackage, spec.path);
    const source = readFileSync(target, "utf8");
    assert.equal(sha256(source), spec.preimageSha256, `${spec.path} pristine hash`);
    writeFileSync(target, spec.apply(source));
  }
}

preparePatchedPackage();

test("manifest is stock-locked, additive, drift-strict, and syntactically valid", () => {
  assert.equal(patches.length, 6);
  assert.deepEqual(files.map((file) => file.path), [
    "dist/rubato-features/input-lifecycle/state.mjs",
  ]);
  assert.equal(new Set(patches.map((patch) => patch.id)).size, patches.length);
  for (const spec of patches) {
    assert.equal(spec.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(spec.version, "0.85.1");
    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256);
    const output = spec.apply(pristine);
    assert.notEqual(output, pristine);
    assert.throws(() => spec.apply(output), /expected anchor is missing/);
  }
  for (const path of [
    "dist/core/agent-session.js",
    "dist/core/extensions/runner.js",
    files[0].path,
  ]) {
    const syntax = spawnSync(process.execPath, ["--check", join(patchedPackage, path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("actual SDK assigns one disposition and preserves duplicate queued text/image identity", async () => {
  const moduleUrl = pathToFileURL(join(patchedPackage, "dist/index.js")).href;
  const streamUrl = pathToFileURL(
    join(patchedPackage, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"),
  ).href;
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(moduleUrl);
  const { AssistantMessageEventStream } = await import(streamUrl);
  const cwd = join(scratchRoot, "sdk-cwd");
  const agentDir = join(scratchRoot, "sdk-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "input-test": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "unused-test-key",
          models: [{ id: "fake-model", input: ["text", "image"] }],
        },
      },
    }),
  );

  const observed = { inputs: [], dispositions: [], userMessages: [] };
  const extension = (pi) => {
    pi.on("input", (event) => {
      observed.inputs.push(structuredClone(event));
      if (event.text === "handled") return { action: "handled" };
      return undefined;
    });
    pi.on("input_disposition", (event) => observed.dispositions.push({ ...event }));
    pi.on("message_start", (event) => {
      if (event.message.role === "user") observed.userMessages.push(structuredClone(event.message));
    });
  };
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "input-observer", factory: extension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (stopReason = "stop", extra = {}) => ({
    role: "assistant",
    content: [{ type: "text", text: stopReason }],
    api: "openai-completions",
    provider: "input-test",
    model: "fake-model",
    usage: emptyUsage,
    stopReason,
    timestamp: Date.now(),
    ...extra,
  });
  const completeStream = (message) => {
    const stream = new AssistantMessageEventStream();
    const partial = { ...message, content: [], stopReason: "pending" };
    stream.push({ type: "start", partial });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };

  let providerCalls = 0;
  session.agent.streamFunction = () => {
    providerCalls += 1;
    return completeStream(assistant());
  };

  await session.prompt("handled");
  assert.equal(providerCalls, 0, "handled input never reaches provider stream");

  const selectedModel = session.agent.state.model;
  session.agent.state.model = undefined;
  await assert.rejects(session.prompt("rejected"), /No model selected/);
  session.agent.state.model = selectedModel;
  assert.equal(providerCalls, 0, "rejected input never reaches provider stream");

  await session.prompt("started");
  assert.equal(providerCalls, 1);

  let releaseFirst;
  let signalFirstStarted;
  const firstStarted = new Promise((resolveStarted) => {
    signalFirstStarted = resolveStarted;
  });
  const deliveredContexts = [];
  let queuedStreamCall = 0;
  session.agent.streamFunction = (_model, context) => {
    providerCalls += 1;
    queuedStreamCall += 1;
    deliveredContexts.push(structuredClone(context.messages));
    if (queuedStreamCall !== 1) return completeStream(assistant());
    const stream = new AssistantMessageEventStream();
    const message = assistant();
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    releaseFirst = () => stream.push({ type: "done", reason: "stop", message });
    signalFirstStarted();
    return stream;
  };

  const rootPrompt = session.prompt("root");
  await firstStarted;
  const followImage = { type: "image", data: "follow-image", mimeType: "image/png" };
  const steerImage = { type: "image", data: "steer-image", mimeType: "image/png" };
  await session.prompt("duplicate", {
    source: "rpc",
    streamingBehavior: "followUp",
    images: [followImage],
  });
  await session.prompt("duplicate", {
    source: "interactive",
    streamingBehavior: "steer",
    images: [steerImage],
  });
  assert.deepEqual(session.getFollowUpMessages(), ["duplicate"]);
  assert.deepEqual(session.getSteeringMessages(), ["duplicate"]);
  releaseFirst();
  await rootPrompt;

  const byText = new Map(observed.inputs.map((event) => [
    `${event.text}:${event.source}:${event.streamingBehavior ?? "idle"}`,
    event,
  ]));
  const handledInput = byText.get("handled:interactive:idle");
  const rejectedInput = byText.get("rejected:interactive:idle");
  const startedInput = byText.get("started:interactive:idle");
  const followInput = byText.get("duplicate:rpc:followUp");
  const steerInput = byText.get("duplicate:interactive:steer");
  assert.ok(handledInput && rejectedInput && startedInput && followInput && steerInput);
  assert.notEqual(followInput.inputId, steerInput.inputId);
  assert.equal(followInput.images[0].data, "follow-image");
  assert.equal(steerInput.images[0].data, "steer-image");

  const dispositionFor = (inputId) => observed.dispositions.filter((event) => event.inputId === inputId);
  assert.deepEqual(dispositionFor(handledInput.inputId).map((event) => event.disposition), ["handled"]);
  assert.deepEqual(dispositionFor(rejectedInput.inputId).map((event) => event.disposition), ["rejected"]);
  assert.deepEqual(dispositionFor(startedInput.inputId).map((event) => event.disposition), ["started"]);
  assert.deepEqual(dispositionFor(followInput.inputId).map((event) => event.disposition), ["queued"]);
  assert.deepEqual(dispositionFor(steerInput.inputId).map((event) => event.disposition), ["queued"]);
  assert.equal(new Set(observed.dispositions.map((event) => event.inputId)).size, observed.dispositions.length);

  const duplicateMessages = observed.userMessages.filter((message) =>
    message.content.some((part) => part.type === "text" && part.text === "duplicate"),
  );
  assert.deepEqual(
    duplicateMessages.map((message) => message.content.find((part) => part.type === "image")?.data),
    ["steer-image", "follow-image"],
    "core queue priority is preserved without confusing duplicate text identity",
  );
  assert.equal(deliveredContexts.length, 3, "root, steer, and follow-up each reach the fake stream");
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.deepEqual(session.getFollowUpMessages(), []);
});
