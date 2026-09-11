import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { feature, files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-context-notes-"));
const outputRoot = join(scratch, "engine");

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function assistantMessage(text = "offline done") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "context-notes-test",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function jsonLineChannel(child) {
  const frames = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { frames.push(JSON.parse(line)); }
    catch (error) { frames.push({ type: "invalid-json", line, error: error.message }); }
    for (const wake of waiters) wake();
  });
  const waitFor = (predicate, timeoutMs = 10_000, afterIndex = 0) => new Promise((resolveFrame, reject) => {
    const check = () => {
      const frame = frames.slice(afterIndex).find(predicate);
      if (!frame) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolveFrame(frame);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`RPC fixture timeout; stderr=${stderr}; frames=${JSON.stringify(frames.slice(-8))}`));
    }, timeoutMs);
    waiters.add(check);
    check();
  });
  const request = async (id, type, data = {}) => {
    const start = frames.length;
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return waitFor((frame) => frame.type === "response" && frame.id === id, 10_000, start);
  };
  return { frames, request, waitFor, stderr: () => stderr };
}

const dependencies = await loadPiFeatures(["reload", "session-catalog"]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot,
  features: [...dependencies, feature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)));
const contextExtensionUrl = pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)).href;
const { createContextNotesExtension } = await import(contextExtensionUrl);

function completeStream(captured, context) {
  captured.push({
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
  });
  const message = assistantMessage();
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function writeModels(agentDir) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "context-notes-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{
          id: "fake-model",
          input: ["text", "image"],
          contextWindow: 100_000,
          maxTokens: 4096,
        }],
      },
    },
  }));
}

