import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { patches as reloadPatches } from "../reload/patches.mjs";
import { files as inputFiles, patches as inputPatches } from "../input-lifecycle/patches.mjs";
import { files as abortFiles, patches as abortPatches } from "../abort-provenance/patches.mjs";
import { files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const pristinePackage =
  process.env.PI_REQUEST_RUN_TEST_PACKAGE ??
  resolvePiRuntime({ root: runtimeRoot }).codingAgentDir;
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-pi-request-run-"));
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
  const additions = [...inputFiles, ...abortFiles, ...files];
  for (const file of additions) {
    const target = join(patchedPackage, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourcePath, target);
  }
  for (const spec of [...reloadPatches, ...inputPatches, ...abortPatches, ...patches]) {
    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256, `${spec.path} pristine hash`);
    const target = join(patchedPackage, spec.path);
    writeFileSync(target, spec.apply(readFileSync(target, "utf8")));
  }
}

preparePatchedPackage();

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "request-run-test",
    model: "fake-model",
    usage: emptyUsage,
    stopReason,
    timestamp: Date.now(),
    ...extra,
  };
}

function jsonLineChannel(child) {
  const bus = new EventEmitter();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline === -1) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        bus.emit("record", JSON.parse(line));
      }
      catch (error) {
        bus.emit("parse-error", new Error(`${error.message}: ${line}`));
      }
    }
  });
  // Spawning the child runtime is fast locally but can stall on a busy runner.
  const waitFor = (predicate, timeoutMs = 15_000) => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RPC record timed out; stderr=${stderr}`));
    }, timeoutMs);
    const onRecord = (record) => {
      if (!predicate(record)) return;
      cleanup();
      resolveWait(record);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`RPC exited ${code ?? signal}; stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      bus.off("record", onRecord);
      bus.off("parse-error", onError);
      child.off("exit", onExit);
    };
    bus.on("record", onRecord);
    bus.on("parse-error", onError);
    child.on("exit", onExit);
  });
  return {
    waitFor,
    waitForResponse: (id) => waitFor((record) => record.type === "response" && record.id === id),
    stderr: () => stderr,
  };
}

