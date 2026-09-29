import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRubatoComponents } from "../../build-rubato.mjs";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";

// The staged candidate, assembled by bootstrap.mjs exactly as the engine assembles it, with a fake
// sessionLink in place of the engine's. Everything lives in a temp directory with a temp HOME.

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-session-link-"));
const saved = Object.fromEntries(["HOME", "PI_OFFLINE", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
const agentDir = join(scratch, "home", "agent");
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "session-link-test": {
  baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake-model", input: ["text"] }],
} } }));

const build = await buildRubatoComponents({ outputRoot: join(scratch, "build") });
const features = await loadPiFeatures(CANDIDATE_FEATURE_NAMES.filter((name) => name !== "runtime-factories"));
const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: [...features, build.feature] });
const packageRoot = join(staged.root, "node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(packageRoot, "dist/index.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
const { kCursorExecResolved } = await import(pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/utils/block-symbols.js")));
const { createRubatoExtensionFactories } = await import(pathToFileURL(join(staged.root, "rubato-features/rubato-components/bootstrap.mjs")));

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const SIX = ["session_list", "session_read", "session_wait", "session_send", "session_create", "session_fork"];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function openSession(name, sessionLink) {
  const cwd = join(scratch, name);
  mkdirSync(cwd, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory();
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false });
  const assembled = createRubatoExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime, hosted: true, env: { PI_OFFLINE: "1" },
    ...(sessionLink ? { sessionLink } : {}),
    codemodeOptions: { complete: async () => { throw new Error("provider calls are forbidden here"); } },
    providerOptions: { env: { PI_OFFLINE: "1", RUBATO_SPEED_INDEX: "0", RUBATO_NO_KIRO_ENSURE: "1" },
      kiro: { ensureKiro: async () => { throw new Error("Kiro launch is forbidden here"); } } } });
  let api;
  // `holdTurnEnd` parks the next turn_end in an extension loaded after session-link, so a test can
  // act between session-link's turn_end handler and the rest of the turn boundary.
  let turnEndGate;
  const fixture = (pi) => {
    api = pi;
    // A tool whose result ends the run, as a task-output peek at a running task does.
    pi.registerTool({ name: "fixture_stop", label: "Fixture stop", description: "Ends the run after its result.", exposure: "direct",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: "text", text: "still running" }], details: {}, terminate: true }) });
    pi.on("turn_end", async () => {
      if (!turnEndGate) return;
      const parked = turnEndGate;
      turnEndGate = undefined;
      await new Promise((release) => { parked.release = release; parked.reached(parked); });
    });
  };
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...assembled.extensionFactories, { name: "fixture-api", factory: fixture }] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const model = modelRuntime.getModel("session-link-test", "fake-model");
  assert.ok(model, "fixture model is registered");
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: sdk.SessionManager.inMemory(cwd), model });
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  // Every model request is recorded; `gate` holds one open to deliver into a running turn. A held
  // request ends with `release()` (a normal reply), `callTool(name)` (a reply calling a tool; the
  // unregistered default fails and the run goes on, `fixture_stop` ends the run), `providerTool()` (a
  // reply with a tool result the provider already executed, ending the run) or `abort()` (what a
  // stopped provider stream sends). A request made after a stop is answered as aborted, as a provider does.
  const requests = [];
  let gate;
  session.agent.streamFunction = (activeModel, context, options) => {
    requests.push(context.messages);
    const stream = new AssistantMessageEventStream();
    const message = { role: "assistant", api: activeModel.api, provider: activeModel.provider, model: activeModel.id, usage, timestamp: Date.now(),
      content: [{ type: "text", text: `reply ${requests.length}` }], stopReason: "stop" };
    const finish = () => stream.push({ type: "done", reason: "stop", message });
    const abort = () => stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted", errorMessage: "fixture abort" } });
    const callTool = (name = "fixture_step") => stream.push({ type: "done", reason: "toolUse",
      message: { ...message, content: [{ type: "toolCall", id: `call-${requests.length}`, name, arguments: {} }], stopReason: "toolUse" } });
    // A reply carrying a tool call the provider already executed (Cursor): its result arrives with the
    // reply and nothing runs locally, so the run can end normally with tool results present.
    const providerTool = async () => {
      const toolCallId = `provider-${requests.length}`, toolName = "fixture_remote";
      const result = { content: [{ type: "text", text: "provider tool finished" }], details: {} };
      await options.onProviderToolExecutionStart({ type: "tool_execution_start", toolCallId, toolName, args: {} });
      await options.onProviderToolExecutionEnd({ type: "tool_execution_end", toolCallId, toolName, result, isError: false });
      await options.onToolResult({ role: "toolResult", toolCallId, toolName, content: result.content, isError: false, timestamp: Date.now() });
      stream.push({ type: "done", reason: "stop", message: { ...message,
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {}, [kCursorExecResolved]: true }, ...message.content] } });
    };
    if (options?.signal?.aborted) setTimeout(abort, 0);
    else if (gate) { const held = gate; gate = undefined; Object.assign(held, { release: finish, abort, callTool, providerTool }); held.started(held); } else setTimeout(finish, 5);
    return stream;
  };
  return { session, api, assembled, errors, requests,
    hold: () => new Promise((started) => { gate = { started }; }),
    holdTurnEnd: () => new Promise((reached) => { turnEndGate = { reached }; }) };
}

