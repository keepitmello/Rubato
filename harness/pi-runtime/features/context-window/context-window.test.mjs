import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { feature as contextNotesFeature } from "../context-notes/patches.mjs";
import { feature, files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-context-window-"));
const outputRoot = join(scratch, "engine");
const previousContextMode = process.env.RUBATO_CONTEXT_MODE;
const previousContextModeOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.RUBATO_CONTEXT_MODE = "history-notes";
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;

after(() => {
  if (previousContextMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousContextMode;
  if (previousContextModeOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousContextModeOrigin;
  rmSync(scratch, { recursive: true, force: true });
});

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function usage(input = 1, output = 1) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content, stopReason = "stop", provider = "context-window-test") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider,
    model: "fake-model",
    usage: usage(),
    stopReason,
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

function completeStream(Stream, message) {
  const stream = new Stream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}

function writeModels(agentDir, provider = "context-window-test") {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
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
  const waitFor = (predicate, timeoutMs = 15_000, afterIndex = 0) => new Promise((resolveFrame, reject) => {
    const check = () => {
      const frame = frames.slice(afterIndex).find(predicate);
      if (!frame) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolveFrame(frame);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`RPC fixture timeout; stderr=${stderr}; frames=${JSON.stringify(frames.slice(-12))}`));
    }, timeoutMs);
    waiters.add(check);
    check();
  });
  const request = async (id, type, data = {}) => {
    const start = frames.length;
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return waitFor((frame) => frame.type === "response" && frame.id === id, 15_000, start);
  };
  return { frames, request, waitFor, stderr: () => stderr };
}

const dependencies = await loadPiFeatures([
  "reload",
  "service-tier",
  "input-lifecycle",
  "abort-provenance",
  "extension-rpc",
  "request-run",
  "session-catalog",
  "providers",
]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot,
  features: [...dependencies, contextNotesFeature, feature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/extension.mjs",
)));
const contextProtocol = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/protocol.mjs",
)));

test("descriptor is stock-locked, drift-failing, and composes with shared core features", () => {
  assert.equal(feature.id, "context-window");
  assert.deepEqual(files, []);
  assert.equal(patches.length, 11);
  assert.equal(new Set(patches.map((entry) => entry.path)).size, patches.length);
  assert.ok(patches.every((entry) => entry.packageName === "@earendil-works/pi-coding-agent"));
  assert.ok(patches.every((entry) => entry.version === "0.85.1"));
  assert.ok(patches.every((entry) => /^[a-f0-9]{64}$/.test(entry.preimageSha256)));
  assert.equal(staged.receipt.files.filter((entry) => entry.patches.some((id) => id.startsWith("context-window/"))).length, 11);

  for (const entry of staged.receipt.files.filter((item) => item.patches.some((id) => id.startsWith("context-window/")))) {
    const syntax = entry.path.endsWith(".js")
      ? spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
        encoding: "utf8",
        env: withoutNodeOptions(process.env),
      })
      : { status: 0, stderr: "" };
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }

  const stockAgentSession = readFileSync(join(
    sourceRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
  ), "utf8");
  assert.throws(
    () => patches.find((entry) => entry.path === "dist/core/agent-session.js").apply(
      stockAgentSession.replace("_resolveIdleWait;", "_resolveIdleWait /* drift */;"),
    ),
    /expected anchor is missing/,
  );
});

