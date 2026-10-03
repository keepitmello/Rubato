import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

// A window past its hard line may only serve a checkpoint turn. Two states used to strand
// such a session: no checkpoint request outstanding (a stopped checkpoint turn, a reopened
// session, a repair that never saved a note) refused every message without ever asking for
// one, and a request left armed by a tree move silenced /new-context and every later line.

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-context-notes-checkpoint-"));
const previous = { mode: process.env.RUBATO_CONTEXT_MODE, origin: process.env.RUBATO_CONTEXT_MODE_ORIGIN,
  offline: process.env.PI_OFFLINE };
process.env.RUBATO_CONTEXT_MODE = "history-notes";
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.PI_OFFLINE = "1";

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["input-lifecycle", "abort-provenance", "request-run", "context-window"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js")));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir, "dist/rubato-features/context-notes/extension.mjs")));

after(() => {
  for (const [key, value] of [["RUBATO_CONTEXT_MODE", previous.mode],
    ["RUBATO_CONTEXT_MODE_ORIGIN", previous.origin], ["PI_OFFLINE", previous.offline]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

// hard-safety strategy: one line at 100,000 - 4,096 (output reserve) - 8,192 = 87,712.
const model = {
  provider: "checkpoint-test", id: "fake-model", name: "fake", api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const PAST_HARD = 90_100;
const CHECKPOINT_REQUEST = "rubato-context-checkpoint-request";
const settle = () => new Promise((done) => setTimeout(done, 300));

function assistant(text, stopReason = "stop", input = 1, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
}
const providerError = () => assistant("", "error", 0, { errorMessage: "invalid_request_error: upstream rejected" });

function stream(message) {
  const out = new AssistantMessageEventStream();
  out.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  out.push({ type: "done", reason: message.stopReason, message });
  return out;
}
// Ends only when the run is aborted, like a user pressing stop mid-response.
function hangUntilAbort(signal) {
  const out = new AssistantMessageEventStream();
  out.push({ type: "start", partial: { ...assistant(""), content: [], stopReason: "pending" } });
  const finish = () => out.push({ type: "error", reason: "aborted",
    error: assistant("", "aborted", 0, { errorMessage: "Request was aborted" }) });
  if (signal?.aborted) finish(); else signal?.addEventListener("abort", finish, { once: true });
  return out;
}

function workspace(name) {
  const cwd = join(scratch, name);
  const agentDir = join(cwd, "agent");
  const sessionDir = join(cwd, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "unused",
    models: [{ id: model.id, input: ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));
  return { cwd, agentDir, sessionDir };
}

async function open({ cwd, agentDir, sessionManager }, script) {
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "context-notes", factory: createContextNotesExtension({ agentDir, enabled: true }) }],
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager, model });
  const errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { notify(message, level) { if (level === "error") errors.push(message); }, setStatus() {}, confirm: async () => false },
    onError: (error) => errors.push(error?.error ?? String(error)),
  });
  let calls = 0;
  session.agent.streamFunction = (_model, _context, options) => {
    const out = script(calls++, options, session);
    return out instanceof AssistantMessageEventStream ? out : stream(out);
  };
  const close = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  return { session, errors, calls: () => calls, close };
}

const requestsOnBranch = (session) => session.sessionManager.getBranch()
  .filter((entry) => entry.customType === CHECKPOINT_REQUEST).length;

test("a message past the hard line after a stopped checkpoint turn gets a checkpoint turn, not a refusal loop", async () => {
  const ws = workspace("stopped");
  const host = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) }, (i, options, session) => {
    if (i === 0) return assistant("did a lot of work", "stop", PAST_HARD);
    if (i === 1) { setTimeout(() => void session.abort(), 10); return hangUntilAbort(options?.signal); }
    return assistant(`turn ${i}`, "stop", PAST_HARD + i);
  });
  try {
    await host.session.prompt("start");
    assert.equal(host.calls(), 2, "the first turn and its stopped checkpoint turn");
    assert.equal(requestsOnBranch(host.session), 1);

    await host.session.prompt("continue please"); await settle();
    assert.ok(host.calls() > 2, "the harness runs a checkpoint turn instead of refusing again");
    assert.ok(requestsOnBranch(host.session) > 1, "a new checkpoint request reached the branch");
    assert.ok(host.errors.some((message) => /창 한도/.test(message) && message.includes("/new-context")),
      `the refusal names the manual exit: ${JSON.stringify(host.errors)}`);
  } finally { await host.close(); }
});

