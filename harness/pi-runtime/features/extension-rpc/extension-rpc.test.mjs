import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { collectPendingWork, createExtensionRpc, holdForPendingWork, requestExtensionRpc } from "./runtime.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("RPC registrations reject duplicates, ambiguity, failed/stale lifetimes and invalid names", async () => {
  const a = {}, b = {}, events = [];
  let active = true;
  const guard = () => { if (!active) throw new Error("stale runtime"); };
  const api = createExtensionRpc(a, guard, { emit: (...event) => events.push(event) });
  assert.throws(() => api.handle(" ", () => {}), /empty/);
  assert.throws(() => api.emit(undefined), /empty/);
  assert.throws(() => api.handle("bad", false), /function/);
  api.handle(" echo ", (data) => data);
  assert.throws(() => api.handle("echo", () => {}), /already registered/);
  assert.equal(await requestExtensionRpc([a], guard, "echo", "ok"), "ok");
  await assert.rejects(requestExtensionRpc([a], guard, "unknown"), /Unknown/);
  createExtensionRpc(b, guard, { emit() {} }).handle("echo", () => {});
  await assert.rejects(requestExtensionRpc([a, b], guard, "echo"), /Multiple/);
  api.handle("unload", async () => { active = false; return "obsolete"; });
  await assert.rejects(requestExtensionRpc([a], guard, "unload"), /stale/);
  assert.throws(() => api.emit("late", {}), /stale/);
  assert.deepEqual(events, []);
});

test("actual stock SDK and RPC carry extension requests/events across reload and session replacement", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-extension-rpc-"));
  let session, child;
  t.after(async () => {
    session?.dispose();
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    await rm(scratch, { recursive: true, force: true });
  });
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: await loadPiFeatures(["reload", "extension-rpc"]) });
  const sdk = await import(pathToFileURL(staged.runtime.sdkEntry));
  const cwd = join(scratch, "project"), agentDir = join(scratch, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const settingsManager = sdk.SettingsManager.inMemory();
  let generation = 0, captured;
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "rpc-fixture", factory: (pi) => {
      const current = ++generation;
      captured = pi;
      pi.rpc.handle("echo", (data) => ({ current, data }));
    } }],
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) }));
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  assert.deepEqual(await session.extensionRunner.requestRpc("echo", "sdk"), { current: 1, data: "sdk" });
  const stale = captured;
  await session.reload();
  assert.throws(() => stale.rpc.emit("obsolete", {}), /disposed|active|stale/i);
  assert.deepEqual(await session.extensionRunner.requestRpc("echo", "sdk reloaded"), { current: 2, data: "sdk reloaded" });

  const extension = join(scratch, "extension.mjs");
  await writeFile(extension, `export default (pi) => {
    let starts = 0;
    pi.rpc.handle("echo", (data) => { pi.rpc.emit("echoed", data); return { echo: data }; });
    pi.on("session_start", (event) => pi.rpc.emit("ready", { ready: true, reason: event.reason, starts: ++starts }));
  };\n`);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "never-called" }],
  } } }));
  const env = { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
  delete env.NODE_OPTIONS; delete env.NODE_COMPILE_CACHE;
  child = spawn(process.execPath, [staged.runtime.patchableRpcEntry, "--offline", "--approve", "--provider", "fixture", "--model", "never-called",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
    "--session-dir", join(scratch, "sessions"), "--extension", extension], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [], waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { frames.push(JSON.parse(line)); for (const notify of waiters) notify(); });
  const waitFor = (predicate) => new Promise((resolvePromise, reject) => {
    const finish = () => {
      const found = frames.find(predicate);
      if (found) { clearTimeout(timer); waiters.delete(finish); resolvePromise(found); }
    };
    const timer = setTimeout(() => { waiters.delete(finish); reject(new Error(`RPC fixture timeout: ${stderr}`)); }, 8000);
    waiters.add(finish); finish();
  });
  const request = async (id, type, data = {}) => {
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return waitFor((frame) => frame.type === "response" && frame.id === id);
  };
  assert.equal((await waitFor((frame) => frame.type === "extension_event" && frame.name === "ready")).data.ready, true);
  assert.deepEqual((await request("echo1", "extension_request", { name: "echo", data: { value: 1 } })).data, { echo: { value: 1 } });
  assert.deepEqual((await waitFor((frame) => frame.type === "extension_event" && frame.name === "echoed")).data, { value: 1 });
  assert.equal((await request("missing", "extension_request", { name: "missing" })).success, false);
  assert.equal((await request("reload", "reload")).success, true);
  assert.deepEqual((await request("echo2", "extension_request", { name: "echo", data: "after" })).data, { echo: "after" });
  assert.equal(frames.filter((frame) => frame.type === "extension_event" && frame.name === "echoed").length, 2, "no duplicate subscriber after reload");
  const readyBefore = frames.filter((frame) => frame.type === "extension_event" && frame.name === "ready").length;
  assert.equal((await request("new", "new_session")).success, true);
  const replacementEvents = frames.filter((frame) => frame.type === "extension_event" && frame.name === "ready").slice(readyBefore);
  assert.equal(replacementEvents.length, 1, "session replacement binds extensions exactly once");
  assert.equal(replacementEvents[0].data.reason, "new");
  assert.deepEqual((await request("echo3", "extension_request", { name: "echo", data: "replacement" })).data, { echo: "replacement" });
});