async function close(session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "unload" });
  session.dispose();
}

async function settle(session) {
  for (let i = 0; i < 200 && (session.isStreaming || !session.isIdle); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

const delivery = (messageId, text) => ({ v: 1, messageId, kind: "message", from: { sessionId: "01sender", title: "Parser work", cwd: "/w/parser" }, text });
const sessionMessages = (session) => session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "rubato-session-message");
const lastUserText = (messages) => {
  const content = messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};

test("bootstrap without the engine's sessionLink registers no conversation tool", async () => {
  const { session, api } = await openSession("no-link");
  const names = api.getAllTools().map(({ name }) => name);
  for (const name of SIX) assert.ok(!names.includes(name), name);
  await close(session);
});

test("in the staged candidate the tools are catalogued for tool_search, and a delivery wakes an idle session with the envelope", async () => {
  const calls = [];
  const sessionLink = { async list(args) { calls.push(args); return { sessions: [], truncated: false }; } };
  const { session, api, assembled, errors, requests } = await openSession("with-link", sessionLink);
  try {
    assert.deepEqual(errors, []);
    const tools = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of SIX) {
      assert.ok(tools.has(name), name);
      assert.equal(tools.get(name).exposure, "search", `${name} is catalogued, not in the prefix`);
    }
    const active = session.getActiveToolNames();
    for (const name of SIX) assert.ok(!active.includes(name), `${name} starts inactive`);
    const found = assembled.toolSearch.search("send a message to another conversation", 10).map((match) => match.name);
    assert.ok(found.includes("session_send"), found.join(", "));

    const deliver = (data) => session.extensionRunner.requestRpc("rubato.session-link.deliver", data);
    assert.deepEqual(await deliver(delivery("m-1", "Run the parser tests.")), { messageId: "m-1", duplicate: false, state: "queued" });
    await settle(session);
    const [entry] = sessionMessages(session);
    assert.ok(entry, "the message is in the transcript");
    assert.equal(entry.display, true);
    assert.deepEqual(entry.details, delivery("m-1", "Run the parser tests."));
    assert.equal(requests.length, 1, "an idle session ran a turn");
    const seen = lastUserText(requests[0]);
    assert.match(seen, /Parser work/);
    assert.match(seen, /not written by the user/);
    assert.match(seen, /Run the parser tests\./);

    assert.deepEqual(await deliver(delivery("m-1", "Run the parser tests.")), { messageId: "m-1", duplicate: true, state: "written" });
    await settle(session);
    assert.equal(sessionMessages(session).length, 1);
    assert.equal(requests.length, 1, "a duplicate starts no turn");
  } finally {
    await close(session);
  }
});

const deliverTo = (session) => (data) => session.extensionRunner.requestRpc("rubato.session-link.deliver", data);
const idsIn = (session) => sessionMessages(session).map((entry) => entry.details.messageId);

const mentions = (messages, text) => JSON.stringify(messages).includes(text);