test("a session reopened past the hard line asks for a checkpoint turn on the next message", async () => {
  const ws = workspace("reopened");
  const first = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) },
    (i) => i === 0 ? assistant("did a lot of work", "stop", PAST_HARD) : providerError());
  await first.session.prompt("start");
  const file = first.session.sessionManager.getSessionFile();
  await first.close();

  const second = await open({ ...ws, sessionManager: sdk.SessionManager.open(file, ws.sessionDir) },
    (i) => assistant(`reopened turn ${i}`, "stop", PAST_HARD + 200 + i));
  try {
    const before = requestsOnBranch(second.session);
    await second.session.prompt("continue"); await settle();
    assert.ok(second.calls() > 0, "the reopened session reaches the model");
    assert.ok(requestsOnBranch(second.session) > before, "and the turn it runs is a checkpoint turn");
  } finally { await second.close(); }
});

test("after a repair that never saved a note, the next message still gets a checkpoint turn", async () => {
  const ws = workspace("repair-exhausted");
  const host = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) },
    (i) => assistant(`ignored checkpoint ${i}`, "stop", PAST_HARD + i));
  try {
    await host.session.prompt("start"); await settle();
    const requests = requestsOnBranch(host.session);
    const calls = host.calls();
    assert.equal(requests, 2, "the request and its one repair");
    await host.session.prompt("continue"); await settle();
    assert.ok(host.calls() > calls, "the model is asked again");
    assert.ok(requestsOnBranch(host.session) > requests);
  } finally { await host.close(); }
});

test("a tree move drops a checkpoint request the new branch does not contain", async () => {
  const ws = workspace("tree");
  const tokens = [PAST_HARD, undefined, 2_000, PAST_HARD + 100];
  const host = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) },
    (i) => i === 1 ? providerError() : assistant(`turn ${i}`, "stop", tokens[i] ?? PAST_HARD + i));
  try {
    await host.session.prompt("start"); // past the line -> checkpoint turn -> provider error; the request stays outstanding
    assert.equal(requestsOnBranch(host.session), 1);
    const firstUser = host.session.sessionManager.getEntries().find((entry) => entry.message?.role === "user");
    await host.session.navigateTree(firstUser.id, { summarize: false });
    await host.session.prompt("take a different approach");
    assert.equal(requestsOnBranch(host.session), 0);

    const calls = host.calls();
    await host.session.prompt("/new-context"); await settle();
    assert.ok(host.calls() > calls, "/new-context runs a checkpoint turn on the new branch");
    assert.ok(requestsOnBranch(host.session) > 0);
  } finally { await host.close(); }
});

test("a tree move does not stop the hard line from asking for a checkpoint", async () => {
  const ws = workspace("tree-hard");
  const tokens = [PAST_HARD, undefined, 2_000, PAST_HARD + 100];
  const host = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) },
    (i) => i === 1 ? providerError() : assistant(`turn ${i}`, "stop", tokens[i] ?? PAST_HARD + i));
  try {
    await host.session.prompt("start");
    const firstUser = host.session.sessionManager.getEntries().find((entry) => entry.message?.role === "user");
    await host.session.navigateTree(firstUser.id, { summarize: false });
    await host.session.prompt("take a different approach");
    await host.session.prompt("grow past the line"); await settle();
    assert.ok(requestsOnBranch(host.session) > 0, "crossing the hard line on the new branch requests a checkpoint");
  } finally { await host.close(); }
});

test("without a tree move the outstanding request is repaired on the next turn", async () => {
  const ws = workspace("tree-control");
  const host = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) },
    (i) => i === 1 ? providerError() : assistant(`turn ${i}`, "stop", PAST_HARD + i));
  try {
    await host.session.prompt("start");
    await host.session.prompt("continue"); await settle();
    assert.ok(requestsOnBranch(host.session) >= 2, "a repair checkpoint request is sent");
  } finally { await host.close(); }
});