test("manifest reuses the current Rubato tracker and composes strict stock patches", () => {
  assert.equal(patches.length, 4);
  assert.deepEqual(files.map((file) => file.path), [
    "dist/rubato-features/request-run/request-run-tracker.mjs",
    "dist/rubato-features/request-run/assistant-phase.mjs",
  ]);
  assert.match(files[0].sourcePath, /harness\/rubato-pi\/src\/transforms\/request-run-tracker\.mjs$/);
  assert.match(files[1].sourcePath, /harness\/rubato-pi\/src\/transforms\/assistant-phase\.mjs$/);
  assert.equal(new Set(patches.map((patch) => patch.id)).size, patches.length);
  for (const spec of patches) {
    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    assert.equal(spec.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(spec.version, "0.85.1");
    assert.equal(sha256(pristine), spec.preimageSha256);
    const composed = readFileSync(join(patchedPackage, spec.path), "utf8");
    assert.notEqual(composed, pristine);
    assert.throws(() => spec.apply(composed), /expected anchor is missing/);
  }
  for (const path of [
    "dist/core/agent-session.js",
    "dist/modes/rpc/rpc-mode.js",
    ...files.map((file) => file.path),
  ]) {
    const syntax = spawnSync(process.execPath, ["--check", join(patchedPackage, path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("actual SDK keeps input identity and one request terminal across queue, clear, reload, retry, and abort", async () => {
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
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "request-run-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: "fake-model", input: ["text", "image"] }],
      },
    },
  }));

  const inputs = [];
  const terminalSnapshots = [];
  const extension = (pi) => {
    pi.on("input", (event) => {
      inputs.push(structuredClone(event));
      return undefined;
    });
    for (const name of ["agent_end", "agent_settled", "session_abort"]) {
      pi.on(name, () => {
        const snapshot = session?.requestTimelineSnapshot();
        if (snapshot) terminalSnapshots.push({ name, snapshot: structuredClone(snapshot) });
      });
    }
  };
  const settingsManager = SettingsManager.inMemory();
  let retrySettings = { enabled: false, maxRetries: 0, baseDelayMs: 1 };
  settingsManager.getRetrySettings = () => retrySettings;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "request-run-observer", factory: extension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  let session;
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  }));

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
  const controlledStream = () => {
    let release;
    let started;
    const didStart = new Promise((resolveStart) => {
      started = resolveStart;
    });
    const streamFunction = (_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      const pending = assistant("pending", "pending", { content: [] });
      stream.push({ type: "start", partial: pending });
      let closed = false;
      release = () => {
        if (closed) return;
        closed = true;
        stream.push({ type: "done", reason: "stop", message: assistant("done") });
      };
      options.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: assistant("aborted", "aborted", { errorMessage: "offline abort" }),
        });
      }, { once: true });
      started();
      return stream;
    };
    return { didStart, release: () => release(), streamFunction };
  };

  let call = 0;
  const queueGate = controlledStream();
  session.agent.streamFunction = (...args) => {
    call += 1;
    return call === 1 ? queueGate.streamFunction(...args) : terminalStream(assistant(`done-${call}`));
  };
  const queueRoot = session.prompt("duplicate", { source: "interactive" });
  await queueGate.didStart;
  const followImage = { type: "image", data: "follow-image", mimeType: "image/png" };
  const steerImage = { type: "image", data: "steer-image", mimeType: "image/png" };
  await session.prompt("duplicate", { source: "rpc", streamingBehavior: "followUp", images: [followImage] });
  await session.prompt("duplicate", { source: "interactive", streamingBehavior: "steer", images: [steerImage] });
  const queued = session.requestTimelineSnapshot();
  assert.equal(queued.pendingInputs.length, 2);
  assert.deepEqual(queued.pendingInputs.map((input) => input.imageCount), [1, 1]);
  assert.deepEqual(queued.pendingInputs.map((input) => input.source), ["remote", "tui"]);
  const queueInputs = inputs.slice(-3);
  assert.equal(queued.activeRequestRunId, queueInputs[0].inputId);
  assert.deepEqual(queued.pendingInputs.map((input) => input.id), [queueInputs[1].inputId, queueInputs[2].inputId]);
  queueGate.release();
  await queueRoot;
  const afterQueue = session.requestTimelineSnapshot();
  assert.deepEqual(afterQueue.pendingInputs, []);
  assert.equal(afterQueue.runs.at(-2).id, queueInputs[0].inputId);
  assert.equal(afterQueue.runs.at(-2).status, "completed");
  assert.equal(afterQueue.runs.at(-2).steeringCount, 1);
  assert.equal(afterQueue.runs.at(-1).id, queueInputs[1].inputId);
  assert.equal(afterQueue.runs.at(-1).status, "completed");
  const page = session.readConversationPage({ limit: 100 });
  const queuedUsers = page.entries.filter((entry) => entry.role === "user").slice(-3);
  assert.deepEqual(queuedUsers.map((entry) => entry.inputId), [
    queueInputs[0].inputId,
    queueInputs[2].inputId,
    queueInputs[1].inputId,
  ]);

  const clearGate = controlledStream();
  session.agent.streamFunction = clearGate.streamFunction;
  const clearRoot = session.prompt("clear-root");
  await clearGate.didStart;
  await session.prompt("clear-queued", { streamingBehavior: "followUp", images: [followImage] });
  const clearIds = session.requestTimelineSnapshot().pendingInputs.map((input) => input.id);
  assert.equal(clearIds.length, 1);
  assert.deepEqual(session.clearPendingInteractiveInputs(), { clearedIds: clearIds });
  assert.deepEqual(session.requestTimelineSnapshot().pendingInputs, []);
  await session.abort();
  await clearRoot;
  const interrupted = session.requestTimelineSnapshot().runs.at(-1);
  assert.equal(interrupted.status, "interrupted");
  const interruptedCompletedAt = interrupted.completedAt;

  const reloadGate = controlledStream();
  session.agent.streamFunction = reloadGate.streamFunction;
  const reloadPrompt = session.prompt("reload-root");
  await reloadGate.didStart;
  assert.deepEqual(await session.reload(), { cancelled: false });
  reloadGate.release();
  await reloadPrompt;
  assert.equal(session.requestTimelineSnapshot().runs.at(-1).status, "completed");

  retrySettings = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
  let retryCalls = 0;
  session.agent.streamFunction = () => {
    retryCalls += 1;
    return retryCalls === 1
      ? terminalStream(assistant("429", "error", { errorMessage: "429 rate limit in offline fake" }))
      : terminalStream(assistant("retry recovered"));
  };
  const retryInputStart = inputs.length;
  await session.prompt("retry-root");
  assert.equal(retryCalls, 2);
  const retryRun = session.requestTimelineSnapshot().runs.at(-1);
  assert.equal(retryRun.id, inputs[retryInputStart].inputId);
  assert.equal(retryRun.status, "completed");

  retrySettings = { enabled: false, maxRetries: 0, baseDelayMs: 1 };
  const failedInputStart = inputs.length;
  session.agent.streamFunction = () => terminalStream(
    assistant("fatal", "error", { errorMessage: "offline fatal" }),
  );
  await session.prompt("failed-root");
  const failedRun = session.requestTimelineSnapshot().runs.at(-1);
  assert.equal(failedRun.id, inputs[failedInputStart].inputId);
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.failureMessage, "offline fatal");

  const firstInterrupted = session.requestTimelineSnapshot().runs.find((run) => run.id === interrupted.id);
  assert.equal(firstInterrupted.status, "interrupted");
  assert.equal(firstInterrupted.completedAt, interruptedCompletedAt, "later settled/reload/retry cannot re-terminalize an abort");
  assert.equal(terminalSnapshots.some(({ snapshot }) => snapshot.runs.some((run) => run.status === "failed")), true);
});