// A message that arrives while a run goes on is held until the run ends, however the run ends normally;
// then the next run starts with it. What the engine and T3 see: they treat an announced agent_settled
// as the end of the target's work, so the second run must start before the first one's is announced.
const endings = {
  reply: (gate) => gate.release(),
  "tool call the run goes on from": (gate) => gate.callTool(),
  "tool call that ends the run": (gate) => gate.callTool("fixture_stop"),
  "tool result the provider already executed": (gate) => gate.providerTool(),
};
for (const [ending, end] of Object.entries(endings)) {
  test(`a delivery during a run that ends normally (${ending}) is held until the run ends, then the next run reads it`, async () => {
    const { session, requests, hold } = await openSession(`ends-${Object.keys(endings).indexOf(ending)}`, { async list() { return { sessions: [], truncated: false }; } });
    session.setActiveToolsByName([...session.getActiveToolNames(), "fixture_stop"]);
    const deliver = deliverTo(session);
    const streamingAtSettle = [];
    session.subscribe((event) => { if (event.type === "agent_settled") streamingAtSettle.push(session.isStreaming); });
    try {
      const held = hold();
      const run = session.prompt("Work");
      const gate = await held;
      assert.deepEqual(await deliver(delivery("m-end", "Please answer this.")), { messageId: "m-end", duplicate: false, state: "queued" });
      await end(gate);
      await run;
      const first = requests.length;
      for (let i = 0; i < 200 && (requests.length === first || !session.isIdle); i++) await new Promise((r) => setTimeout(r, 10));
      await settle(session);
      assert.equal(session.agent.hasQueuedMessages(), false, "nothing ever went to Pi's steering queue");
      assert.ok(requests.slice(0, first).every((request) => !mentions(request, "Please answer this.")), "no request of the running run carried it");
      assert.equal(requests.length, first + 1, "the next run made one request");
      assert.match(lastUserText(requests.at(-1)), /Please answer this\./, "which reads the message");
      assert.deepEqual(idsIn(session), ["m-end"]);
      assert.deepEqual(streamingAtSettle, [false], "the next run started inside the first one's settle, so only its own settle is announced");
      assert.deepEqual(await deliver(delivery("m-end", "Please answer this.")), { messageId: "m-end", duplicate: true, state: "written" });
      await settle(session);
      assert.deepEqual(idsIn(session), ["m-end"]);
      assert.equal(requests.length, first + 1, "a duplicate starts no run");
    } finally {
      await close(session);
    }
  });
}

test("a delivery answers as soon as the session took it, and a duplicate is one still queued or already written", async () => {
  const { session, requests, hold } = await openSession("accept", { async list() { return { sessions: [], truncated: false }; } });
  const deliver = deliverTo(session);
  try {
    // Idle: the handler answers while the turn it started is still waiting on the model.
    let held = hold();
    assert.deepEqual(await deliver(delivery("m-idle", "Start.")), { messageId: "m-idle", duplicate: false, state: "queued" });
    let gate = await held;
    assert.equal(session.isStreaming, true, "the turn is still running when the answer arrived");
    assert.deepEqual(await deliver(delivery("m-idle", "Other text, same id.")), { messageId: "m-idle", duplicate: true, state: "written" });

    // Running: queued for the next boundary; the same (trimmed) id is refused while it waits.
    assert.deepEqual(await deliver(delivery("m-run", "Also check the lexer.")), { messageId: "m-run", duplicate: false, state: "queued" });
    assert.deepEqual(await deliver(delivery(" m-run ", "Also check the lexer.")), { messageId: "m-run", duplicate: true, state: "queued" });
    assert.deepEqual(idsIn(session), ["m-idle"], "not written while the turn runs");
    held = hold();
    gate.release();
    gate = await held;
    assert.deepEqual(idsIn(session), ["m-idle", "m-run"], "written at the next boundary");
    assert.match(lastUserText(requests.at(-1)), /Also check the lexer\./);
    gate.release();
    await settle(session);
    assert.deepEqual(await deliver(delivery("m-run", "Also check the lexer.")), { messageId: "m-run", duplicate: true, state: "written" });
    await settle(session);
    assert.deepEqual(idsIn(session), ["m-idle", "m-run"]);
    assert.equal(requests.length, 2, "a duplicate starts no turn");
  } finally {
    await close(session);
  }
});