test("actual SDK commits new_context once and the immediate provider turn uses only the live window", async (t) => {
  const cwd = join(scratch, "sdk-project");
  const agentDir = join(scratch, "sdk-agent");
  const sessionDir = join(scratch, "sdk-sessions");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);
  writeModels(agentDir);

  const contexts = [];
  const errors = [];
  const notices = [];
  const compactionEvents = [];
  let probeContext;
  let probeApi;
  const probeExtension = (pi) => {
    probeApi = pi;
    pi.on("session_start", (_event, ctx) => { probeContext = ctx; });
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
      { name: "context-notes", factory: createContextNotesExtension({ agentDir, enabled: true }) },
      { name: "context-window-probe", factory: probeExtension },
    ],
  });
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.create(cwd, sessionDir, { id: "context-window-sdk" }),
    model: {
      provider: "context-window-test",
      id: "fake-model",
      name: "Offline context-window fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 100_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    tools: ["notes_write_file", "new_context"],
  });
  t.after(() => result.session.dispose());
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
    },
    onError: (error) => errors.push(error),
  });
  result.session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      compactionEvents.push(event);
    }
  });
  assert.equal(settingsManager.getCompactionSettings().enabled, false, "notes mode owns every stock automatic compaction entry");
  assert.equal(typeof probeContext?.getMessageRevision, "function");
  assert.equal(typeof probeContext?.applyCompaction, "function");

  let call = 0;
  result.session.agent.streamFunction = (_model, context) => {
    contexts.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      toolNames: context.tools.map((tool) => tool.name),
    });
    const message = call === 0
      ? assistant([{ type: "toolCall", id: "write-1", name: "notes_write_file", arguments: {
        path: "handoff.md",
        text: "goal=atomic context window; next=continue after cut",
      } }], "toolUse")
      : call === 1
        ? assistant([{ type: "toolCall", id: "window-1", name: "new_context", arguments: {} }], "toolUse")
        : assistant([{ type: "text", text: "continued in the new window" }]);
    call += 1;
    return completeStream(AssistantMessageEventStream, message);
  };

  await result.session.prompt("Keep the original request out of the next context window");
  assert.equal(contexts.length, 3, JSON.stringify({ errors, notices, messages: result.session.messages }));

  const preCut = contexts[1].messages;
  const writeAssistant = preCut.find((message) => message.role === "assistant" &&
    message.content.some((part) => part.type === "toolCall" && part.id === "write-1"));
  const writeResult = preCut.find((message) => message.role === "toolResult" && message.toolCallId === "write-1");
  assert.ok(writeAssistant && writeResult, "stock provider context preserves the complete tool-call/result pair without pruning");

  const nextWindow = contexts[2].messages;
  assert.equal(nextWindow.length, 1, JSON.stringify(nextWindow));
  assert.equal(nextWindow[0].role, "user");
  assert.match(textOf(nextWindow[0]), /^<rubato_context_window_v1>/);
  assert.doesNotMatch(JSON.stringify(nextWindow), /Keep the original request/);
  assert.doesNotMatch(JSON.stringify(nextWindow), /atomic context window/);
  assert.doesNotMatch(JSON.stringify(nextWindow), /The conversation history before this point was compacted/);

  const entries = result.session.sessionManager.getEntries();
  const compactions = entries.filter((entry) => entry.type === "compaction" &&
    entry.details?.source === "rubato-history-notes-v1");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, true);
  assert.equal(result.session.messages.length, 2, "new-window assistant is appended after the bootstrap carrier");
  assert.match(textOf(result.session.messages[0]), /^<rubato_context_window_v1>/);
  assert.deepEqual(compactionEvents.map((event) => [event.type, event.reason, event.aborted]), [
    ["compaction_start", "extension", undefined],
    ["compaction_end", "extension", false],
  ]);

  // Use the same public extension seam twice at one valid revision. JavaScript
  // enters the first call through commit before it can yield; the second call
  // must observe the new revision and append nothing.
  await result.session.prompt("prepare the next-window race");
  result.session.setActiveToolsByName(["notes_write_file", "new_context"]);
  const writeTool = result.session.agent.state.tools.find((tool) => tool.name === "notes_write_file");
  assert.ok(writeTool);
  await writeTool.execute(
    "write-race-note",
    { path: "race.md", text: "checkpoint before concurrent apply" },
    new AbortController().signal,
  );
  const branch = result.session.sessionManager.getBranch();
  const oldWindow = contextProtocol.branchWindow(branch);
  const raceWindow = contextProtocol.nextWindow(oldWindow);
  probeApi.appendEntry(contextProtocol.PREPARE_ENTRY, { window: raceWindow, source: contextProtocol.SOURCE });
  const preparedBranch = result.session.sessionManager.getBranch();
  const marker = preparedBranch.at(-1);
  const note = preparedBranch.findLast((entry) => entry.customType === contextProtocol.NOTE_ENTRY);
  const raceResult = {
    summary: contextProtocol.encodeBootstrap(raceWindow, "race.md"),
    firstKeptEntryId: marker.id,
    tokensBefore: 10,
    details: {
      source: contextProtocol.SOURCE,
      window: raceWindow,
      checkpointEntryId: note.id,
      preparedLeafId: marker.id,
      reason: "manual",
    },
  };
  const sameRevision = probeContext.getMessageRevision();
  const concurrent = await Promise.all([
    probeContext.applyCompaction(raceResult, { reason: "extension", expectedRevision: sameRevision }),
    probeContext.applyCompaction(raceResult, { reason: "extension", expectedRevision: sameRevision }),
  ]);
  assert.equal(concurrent.filter((outcome) => outcome.applied).length, 1, JSON.stringify(concurrent));
  assert.equal(concurrent.filter((outcome) => !outcome.applied && outcome.reason === "stale").length, 1);
  assert.equal(result.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 2);

  const revisionBeforeRace = probeContext.getMessageRevision();
  probeApi.appendEntry("rubato.context-window.test-race", { marker: true });
  const compactionsBeforeRace = result.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
  assert.deepEqual(await probeContext.applyCompaction({}, {
    reason: "extension",
    expectedRevision: revisionBeforeRace,
  }), { applied: false, reason: "stale" });
  assert.deepEqual(await probeContext.applyCompaction({}, {
    reason: "extension",
    expectedRevision: probeContext.getMessageRevision(),
    signal: AbortSignal.abort(),
  }), { applied: false, reason: "stale" });
  assert.equal(result.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, compactionsBeforeRace);
  assert.deepEqual(errors, []);
  assert.deepEqual(notices.filter((notice) => notice.level === "error"), []);
  assert.equal(existsSync(result.session.sessionFile), true);
  assert.match(readFileSync(result.session.sessionFile, "utf8"), /rubato-history-notes-v1/);
});

