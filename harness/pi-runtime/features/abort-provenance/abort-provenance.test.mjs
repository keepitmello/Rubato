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
  process.env.PI_ABORT_PROVENANCE_TEST_PACKAGE ??
  resolvePiRuntime({ root: runtimeRoot }).codingAgentDir;
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-pi-abort-provenance-"));
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
  assert.equal(patches.length, 5);
  assert.deepEqual(files.map((file) => file.path), [
    "dist/rubato-features/abort-provenance/state.mjs",
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
  for (const path of ["dist/core/agent-session.js", files[0].path]) {
    const syntax = spawnSync(process.execPath, ["--check", join(patchedPackage, path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("actual SDK emits one abort terminal across user/provider runs and retry/compaction gaps", async () => {
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
        "abort-test": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "unused-test-key",
          models: [{ id: "fake-model" }],
        },
      },
    }),
  );

  const extensionAgentEnds = [];
  const extensionSessionAborts = [];
  let blockNextAgentEnd = false;
  let signalAgentEndEntered;
  let releaseAgentEnd;
  const extension = (pi) => {
    pi.on("agent_end", async (event) => {
      extensionAgentEnds.push(event);
      if (blockNextAgentEnd) {
        blockNextAgentEnd = false;
        signalAgentEndEntered();
        await new Promise((resolveRelease) => {
          releaseAgentEnd = resolveRelease;
        });
      }
    });
    pi.on("session_abort", async (event) => {
      extensionSessionAborts.push(event);
      await Promise.resolve();
    });
  };
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "abort-observer", factory: extension }],
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
  const sessionAgentEnds = [];
  const sessionAborts = [];
  session.subscribe((event) => {
    if (event.type === "agent_end") sessionAgentEnds.push(event);
    if (event.type === "session_abort") sessionAborts.push(event);
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
    provider: "abort-test",
    model: "fake-model",
    usage: emptyUsage,
    stopReason,
    timestamp: Date.now(),
    ...extra,
  });
  const terminalStream = (message) => {
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
    else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    return stream;
  };

  let signalActiveStream;
  const activeStreamStarted = new Promise((resolveStarted) => {
    signalActiveStream = resolveStarted;
  });
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    const pending = assistant("pending", { content: [] });
    stream.push({ type: "start", partial: pending });
    options.signal.addEventListener("abort", () => {
      const aborted = assistant("aborted", { errorMessage: "user aborted fake stream" });
      stream.push({ type: "error", reason: "aborted", error: aborted });
    }, { once: true });
    signalActiveStream();
    return stream;
  };
  const activePrompt = session.prompt("active-user-abort");
  await activeStreamStarted;
  await session.abort();
  await activePrompt;
  assert.equal(extensionSessionAborts.length, 0);
  assert.equal(extensionAgentEnds.length, 1);
  assert.equal(extensionAgentEnds[0].aborted, true);
  assert.equal(extensionAgentEnds[0].abortSource, "user");
  assert.equal(extensionAgentEnds[0].willRetry, false);
  assert.strictEqual(extensionAgentEnds[0], sessionAgentEnds[0]);

  let signalSystemStream;
  const systemStreamStarted = new Promise((resolveStarted) => {
    signalSystemStream = resolveStarted;
  });
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    const pending = assistant("pending", { content: [] });
    stream.push({ type: "start", partial: pending });
    options.signal.addEventListener("abort", () => {
      const aborted = assistant("aborted", { errorMessage: "system aborted fake stream" });
      stream.push({ type: "error", reason: "aborted", error: aborted });
    }, { once: true });
    signalSystemStream();
    return stream;
  };
  const systemPrompt = session.prompt("active-system-abort");
  await systemStreamStarted;
  await session.abort("system");
  await systemPrompt;
  assert.equal(extensionSessionAborts.length, 0);
  assert.equal(extensionAgentEnds.length, 2);
  assert.equal(extensionAgentEnds[1].aborted, true);
  assert.equal(extensionAgentEnds[1].abortSource, "system");
  assert.strictEqual(extensionAgentEnds[1], sessionAgentEnds[1]);

  session.agent.streamFunction = () => terminalStream(
    assistant("aborted", { abortSource: "provider", errorMessage: "provider stopped" }),
  );
  await session.prompt("provider-abort");
  assert.equal(extensionSessionAborts.length, 0);
  assert.equal(extensionAgentEnds.length, 3);
  assert.equal(extensionAgentEnds[2].aborted, true);
  assert.equal(extensionAgentEnds[2].abortSource, "provider");
  assert.strictEqual(extensionAgentEnds[2], sessionAgentEnds[2]);

  let signalBoundaryEntered;
  const boundaryEntered = new Promise((resolveEntered) => {
    signalBoundaryEntered = resolveEntered;
  });
  blockNextAgentEnd = true;
  signalAgentEndEntered = signalBoundaryEntered;
  session.agent.streamFunction = () => terminalStream(assistant("stop"));
  const boundaryPrompt = session.prompt("late-user-join");
  await boundaryEntered;
  const boundaryAbort = session.abort();
  releaseAgentEnd();
  await Promise.all([boundaryPrompt, boundaryAbort]);
  assert.equal(extensionSessionAborts.length, 0);
  assert.equal(extensionAgentEnds.length, 4);
  assert.equal(extensionAgentEnds[3].aborted, true);
  assert.equal(extensionAgentEnds[3].abortSource, "user");
  assert.strictEqual(extensionAgentEnds[3], sessionAgentEnds[3]);

  const originalRetrySettings = settingsManager.getRetrySettings.bind(settingsManager);
  settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 2, baseDelayMs: 60_000 });
  let signalRetryGap;
  const retryGap = new Promise((resolveGap) => {
    signalRetryGap = resolveGap;
  });
  const unsubscribeRetry = session.subscribe((event) => {
    if (event.type === "auto_retry_start") signalRetryGap();
  });
  session.agent.streamFunction = () => terminalStream(
    assistant("error", { errorMessage: "429 rate limit in offline fake" }),
  );
  const retryPrompt = session.prompt("retry-gap");
  await retryGap;
  await session.abort();
  await retryPrompt;
  unsubscribeRetry();
  settingsManager.getRetrySettings = originalRetrySettings;
  assert.equal(extensionSessionAborts.length, 1);
  assert.strictEqual(extensionSessionAborts[0], sessionAborts[0]);
  const retryEnd = extensionAgentEnds[4];
  assert.equal(retryEnd.willRetry, true);
  assert.equal(retryEnd.aborted, undefined);

  session._compactionAbortController = new AbortController();
  const compactionAbort = session.abort();
  queueMicrotask(() => session._clearManualCompactionState());
  await compactionAbort;
  assert.equal(extensionSessionAborts.length, 2);
  assert.strictEqual(extensionSessionAborts[1], sessionAborts[1]);

  await session.followUp("queued-only");
  assert.equal(session.pendingMessageCount, 1);
  session.clearQueue({ abortWillFollow: true });
  await Promise.all([session.abort(), session.abort()]);
  assert.equal(extensionSessionAborts.length, 3, "concurrent gap aborts claim one terminal event");
  assert.strictEqual(extensionSessionAborts[2], sessionAborts[2]);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(
    extensionAgentEnds.filter((event) => event.abortSource === "user").length,
    2,
    "only active and late-boundary user aborts use agent_end",
  );
});