test("a message queued when the user stops the turn and clears the queue is kept: written without a new turn, and a redelivery is a duplicate", async () => {
  const { session, requests, hold } = await openSession("stop", { async list() { return { sessions: [], truncated: false }; } });
  const deliver = deliverTo(session);
  try {
    const held = hold();
    const run = session.prompt("Work until interrupted");
    const gate = await held;
    assert.deepEqual(await deliver(delivery("m-cut", "Report before you stop.")), { messageId: "m-cut", duplicate: false, state: "queued" });
    assert.deepEqual(idsIn(session), []);
    session.clearQueue();
    const aborting = session.abort();
    gate.abort();
    await Promise.all([run, aborting]);
    await settle(session);
    assert.deepEqual(idsIn(session), ["m-cut"], "the stop did not lose the message");
    assert.equal(requests.length, 1, "the stop is honoured: the message starts no turn");
    assert.deepEqual(await deliver(delivery("m-cut", "Report before you stop.")), { messageId: "m-cut", duplicate: true, state: "written" });
    await settle(session);
    assert.deepEqual(idsIn(session), ["m-cut"]);
  } finally {
    await close(session);
  }
});

test("a user's clear and stop right after a tool-call turn cannot erase the message: it is written once", async () => {
  const { session, requests, hold, holdTurnEnd } = await openSession("tool-clear", { async list() { return { sessions: [], truncated: false }; } });
  const deliver = deliverTo(session);
  try {
    const held = hold();
    const run = session.prompt("Work until interrupted");
    const gate = await held;
    assert.deepEqual(await deliver(delivery("m-kept", "Please answer this.")), { messageId: "m-kept", duplicate: false, state: "queued" });
    const parked = holdTurnEnd();
    gate.callTool();
    const turnEnd = await parked;
    session.clearQueue();
    const aborting = session.abort();
    turnEnd.release();
    await Promise.all([run, aborting]);
    await settle(session);
    assert.deepEqual(idsIn(session), ["m-kept"], "the clear did not lose the message");
    assert.equal(requests.length, 2, "the stop is honoured: no run after it");
    assert.deepEqual(await deliver(delivery("m-kept", "Please answer this.")), { messageId: "m-kept", duplicate: true, state: "written" });
    await settle(session);
    assert.deepEqual(idsIn(session), ["m-kept"]);
  } finally {
    await close(session);
  }
});

// Another extension's steer queued ahead of the message used to leave it in Pi's queue at a stop.
async function stopBehindAnotherSteer(name, { end, clear }) {
  const opened = await openSession(name, { async list() { return { sessions: [], truncated: false }; } });
  const { session, api, hold } = opened;
  try {
    let held = hold();
    const run = session.prompt("Work until interrupted");
    let gate = await held;
    api.sendMessage({ customType: "fixture-wake", display: false, content: "a background job finished" }, { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(await deliverTo(session)(delivery("m-behind", "Please answer this.")), { messageId: "m-behind", duplicate: false, state: "queued" });
    held = hold();
    gate[end]();
    gate = await held;
    if (clear) session.clearQueue();
    const aborting = session.abort();
    gate.abort();
    await Promise.all([run, aborting]);
    await settle(session);
  } catch (error) {
    await close(session);
    throw error;
  }
  return opened;
}

for (const end of ["release", "callTool"]) {
  for (const clear of [false, true]) {
    test(`behind another extension's steer (${end === "release" ? "reply" : "tool call"}, stop ${clear ? "after a clear" : "keeping the queue"}), a resend and the next turn leave the id written once`, async () => {
      const { session } = await stopBehindAnotherSteer(`behind-${end}-${clear}`, { end, clear });
      try {
        assert.deepEqual(idsIn(session), ["m-behind"], "written by the stop");
        assert.deepEqual(await deliverTo(session)(delivery("m-behind", "Please answer this.")), { messageId: "m-behind", duplicate: true, state: "written" });
        await settle(session);
        await session.prompt("Carry on");
        await settle(session);
        assert.deepEqual(idsIn(session), ["m-behind"], "one copy");
      } finally {
        await close(session);
      }
    });
  }
}