test("provider admission and Anthropic server compaction both fail closed in notes mode", async (t) => {
  const cwd = join(scratch, "admission-project");
  const agentDir = join(scratch, "admission-agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeModels(agentDir, "admission-test");
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
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: {
      provider: "admission-test",
      id: "fake-model",
      name: "Admission fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    noTools: "all",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  let providerCalls = 0;
  session.agent.streamFunction = () => {
    providerCalls += 1;
    return completeStream(AssistantMessageEventStream, assistant([{ type: "text", text: "must not run" }], "stop", "admission-test"));
  };
  await session.prompt("a session without its context owner must not reach a provider");
  assert.equal(providerCalls, 0);
  const blocked = session.messages.find((message) => message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted"));
  assert.match(blocked?.errorMessage ?? "", /새 문맥 관리 확장이 준비되지 않았어요/);

  const serverCompactionDir = join(
    runtime.packages["@earendil-works/pi-ai"].dir,
    "dist/rubato-features/providers/src",
  );
  const serverCompaction = await import(pathToFileURL(join(serverCompactionDir, "anthropic-server-compaction.mjs")));
  const serverCompactionWire = await import(pathToFileURL(join(serverCompactionDir, "anthropic-server-compaction-wire.mjs")));
  const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] });
  const bypass = serverCompactionWire.applyAnthropicServerCompaction(body, {}, {
    provider: "anthropic",
    contextWindow: 1_000_000,
    armed: true,
  });
  assert.deepEqual(bypass, { bodyText: body, headers: {}, rewritten: false });
  assert.equal(serverCompaction.supportsAnthropicServerCompaction({ provider: "anthropic", id: "claude-opus-5" }), false);
});