test("pending work sums every *.pending-work answer and a stuck delivery stops holding", async () => {
  const a = {}, b = {}, c = {};
  createExtensionRpc(a, () => {}, { emit() {} }).handle("a.pending-work", () => ({ active: 2, undelivered: 1 }));
  createExtensionRpc(b, () => {}, { emit() {} }).handle("b.pending-work", () => { throw new Error("unanswerable"); });
  createExtensionRpc(c, () => {}, { emit() {} }).handle("c.other", () => ({ active: 9 }));
  assert.deepEqual(await collectPendingWork([a, b, c], () => {}), { active: 2, undelivered: 1 });

  let clock = 0, polls = 0;
  const session = { isIdle: true, waitForIdle: async () => {},
    extensionRunner: { pendingWork: async () => { polls++; return { active: 0, undelivered: 1 }; } } };
  await holdForPendingWork(() => session, { pollMs: 1000, stuckDeliveryMs: 5000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(polls, 6, "an undelivered completion that never lands holds only for the grace");

  const answers = [1, 0, 1, 0, 0];
  let asked = 0;
  session.extensionRunner.pendingWork = async () => ({ active: answers[asked++], undelivered: 0 });
  await holdForPendingWork(() => session, { settleMs: 3000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(asked, 5, "work that reappears within the settle window is waited for");
});

test("one-shot json run stays alive for pending work and takes its completion as a follow-up turn", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-print-hold-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: await loadPiFeatures(["extension-rpc"]) });
  const packageRoot = dirname(dirname(staged.runtime.patchableCliEntry));
  const streamUrl = pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href;
  const cwd = join(scratch, "project"), agentDir = join(scratch, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const extension = join(scratch, "extension.mjs");
  // The first turn starts background work and ends; the work finishes 700ms later and wakes the
  // session. The provider's second reply proves the wake reached the model as a turn.
  await writeFile(extension, `import { AssistantMessageEventStream } from ${JSON.stringify(streamUrl)};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export default (pi) => {
  let pending = 0, started = false;
  pi.rpc.handle("fixture.pending-work", () => ({ active: pending }));
  pi.on("agent_end", () => {
    if (started) return;
    started = true; pending = 1;
    setTimeout(() => {
      pending = 0;
      pi.sendMessage({ customType: "fixture.done", content: "BACKGROUND-RESULT 42", display: false }, { triggerTurn: true, deliverAs: "followUp" });
    }, 700);
  });
  pi.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused",
    models: [{ id: "fake-model", input: ["text"] }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      const seen = JSON.stringify(last?.content ?? "").includes("BACKGROUND-RESULT 42");
      const stream = new AssistantMessageEventStream();
      const base = { role: "assistant", api: "openai-completions", provider: "fixture", model: model.id, usage, timestamp: Date.now() };
      const text = seen ? "reported BACKGROUND-RESULT 42" : "started; completion will be reported";
      setTimeout(() => stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text }], stopReason: "stop" } }), 20);
      return stream;
    },
  });
};\n`);
  const env = { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
  delete env.NODE_OPTIONS; delete env.NODE_COMPILE_CACHE;
  const started = Date.now();
  const child = spawn(process.execPath, [staged.runtime.patchableCliEntry, "--offline", "--approve", "--provider", "fixture", "--model", "fake-model",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
    "--session-dir", join(scratch, "sessions"), "--extension", extension, "-p", "--mode", "json", "go"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const replies = events.filter((event) => event.type === "message_end" && event.message.role === "assistant")
    .map((event) => event.message.content.map((part) => part.text).join(""));
  assert.deepEqual(replies, ["started; completion will be reported", "reported BACKGROUND-RESULT 42"], stderr);
  assert.equal(events.filter((event) => event.type === "agent_start").length, 2);
  assert.ok(Date.now() - started < 15_000, "the run exits by itself once nothing is pending");
});
