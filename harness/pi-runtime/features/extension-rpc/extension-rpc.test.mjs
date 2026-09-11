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
import { createExtensionRpc, requestExtensionRpc } from "./runtime.mjs";

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