test("actual unbundled RPC runs new_context and exposes stale/abort results without another boundary", async (t) => {
  const cwd = join(scratch, "rpc-project");
  const agentDir = join(scratch, "rpc-agent");
  const sessionDir = join(scratch, "rpc-sessions");
  const capturePath = join(scratch, "rpc-window-contexts.jsonl");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);

  const streamUrl = pathToFileURL(join(
    runtime.codingAgentDir,
    "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
  )).href;
  const providerPath = join(scratch, "context-window-provider.mjs");
  writeFileSync(providerPath, `
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from ${JSON.stringify(streamUrl)};
const capturePath = ${JSON.stringify(capturePath)};
const usage = ${JSON.stringify(usage())};
let call = 0;
function message(content, stopReason = "stop") {
  return { role: "assistant", content, api: "openai-completions", provider: "context-window-rpc",
    model: "fake-model", usage, stopReason, timestamp: Date.now() };
}
export default function contextWindowProvider(pi) {
  pi.registerProvider("context-window-rpc", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "unused-test-key",
    models: [{ id: "fake-model", input: ["text", "image"], contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(_model, context) {
      appendFileSync(capturePath, JSON.stringify(context) + "\\n");
      const value = call === 0
        ? message([{ type: "toolCall", id: "rpc-write", name: "notes_write_file",
          arguments: { path: "rpc.md", text: "rpc-note-body-must-not-leak" } }], "toolUse")
        : call === 1
          ? message([{ type: "toolCall", id: "rpc-window", name: "new_context", arguments: {} }], "toolUse")
          : message([{ type: "text", text: "rpc continued in new window" }]);
      call += 1;
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...value, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: value.stopReason, message: value });
      return stream;
    },
  });
}
`);
  const probePath = join(scratch, "context-window-rpc-probe.mjs");
  writeFileSync(probePath, `
let context;
export default function contextWindowProbe(pi) {
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.rpc.handle("context_window_revision", () => ({ revision: context.getMessageRevision() }));
  pi.rpc.handle("context_window_stale", async () => {
    const expectedRevision = context.getMessageRevision();
    pi.appendEntry("rubato.context-window.rpc-race", { marker: true });
    return context.applyCompaction({}, { reason: "extension", expectedRevision });
  });
  pi.rpc.handle("context_window_abort", () => context.applyCompaction({}, {
    reason: "extension", expectedRevision: context.getMessageRevision(), signal: AbortSignal.abort(),
  }));
}
`);

  const child = spawn(process.execPath, [
    runtime.patchableRpcEntry,
    "--offline",
    "--approve",
    "--provider", "context-window-rpc",
    "--model", "fake-model",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "notes_write_file,new_context",
    "--session-dir", sessionDir,
    "--extension", join(runtime.codingAgentDir, "dist/rubato-features/context-notes/extension.mjs"),
    "--extension", providerPath,
    "--extension", probePath,
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

  const initialState = await channel.request("state-0", "get_state");
  assert.equal(initialState.success, true, channel.stderr());
  const start = channel.frames.length;
  assert.equal((await channel.request("prompt-1", "prompt", {
    message: "rpc original message must be cut atomically",
  })).success, true);
  await channel.waitFor((frame) => frame.type === "agent_settled", 20_000, start);

  const contexts = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(contexts.length, 3, JSON.stringify({ frames: channel.frames.slice(-12), stderr: channel.stderr() }));
  assert.equal(contexts[2].messages.length, 1);
  assert.match(textOf(contexts[2].messages[0]), /^<rubato_context_window_v1>/);
  assert.doesNotMatch(JSON.stringify(contexts[2]), /rpc original message|rpc-note-body-must-not-leak/);
  assert.ok(channel.frames.some((frame) => frame.type === "compaction_end" && frame.reason === "extension" && frame.aborted === false));

  const entriesBefore = await channel.request("entries-before", "get_entries");
  assert.equal(entriesBefore.success, true);
  assert.equal(entriesBefore.data.entries.filter((entry) => entry.type === "compaction").length, 1);
  const revision = await channel.request("revision", "extension_request", { name: "context_window_revision" });
  assert.equal(revision.success, true, channel.stderr());
  assert.equal(Number.isSafeInteger(revision.data.revision), true);
  const stale = await channel.request("stale", "extension_request", { name: "context_window_stale" });
  assert.deepEqual(stale.data, { applied: false, reason: "stale" });
  const aborted = await channel.request("aborted", "extension_request", { name: "context_window_abort" });
  assert.deepEqual(aborted.data, { applied: false, reason: "stale" });
  const entriesAfter = await channel.request("entries-after", "get_entries");
  assert.equal(entriesAfter.data.entries.filter((entry) => entry.type === "compaction").length, 1);
});