test("unbundled RPC get_state reads the same pending and completed request ids", async (t) => {
  const cwd = join(scratchRoot, "rpc-cwd");
  const agentDir = join(scratchRoot, "rpc-agent");
  const sessionDir = join(scratchRoot, "rpc-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const streamUrl = pathToFileURL(
    join(patchedPackage, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"),
  ).href;
  const extensionPath = join(scratchRoot, "rpc-request-run-provider.mjs");
  writeFileSync(extensionPath, `
import { AssistantMessageEventStream } from ${JSON.stringify(streamUrl)};
const usage = ${JSON.stringify(emptyUsage)};
export default function requestRunProvider(pi) {
  pi.registerProvider("request-run-rpc", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "unused-test-key",
    models: [{ id: "fake-model", input: ["text", "image"] }],
    streamSimple(model) {
      const stream = new AssistantMessageEventStream();
      const base = { role: "assistant", api: "openai-completions", provider: "request-run-rpc", model: model.id, usage, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...base, content: [], stopReason: "pending" } });
      setTimeout(() => stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: "offline rpc done" }], stopReason: "stop" } }), 150);
      return stream;
    },
  });
  pi.on("input", () => undefined);
}
`);
  const child = spawn(process.execPath, [
    join(patchedPackage, "dist/rpc-entry.js"),
    "--offline",
    "--approve",
    "--provider", "request-run-rpc",
    "--model", "fake-model",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--session-dir", sessionDir,
    "--extension", extensionPath,
  ], {
    cwd,
    env: {
      ...withoutNodeOptions(process.env),
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = jsonLineChannel(child);
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const firstPrompt = channel.waitForResponse("prompt-1");
  child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "same rpc" })}\n`);
  assert.equal((await firstPrompt).success, true);
  await channel.waitFor((record) => record.type === "message_start" && record.message?.role === "user");

  const secondPrompt = channel.waitForResponse("prompt-2");
  child.stdin.write(`${JSON.stringify({
    id: "prompt-2",
    type: "prompt",
    message: "same rpc",
    streamingBehavior: "followUp",
    images: [{ type: "image", data: "rpc-image", mimeType: "image/png" }],
  })}\n`);
  assert.equal((await secondPrompt).success, true);

  const pendingResponse = channel.waitForResponse("state-pending");
  child.stdin.write(`${JSON.stringify({ id: "state-pending", type: "get_state" })}\n`);
  const pending = (await pendingResponse).data.requestTimeline;
  assert.equal(pending.runs.length, 1);
  assert.equal(pending.activeRequestRunId, pending.runs[0].id);
  assert.equal(pending.pendingInputs.length, 1);
  assert.equal(pending.pendingInputs[0].imageCount, 1);
  const pendingId = pending.pendingInputs[0].id;

  await channel.waitFor((record) => record.type === "agent_settled", 8_000);
  const settledResponse = channel.waitForResponse("state-settled");
  child.stdin.write(`${JSON.stringify({ id: "state-settled", type: "get_state" })}\n`);
  const settled = (await settledResponse).data.requestTimeline;
  assert.equal(settled.pendingInputs.length, 0);
  assert.equal(settled.activeRequestRunId, undefined);
  assert.equal(settled.runs.length, 2);
  assert.equal(settled.runs[0].id, pending.runs[0].id);
  assert.equal(settled.runs[1].id, pendingId);
  assert.deepEqual(settled.runs.map((run) => run.status), ["completed", "completed"]);
});
