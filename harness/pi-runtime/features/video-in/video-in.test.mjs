import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { modelSupportsVideo, omitUnsupportedVideoMessages, videoOmissionPlaceholder } from "./src/capability.mjs";
import { feature, files, patchAnthropicMessagesVideo } from "./patches.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLIP = Buffer.from("fake-mp4-bytes");

function textOf(result) {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function findVideoBlocks(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) findVideoBlocks(entry, found);
    return found;
  }
  if (value && typeof value === "object") {
    if (value.type === "video") found.push(value);
    for (const entry of Object.values(value)) findVideoBlocks(entry, found);
  }
  return found;
}

function usage() {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("owned registry treats Senpi k3 as video-capable even when stock input is text,image", () => {
  assert.equal(modelSupportsVideo({ provider: "kimi-coding", id: "k3", input: ["text", "image"] }), true);
  assert.equal(modelSupportsVideo({ provider: "kimi-coding", id: "k3-256k", input: ["text", "image"] }), false);
  assert.equal(modelSupportsVideo({ provider: "kimi-coding", id: "k3" }), true);
  assert.equal(modelSupportsVideo({ provider: "openai", id: "gpt-5.4", input: ["text", "image"] }), false);
  assert.equal(modelSupportsVideo({ provider: "fixture", id: "custom", input: ["text", "image", "video"] }), true);
  assert.equal(modelSupportsVideo({ provider: "fixture", id: "text", input: ["text"] }), false);
  assert.equal(modelSupportsVideo(undefined), false);
});

test("unsupported models drop video ImageContent for a text placeholder without mutating the original", () => {
  const original = [
    { role: "user", content: "watch this", timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_video",
      content: [
        { type: "text", text: "attached" },
        { type: "image", data: CLIP.toString("base64"), mimeType: "video/mp4" },
        { type: "image", data: "aaaa", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 2,
    },
  ];
  const snapshot = structuredClone(original);
  const kept = omitUnsupportedVideoMessages(original, { provider: "kimi-coding", id: "k3", input: ["text", "image"] });
  assert.equal(kept, original);
  const omitted = omitUnsupportedVideoMessages(original, { provider: "openai", id: "gpt-5.4", input: ["text", "image"] });
  assert.notEqual(omitted, original);
  assert.deepEqual(original, snapshot);
  assert.equal(omitted[1].content[1].type, "text");
  assert.equal(omitted[1].content[1].text, videoOmissionPlaceholder("video/mp4", CLIP.toString("base64")));
  assert.equal(omitted[1].content[2].mimeType, "image/png");
  assert.equal(JSON.stringify(omitted).includes("video/mp4"), true);
  assert.equal(omitted[1].content.some((block) => block.type === "image" && block.mimeType?.startsWith("video/")), false);
});

test("stock anthropic-messages patch rewrites video/* ImageContent to type video", () => {
  const stockPath = join(
    runtimeRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
  );
  const patched = patchAnthropicMessagesVideo(readFileSync(stockPath, "utf8"));
  assert.match(patched, /type: "video"/);
  assert.equal(patched.includes('media_type: block.mimeType'), true);
  assert.equal(patched.includes('media_type: item.mimeType'), true);
});

test("rubato-features.json disables the rubato-video-in factory by name", async () => {
  const bootstrap = readFileSync(new URL("../rubato-components/bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /name: "rubato-video-in"/);
  const agentDir = mkdtempSync(join(tmpdir(), "rubato-video-in-toggle-"));
  try {
    writeFileSync(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: ["rubato-video-in"] }));
    const disabled = readDisabledFeatures({ agentDir, env: {} });
    const result = applyFeatureToggles(
      [{ name: "media-tools" }, { name: "rubato-video-in" }, { name: "codemode" }],
      disabled,
    );
    assert.deepEqual(result.extensionFactories.map((entry) => entry.name), ["media-tools", "codemode"]);
    assert.deepEqual(result.disabled, ["rubato-video-in"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("staged stock SDK gates read_video, validates local files, and puts a video block on the Anthropic payload", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "rubato-video-in-"));
  let session;
  t.after(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
      session.dispose();
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  const outputRoot = join(scratch, "engine");
  const staged = await stagePiRuntime({
    sourceRoot: runtimeRoot,
    outputRoot,
    features: [toolExecutionFeature, feature],
  });
  const videoFiles = staged.receipt.addedFiles.filter((entry) => entry.feature === "video-in");
  assert.equal(videoFiles.length, files.length);
  assert.equal(videoFiles.every((entry) => entry.path.startsWith("rubato-features/video-in/")), true);

  const stagedEntry = join(outputRoot, "rubato-features/video-in/src/index.mjs");
  const sdk = await import(pathToFileURL(staged.runtime.sdkEntry).href);
  const videoIn = await import(pathToFileURL(stagedEntry).href);
  const anthropicMessages = await import(pathToFileURL(join(
    outputRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
  )).href);
  const openaiCompletions = await import(pathToFileURL(join(
    outputRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
  )).href);

  const cwd = join(scratch, "project");
  const agentDir = join(scratch, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const clipPath = join(cwd, "clip.mp4");
  writeFileSync(clipPath, CLIP);
  writeFileSync(join(cwd, "empty.mp4"), Buffer.alloc(0));
  writeFileSync(join(cwd, "notes.txt"), "not a video");
  mkdirSync(join(cwd, "folder.mp4"));
  const oversizedPath = join(cwd, "huge.mp4");
  const oversizedFd = openSync(oversizedPath, "w");
  ftruncateSync(oversizedFd, 100 * 1024 * 1024 + 1);
  closeSync(oversizedFd);

  const baseModel = {
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:9",
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 4_096,
  };
  const k3Model = {
    ...baseModel,
    provider: "kimi-coding",
    id: "k3",
    name: "Kimi K3 fixture",
    input: ["text", "image"],
    compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
  };
  const textModel = {
    ...baseModel,
    provider: "kimi-coding",
    id: "k3-256k",
    name: "Text fixture",
    input: ["text", "image"],
  };
  const overlayModel = {
    ...baseModel,
    provider: "rubato-video-fixture",
    id: "custom-video",
    name: "Overlay video fixture",
    input: ["text", "image", "video"],
  };

  let extensionApi;
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      {
        name: "rubato-video-in",
        factory: (pi) => {
          extensionApi = pi;
          pi.registerProvider("kimi-coding", {
            name: "Kimi fixture",
            baseUrl: k3Model.baseUrl,
            apiKey: "kimi-fixture-not-a-real-key",
            api: k3Model.api,
            models: [k3Model, textModel],
          });
          pi.registerProvider("rubato-video-fixture", {
            name: "Video overlay fixture",
            baseUrl: overlayModel.baseUrl,
            apiKey: "video-fixture-not-a-real-key",
            api: overlayModel.api,
            models: [overlayModel],
          });
          videoIn.default(pi);
        },
      },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: k3Model,
  }));
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(extensionErrors, []);
  assert.equal(typeof session.getToolDefinition("read_video")?.execute, "function");
  assert.equal(session.getActiveToolNames().includes("read_video"), true);

  const read = await extensionApi.executeTool("read_video", { path: "clip.mp4" });
  assert.equal(read.isError, false);
  assert.match(textOf(read), /clip\.mp4/);
  const attached = read.content.find((part) => part.type === "image");
  assert.equal(attached.mimeType, "video/mp4");
  assert.equal(attached.data, CLIP.toString("base64"));

  const unsupported = await extensionApi.executeTool("read_video", { path: "notes.txt" });
  assert.equal(unsupported.isError, true);
  assert.match(textOf(unsupported), /not a supported video file/);

  const directory = await extensionApi.executeTool("read_video", { path: "folder.mp4" });
  assert.equal(directory.isError, true);
  assert.match(textOf(directory), /not a regular file/);

  const empty = await extensionApi.executeTool("read_video", { path: "empty.mp4" });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /is empty/);

  const oversized = await extensionApi.executeTool("read_video", { path: "huge.mp4" });
  assert.equal(oversized.isError, true);
  assert.match(textOf(oversized), /exceeds the maximum 100MB/);

  const beforeAbort = new AbortController();
  beforeAbort.abort();
  const abortedBefore = await extensionApi.executeTool("read_video", { path: "clip.mp4" }, { signal: beforeAbort.signal });
  assert.equal(abortedBefore.isError, true);
  assert.match(textOf(abortedBefore), /aborted/);

  const afterAbort = new AbortController();
  const pendingAfter = session.getToolDefinition("read_video").execute(
    "abort-after-read",
    { path: "clip.mp4" },
    afterAbort.signal,
    undefined,
    { cwd, model: k3Model },
  );
  afterAbort.abort();
  await assert.rejects(pendingAfter, /aborted/);

  await session.setModel(textModel);
  assert.equal(session.getActiveToolNames().includes("read_video"), false);
  await assert.rejects(
    () => extensionApi.executeTool("read_video", { path: "clip.mp4" }),
    /inactive/i,
  );
  await assert.rejects(
    () => session.getToolDefinition("read_video").execute(
      "refuse-non-video",
      { path: "clip.mp4" },
      undefined,
      undefined,
      { cwd, model: textModel },
    ),
    /does not support video input/,
  );

  await session.setModel(overlayModel);
  assert.equal(session.getActiveToolNames().includes("read_video"), true);

  let captured;
  const streamed = anthropicMessages.stream(k3Model, {
    systemPrompt: "A10 payload probe",
    tools: [],
    messages: [
      { role: "user", content: "watch this clip", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-clip", name: "read_video", arguments: { path: "clip.mp4" } }],
        api: "anthropic-messages",
        provider: "kimi-coding",
        model: "k3",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-clip",
        toolName: "read_video",
        content: read.content,
        isError: false,
        timestamp: 3,
      },
    ],
  }, {
    apiKey: "kimi-fixture-not-a-real-key",
    onPayload: (params) => {
      captured = params;
      throw new Error("A10 stop-after-payload");
    },
  });
  const streamedResult = await streamed.result();
  assert.match(streamedResult.errorMessage ?? "", /A10 stop-after-payload/);
  const videoBlocks = findVideoBlocks(captured);
  const fragment = videoBlocks.map((block) => ({
    type: block.type,
    source: { type: block.source?.type, media_type: block.source?.media_type, dataChars: block.source?.data?.length },
  }));
  console.log("A10 video payload fragment:", JSON.stringify(fragment));
  assert.equal(videoBlocks.length >= 1, true, `expected a video block in payload, got ${JSON.stringify(fragment)}`);
  assert.equal(videoBlocks[0].type, "video");
  assert.equal(videoBlocks[0].source.type, "base64");
  assert.equal(videoBlocks[0].source.media_type, "video/mp4");
  assert.equal(videoBlocks[0].source.data, CLIP.toString("base64"));

  const history = [
    { role: "user", content: "watch this clip", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-clip", name: "read_video", arguments: { path: "clip.mp4" } }],
      api: "anthropic-messages",
      provider: "kimi-coding",
      model: "k3",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-clip",
      toolName: "read_video",
      content: read.content,
      isError: false,
      timestamp: 3,
    },
  ];
  await session.setModel(textModel);
  const transformed = await session.extensionRunner.emitContext(history);
  const placeholder = videoOmissionPlaceholder("video/mp4", CLIP.toString("base64"));
  assert.equal(JSON.stringify(transformed).includes(placeholder), true);
  assert.equal(transformed[2].content.some((block) => block.type === "image" && block.mimeType?.startsWith("video/")), false);
  assert.equal(history[2].content.some((block) => block.type === "image" && block.mimeType === "video/mp4"), true, "session history must keep the original video block");

  let anthropicOmitted;
  const anthropicSwitch = anthropicMessages.stream(textModel, {
    systemPrompt: "A10 omit probe",
    tools: [],
    messages: transformed,
  }, {
    apiKey: "kimi-fixture-not-a-real-key",
    onPayload: (params) => {
      anthropicOmitted = params;
      throw new Error("A10 stop-after-omit");
    },
  });
  const anthropicOmitResult = await anthropicSwitch.result();
  assert.match(anthropicOmitResult.errorMessage ?? "", /A10 stop-after-omit/);
  assert.equal(findVideoBlocks(anthropicOmitted).length, 0);
  assert.equal(JSON.stringify(anthropicOmitted).includes("data:video/"), false);
  assert.equal(JSON.stringify(anthropicOmitted).includes(placeholder), true);

  const openaiVision = {
    ...baseModel,
    provider: "rubato-video-fixture",
    id: "gpt-vision-fixture",
    name: "OpenAI vision fixture",
    api: "openai-completions",
    input: ["text", "image"],
  };
  let openaiOmitted;
  const openaiSwitch = openaiCompletions.stream(openaiVision, {
    systemPrompt: "A10 omit probe",
    tools: [],
    messages: transformed,
  }, {
    apiKey: "openai-fixture-not-a-real-key",
    onPayload: (params) => {
      openaiOmitted = params;
      throw new Error("A10 stop-after-openai-omit");
    },
  });
  const openaiOmitResult = await openaiSwitch.result();
  assert.match(openaiOmitResult.errorMessage ?? "", /A10 stop-after-openai-omit/);
  assert.equal(JSON.stringify(openaiOmitted).includes("data:video/"), false);
  assert.equal(JSON.stringify(openaiOmitted).includes(placeholder), true);
});