test("feature is additive-only, stock-version locked, and has a complete source closure", () => {
  assert.equal(feature.id, "context-notes");
  assert.deepEqual(patches, []);
  assert.equal(files.length, 13);
  assert.equal(new Set(files.map((entry) => entry.path)).size, files.length);
  assert.ok(files.every((entry) => entry.packageName === "@earendil-works/pi-coding-agent"));
  assert.ok(files.every((entry) => entry.version === "0.85.1"));
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.equal(staged.receipt.addedFiles.filter((entry) => entry.feature === "context-notes").length, files.length);

  for (const path of files.filter((entry) => entry.path.endsWith(".mjs")).map((entry) => entry.path)) {
    const syntax = spawnSync(process.execPath, ["--check", join(runtime.codingAgentDir, path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${path}: ${syntax.stderr}`);
  }
});

test("actual SDK injects stable history identity and keeps notes through reload and native clone", async (t) => {
  const cwd = join(scratch, "sdk-project");
  const agentDir = join(scratch, "sdk-agent");
  const sessionDir = join(scratch, "sdk-sessions");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);
  writeModels(agentDir);

  const captured = [];
  const extensionErrors = [];
  const uiNotices = [];
  const uiContext = {
    notify(message, level) { uiNotices.push({ message, level }); },
    setStatus() {},
  };
  const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = sdk.SettingsManager.inMemory();
    settingsManager.getCompactionSettings = () => ({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 1,
    });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{
        name: "context-notes",
        factory: createContextNotesExtension({ agentDir: runtimeAgentDir, enabled: true }),
      }],
    });
    await resourceLoader.reload();
    const result = await sdk.createAgentSession({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
      sessionStartEvent,
      model: {
        provider: "context-notes-test",
        id: "fake-model",
        name: "Offline context notes fixture",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 100_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      tools: ["notes_write_file", "notes_read_file"],
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    result.session.agent.streamFunction = (_model, context) => completeStream(captured, context);
    await result.session.bindExtensions({
      mode: "rpc",
      uiContext,
      onError: (error) => extensionErrors.push(error),
    });
    return {
      ...result,
      services: { cwd: runtimeCwd, agentDir: runtimeAgentDir },
      diagnostics: [],
    };
  };

  const sessionManager = sdk.SessionManager.create(cwd, sessionDir, { id: "context-source" });
  const host = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  t.after(async () => host.dispose());
  assert.equal(host.session.hasExtensionHandlers("before_agent_start"), true);
  assert.equal(
    host.session.sessionManager.getEntries().filter((entry) => entry.customType === "rubato.context-window.init.v1").length,
    1,
  );

  await host.session.prompt("remember this exact request");
  assert.equal(captured.length, 1, JSON.stringify({ extensionErrors, messages: host.session.messages }));
  assert.match(captured[0].systemPrompt, /Working across context windows/);
  assert.match(textOf(captured[0].messages[0]), /^<rubato_context_window_v1>/);
  const deliveredUser = captured[0].messages.find((message) => textOf(message).includes("remember this exact request"));
  assert.ok(deliveredUser);
  assert.match(textOf(deliveredUser), /\[history: window_id="[^"]+" item_id="[^"]+"\]/);

  const sourceFile = host.session.sessionFile;
  assert.equal(existsSync(sourceFile), true, "first user turn makes INIT and transcript durable");
  host.session.setActiveToolsByName(["notes_write_file", "notes_read_file"]);
  const writeTool = host.session.agent.state.tools.find((tool) => tool.name === "notes_write_file");
  assert.ok(writeTool, "context note tool is activatable through stock tool registry");
  const writeResult = await writeTool.execute(
    "note-write-1",
    { path: "handoff.md", text: "decision=keep-source-identities" },
    new AbortController().signal,
  );
  assert.match(writeResult.content[0].text, /"path":"handoff.md"/);
  const sourceEntries = host.session.sessionManager.getEntries();
  const noteEntry = sourceEntries.find((entry) => entry.customType === "rubato.context-note.v1");
  assert.equal(noteEntry?.data?.text, "decision=keep-source-identities");
  assert.match(readFileSync(sourceFile, "utf8"), /rubato\.context-note\.v1/);
  assert.equal(readdirSync(join(agentDir, "context-notes")).filter((name) => name.endsWith(".sqlite")).length, 1);

  await assert.rejects(
    host.session.compact("remote-like compaction attempt"),
    /Compaction cancelled/,
    "stock compact path honors context-notes ownership",
  );

  const reloaded = await host.session.reload();
  assert.equal(reloaded.cancelled, false);
  host.session.setActiveToolsByName(["notes_read_file"]);
  const reloadedRead = host.session.agent.state.tools.find((tool) => tool.name === "notes_read_file");
  const reloadedResult = await reloadedRead.execute(
    "note-read-after-reload",
    { path: "handoff.md" },
    new AbortController().signal,
  );
  assert.match(reloadedResult.content[0].text, /decision=keep-source-identities/);

  const sourceSessionId = host.session.sessionId;
  const sourceLeaf = host.session.sessionManager.getLeafId();
  const fork = await host.fork(sourceLeaf, { position: "at" });
  assert.equal(fork.cancelled, false);
  assert.notEqual(host.session.sessionId, sourceSessionId);
  assert.notEqual(host.session.sessionFile, sourceFile);
  host.session.setActiveToolsByName(["notes_read_file"]);
  const clonedRead = host.session.agent.state.tools.find((tool) => tool.name === "notes_read_file");
  const clonedResult = await clonedRead.execute(
    "note-read-after-clone",
    { path: "handoff.md" },
    new AbortController().signal,
  );
  assert.match(clonedResult.content[0].text, /decision=keep-source-identities/);
  assert.equal(
    host.session.sessionManager.getEntries().filter((entry) => entry.customType === "rubato.context-window.init.v1").length,
    1,
    "clone reuses inherited window identity instead of appending a new INIT",
  );
  assert.equal(readdirSync(join(agentDir, "context-notes")).filter((name) => name.endsWith(".sqlite")).length, 2);

  await host.session.prompt("continue from the cloned note");
  const clonedContext = captured.at(-1);
  assert.match(clonedContext.systemPrompt, /Working across context windows/);
  assert.match(textOf(clonedContext.messages[0]), /^<rubato_context_window_v1>/);
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(uiNotices.filter((notice) => notice.level === "error"), []);
});

test("actual unbundled RPC preserves context entries and injection over reload and clone", async (t) => {
  const cwd = join(scratch, "rpc-project");
  const agentDir = join(scratch, "rpc-agent");
  const sessionDir = join(scratch, "rpc-sessions");
  const capturePath = join(scratch, "rpc-contexts.jsonl");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);

  const streamUrl = pathToFileURL(join(
    runtime.codingAgentDir,
    "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
  )).href;
  const providerPath = join(scratch, "context-notes-provider.mjs");
  writeFileSync(providerPath, `
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from ${JSON.stringify(streamUrl)};
const capturePath = ${JSON.stringify(capturePath)};
const usage = ${JSON.stringify(assistantMessage().usage)};
export default function contextNotesProvider(pi) {
  pi.registerProvider("context-notes-rpc", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "unused-test-key",
    models: [{ id: "fake-model", input: ["text", "image"], contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(model, context) {
      appendFileSync(capturePath, JSON.stringify(context) + "\\n");
      const stream = new AssistantMessageEventStream();
      const base = { role: "assistant", api: "openai-completions", provider: "context-notes-rpc", model: model.id, usage, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...base, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: "offline rpc done" }], stopReason: "stop" } });
      return stream;
    },
  });
}
`);

  const contextExtensionPath = join(runtime.codingAgentDir, "dist/rubato-features/context-notes/extension.mjs");
  const child = spawn(process.execPath, [
    runtime.patchableRpcEntry,
    "--offline",
    "--approve",
    "--provider", "context-notes-rpc",
    "--model", "fake-model",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--session-dir", sessionDir,
    "--extension", contextExtensionPath,
    "--extension", providerPath,
  ], {
    cwd,
    env: withoutNodeOptions(process.env, {
      HOME: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
      RUBATO_CONTEXT_MODE: "history-notes",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = jsonLineChannel(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  });

  const initialState = await channel.request("state-initial", "get_state");
  assert.equal(initialState.success, true, channel.stderr());
  const sourceSessionId = initialState.data.sessionId;

  const firstStart = channel.frames.length;
  assert.equal((await channel.request("prompt-1", "prompt", { message: "rpc priming turn" })).success, true);
  await channel.waitFor((frame) => frame.type === "agent_settled", 10_000, firstStart);

  const rpcOriginalRequest = `rpc original request ${"x".repeat(84_000)}`;
  const secondStart = channel.frames.length;
  assert.equal((await channel.request("prompt-2", "prompt", { message: rpcOriginalRequest })).success, true);
  await channel.waitFor((frame) => frame.type === "agent_settled", 10_000, secondStart);
  const firstEntries = await channel.request("entries-1", "get_entries");
  assert.equal(firstEntries.success, true);
  assert.equal(
    firstEntries.data.entries.filter((entry) => entry.customType === "rubato.context-window.init.v1").length,
    1,
  );
  assert.ok(firstEntries.data.entries.some((entry) => entry.type === "message" && textOf(entry.message).includes("rpc original request")));

  const compact = await channel.request("compact-1", "compact", { customInstructions: "remote-like request" });
  assert.equal(compact.success, false);
  assert.match(compact.error, /Compaction cancelled/);

  const reload = await channel.request("reload-1", "reload");
  assert.equal(reload.success, true);
  const afterReload = await channel.request("entries-2", "get_entries");
  assert.deepEqual(afterReload.data.entries, firstEntries.data.entries);

  const clone = await channel.request("clone-1", "clone");
  assert.equal(clone.success, true);
  assert.equal(clone.data.cancelled, false);
  const clonedState = await channel.request("state-clone", "get_state");
  assert.notEqual(clonedState.data.sessionId, sourceSessionId);
  const clonedEntries = await channel.request("entries-clone", "get_entries");
  assert.deepEqual(clonedEntries.data.entries, firstEntries.data.entries);

  const clonedStart = channel.frames.length;
  assert.equal((await channel.request("prompt-3", "prompt", { message: "rpc cloned request" })).success, true);
  await channel.waitFor((frame) => frame.type === "agent_settled", 10_000, clonedStart);

  const contexts = readFileSync(capturePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(contexts.length, 3);
  for (const context of contexts) {
    assert.match(context.systemPrompt, /Working across context windows/);
    assert.match(textOf(context.messages[0]), /^<rubato_context_window_v1>/);
  }
  assert.match(
    textOf(contexts.at(-1).messages.find((message) => textOf(message).includes("rpc original request"))),
    /\[history: window_id="[^"]+" item_id="[^"]+"\]/,
  );
});
