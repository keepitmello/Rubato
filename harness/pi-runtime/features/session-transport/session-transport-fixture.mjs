import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const base = "node_modules/@earendil-works/pi-coding-agent/";
const sdk = await load(base + "dist/index.js");
const { AgentSessionRuntime } = await load(base + "dist/core/agent-session-runtime.js");
const { runRpcMode } = await load(base + "dist/modes/rpc/rpc-mode.js");
const { AssistantMessageEventStream } = await load(base + "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");
globalThis.fetch = () => { throw new Error("No model/network calls permitted"); };
const stdout = process.stdout.write;
const signalCounts = ["SIGTERM", "SIGHUP"].map(name => process.listenerCount(name));
const inputListeners = process.stdin.listenerCount("data");
const fixtures = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function create(index) {
  const cwd = path.join(process.cwd(), `project-${index}`), agentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const provider = `fixture-${index}`;
  modelRuntime.registerProvider(provider, { baseUrl: "http://127.0.0.1:9", api: "openai-completions",
    apiKey: "offline-fixture", models: [{ id: "model", name: "Fixture", input: ["text"], contextWindow: 100000, maxTokens: 1000 }] });
  await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = sdk.SettingsManager.inMemory();
  let context, shutdowns = 0;
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.on("session_start", (_event, ctx) => { context = ctx; });
      pi.on("session_shutdown", () => { shutdowns++; });
      pi.rpc.handle("fixture.ask", () => context.ui.confirm(`Question ${index}`, "Confirm?", { timeout: 60000 }));
      pi.rpc.handle("fixture.echo", (value) => ({ index, value, cwd: context.cwd }));
    }] });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader,
    model: modelRuntime.getAvailableSnapshot().find(model => model.provider === provider),
    sessionManager: sdk.SessionManager.create(cwd, path.join(agentDir, "sessions", String(index))) });
  const session = created.session;
  let streamStarted;
  const started = new Promise(resolve => { streamStarted = resolve; });
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    const message = { role: "assistant", content: [], api: "openai-completions", provider, model: "model", usage, timestamp: Date.now() };
    stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
    options.signal.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted",
      error: { ...message, stopReason: "aborted", errorMessage: "fixture abort" } }), { once: true });
    streamStarted();
    return stream;
  };
  const runtime = new AgentSessionRuntime(session, { cwd, agentDir, settingsManager, modelRuntime, resourceLoader },
    async () => { throw new Error("Replacement is not part of this fixture"); });
  const outputs = [];
  let closed = 0;
  const port = await runRpcMode(runtime, { output: value => outputs.push(value), onClose: () => { closed++; } });
  const fixture = { port, session, outputs, started, shutdowns: () => shutdowns, closed: () => closed };
  fixtures.push(fixture);
  return fixture;
}
try {
  const a = await create(0), b = await create(1);
  assert.equal(process.stdout.write, stdout, "hosted RPC must not take over stdout");
  assert.deepEqual(["SIGTERM", "SIGHUP"].map(name => process.listenerCount(name)), signalCounts);
  assert.equal(process.stdin.listenerCount("data"), inputListeners);
  await Promise.all([a.port.dispatch({ id: "a-prompt", type: "prompt", message: "only A" }),
    b.port.dispatch({ id: "b-prompt", type: "prompt", message: "only B" })]);
  await Promise.all([a.started, b.started]);
  assert.equal(a.session.isStreaming && b.session.isStreaming, true);
  await a.port.dispatch({ id: "abort-a", type: "abort" });
  assert.equal(a.session.isStreaming, false);
  assert.equal(b.session.isStreaming, true, "A abort cannot stop B");
  const pending = a.port.dispatch({ id: "ask-a", type: "extension_request", name: "fixture.ask" });
  const question = a.outputs.find(value => value.type === "extension_ui_request" && value.method === "confirm");
  assert.ok(question);
  await b.port.dispatch({ type: "extension_ui_response", id: question.id, confirmed: true });
  assert.equal(a.outputs.some(value => value.id === "ask-a"), false, "B cannot answer A's dialog");
  await a.port.dispatch({ type: "extension_ui_response", id: question.id, confirmed: true });
  await pending;
  assert.equal(a.outputs.find(value => value.id === "ask-a").data, true);
  const waiting = a.port.dispatch({ id: "ask-closing", type: "extension_request", name: "fixture.ask" });
  await Promise.all([a.port.close(), a.port.close(), waiting]);
  assert.equal(a.shutdowns(), 1); assert.equal(a.closed(), 1);
  assert.equal(b.session.isStreaming, true, "A close cannot stop B");
  await assert.rejects(a.port.dispatch({ type: "get_state" }), /closed/);
  await b.port.dispatch({ id: "b-state", type: "get_state" });
  assert.equal(b.outputs.find(value => value.id === "b-state").data.sessionId, b.session.sessionId);
  await b.port.close();
  assert.equal(b.session.isStreaming, false, "close must await its active turn's abort");
  assert.equal(b.shutdowns(), 1);
  assert.equal(process.stdout.write, stdout);
  assert.deepEqual(["SIGTERM", "SIGHUP"].map(name => process.listenerCount(name)), signalCounts);
  console.log("SESSION_TRANSPORT_OK");
} finally {
  await Promise.all(fixtures.map(fixture => fixture.port.close()));
}
