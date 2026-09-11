import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRubatoCandidate } from "../build-candidate.mjs";
import { runRubatoCandidate } from "../features/rubato-components/candidate-main.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("candidate entry refuses to choose the normal profile implicitly", async () => {
  const previous = process.env.RUBATO_CANDIDATE_AGENT_DIR;
  delete process.env.RUBATO_CANDIDATE_AGENT_DIR;
  try { await assert.rejects(runRubatoCandidate([]), /explicit absolute/); }
  finally {
    if (previous === undefined) delete process.env.RUBATO_CANDIDATE_AGENT_DIR;
    else process.env.RUBATO_CANDIDATE_AGENT_DIR = previous;
  }
});

test("actual candidate main RPC binds Rubato against canonical services across new session and reload", { timeout: 90000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-candidate-cli-"));
  let child;
  let buildPending;
  let server;
  t.after(async () => {
    // A timed-out test must not remove a destination while staging is still
    // writing it; wait for the owned build before deleting this test's files.
    await buildPending?.catch(() => {});
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(escalation); }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    await rm(scratch, { recursive: true, force: true });
  });
  await assert.rejects(buildRubatoCandidate({ outputRoot: "relative" }), /absolute/);
  await assert.rejects(buildRubatoCandidate({ outputRoot: scratch }), /already exists/);
  const buildStart = performance.now();
  const staged = await (buildPending = buildRubatoCandidate({ sourceRoot, outputRoot: join(scratch, "engine") }));
  t.signal.throwIfAborted();
  t.diagnostic(`candidate build and stage: ${Math.round(performance.now() - buildStart)}ms`);
  const home = join(scratch, "home"), agentDir = join(home, "candidate-agent"), cwd = join(scratch, "project");
  const liveDir = join(scratch, "live-sentinel");
  await mkdir(liveDir);
  await writeFile(join(liveDir, "untouched"), "live profile must remain untouched");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(join(cwd, ".rubato"), { recursive: true })]);
  await writeFile(join(cwd, ".rubato/rubato.jsonc"), JSON.stringify({ memory: { agent: "candidate-fixture",
    reflection: { enabled: false }, facts: { enabled: false }, dream: { enabled: false, shutdown_launch: false }, sync: { enabled: false } } }));
  const waiters = new Set();
  const providerRequests = [];
  const wake = () => { for (const notify of waiters) notify(); };
  server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    providerRequests.push(parsed);
    wake();
    const textSse = (text) => `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + "data: [DONE]\n\n";
    const blob = JSON.stringify(parsed);
    const hasToolResult = (parsed.messages ?? []).some((message) => message.role === "tool" || message.tool_call_id);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (blob.includes("hang-for-abort")) {
      const aborted = await Promise.race([
        once(request, "close").then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (!response.writableEnded) response.end(aborted ? "" : textSse("candidate local turn"));
      return;
    }
    if (blob.includes("Call memory once for the model-driven loop.") && !hasToolResult) {
      const args = JSON.stringify({
        command: "create", file_path: "facts/model-loop.md", description: "model loop",
        file_text: "model-driven", reason: "loop proof",
      });
      if (!response.writableEnded) {
        response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory_loop", type: "function", function: { name: "memory", arguments: "" } }] }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + "data: [DONE]\n\n");
      }
      return;
    }
    const text = blob.includes("Call memory once for the model-driven loop.") ? "model-driven memory loop done" : "candidate local turn";
    if (!response.writableEnded) response.end(textSse(text));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "unused",
    models: [{ id: "local-only", contextWindow: 128000, maxTokens: 2048 }],
  } } }));
  const extension = join(scratch, "observe.mjs");
  await writeFile(extension, `export default (pi) => {
    let context;
    pi.on("session_start", (event, ctx) => { context = ctx; pi.rpc.emit("candidate.ready", { reason: event.reason }); });
    pi.rpc.handle("candidate.inspect", () => ({ tools: pi.getAllTools().map(tool => tool.name), providers: context.modelRegistry.getRegisteredProviderIds() }));
    pi.rpc.handle("candidate.execute", ({ name, params }) => pi.executeTool(name, params));
  };\n`);
  const env = { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", RUBATO_CANDIDATE_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: liveDir, RUBATO_PI_CODING_AGENT_DIR: liveDir, PI_PACKAGE_DIR: liveDir,
    PI_MANAGED_INSTALL_ROOT: liveDir, PI_CODING_AGENT_SESSION_DIR: liveDir,
    PI_OFFLINE: "1", RUBATO_SPEED_INDEX: "0", RUBATO_NO_KIRO_ENSURE: "1", NO_COLOR: "1",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    GIT_AUTHOR_NAME: "Rubato test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Rubato test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const candidateEntry = join(staged.root, "rubato-features/rubato-components/candidate-main.mjs");
  const mainPath = "node_modules/@earendil-works/pi-coding-agent/dist/main.js";
  const selectedMain = await readFile(join(staged.root, mainPath));
  await writeFile(join(staged.root, mainPath), await readFile(join(sourceRoot, mainPath)));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [candidateEntry, "--mode", "rpc"], { cwd, env, timeout: 10000 }),
      (error) => error.code === 1 && /Candidate stage payload hash mismatch/.test(error.stderr));
  } finally { await writeFile(join(staged.root, mainPath), selectedMain); }
  const receiptPath = join(staged.root, "rubato-pi-stage.json");
  const selectedReceipt = await readFile(receiptPath);
  const incomplete = JSON.parse(selectedReceipt);
  incomplete.files = incomplete.files.filter((entry) => entry.path !== mainPath);
  await writeFile(receiptPath, JSON.stringify(incomplete));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [candidateEntry, "--mode", "rpc"], { cwd, env, timeout: 10000 }),
      (error) => error.code === 1 && /missing required factory hook/.test(error.stderr));
  } finally { await writeFile(receiptPath, selectedReceipt); }
  t.signal.throwIfAborted();
  child = spawn(process.execPath, [join(staged.root, "rubato-features/rubato-components/candidate-main.mjs"), "--mode", "rpc",
    "--offline", "--approve", "--provider", "fixture", "--model", "local-only", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--extension", extension],
  { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { frames.push(JSON.parse(line)); } catch { frames.push({ type: "invalid-json", line }); }
    for (const notify of waiters) notify();
  });
  const waitUntil = (predicate) => new Promise((resolveWait, reject) => {
    const check = () => {
      if (predicate()) { clearTimeout(timer); waiters.delete(check); resolveWait(); }
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Candidate RPC timeout: ${stderr}; ${JSON.stringify(frames.slice(-8))}`)); }, 30000);
    waiters.add(check); check();
  });
  const waitFor = (predicate, afterIndex = 0) => waitUntil(() => frames.slice(afterIndex).some(predicate))
    .then(() => frames.slice(afterIndex).find(predicate));
  let id = 0;
  const request = async (type, data = {}) => {
    const requestId = String(++id);
    child.stdin.write(`${JSON.stringify({ type, id: requestId, ...data })}\n`);
    const response = await waitFor((frame) => frame.type === "response" && frame.id === requestId);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  await waitFor((frame) => frame.type === "extension_event" && frame.name === "candidate.ready");
  const inspect = () => request("extension_request", { name: "candidate.inspect" });
  const initial = await inspect();
  const state = await request("get_state");
  assert.equal(dirname(state.sessionFile), join(agentDir, "sessions"));
  // tool_search is registered only when a deferred catalog exists; the default
  // small direct-exposure profile here intentionally has none.
  for (const name of ["Agent", "team_create", "memory", "memory_apply_patch", "bash_input", "eval", "webfetch", "look_at", "apply_patch"]) assert.ok(initial.tools.includes(name), `missing ${name}`);
  for (const name of ["openai-codex", "xai", "cursor", "anthropic", "kiro", "google-antigravity", "opencode"]) assert.ok(initial.providers.includes(name), `missing ${name}`);
  const promptAndSettle = async (message) => {
    const from = frames.length;
    await request("prompt", { message });
    await waitFor((frame) => frame.type === "agent_end", from);
  };
  await promptAndSettle("Use the isolated local fixture once.");
  const hitsFor = (needle) => providerRequests.filter((body) => JSON.stringify(body).includes(needle)).length;
  assert.equal(hitsFor("Use the isolated local fixture once."), 1, "actual parent prompt reaches only the local provider once");
  assert.ok(frames.some((frame) => frame.type === "message_end" && frame.message?.role === "assistant" &&
    frame.message.content.some((block) => block.text === "candidate local turn")));
  const loopFrom = frames.length;
  await promptAndSettle("Call memory once for the model-driven loop.");
  assert.equal(hitsFor("Call memory once for the model-driven loop."), 2, "model-driven tool loop reaches the local provider twice");
  assert.ok(frames.slice(loopFrom).some((frame) => frame.type === "message_end" && (frame.message?.role === "toolResult" || frame.message?.role === "tool")),
    "model-driven tool loop emits a tool_result frame");
  assert.ok(frames.slice(loopFrom).some((frame) => frame.type === "message_end" && frame.message?.role === "assistant" &&
    frame.message.content.some((block) => block.text === "model-driven memory loop done")));
  const written = await request("extension_request", { name: "candidate.execute", data: { name: "memory", params: {
    command: "create", file_path: "facts/candidate.md", description: "CLI fixture", file_text: "actual candidate main", reason: "local proof" } } });
  assert.notEqual(written.isError, true, JSON.stringify(written));
  const status = await request("extension_request", { name: "rubato.memory.status" });
  assert.ok(status.repo.headSha, "existing RPC consumer observes the CLI tool commit");
  const sessionFile = state.sessionFile;
  const abortFrom = frames.length;
  const abortStarted = performance.now();
  await request("prompt", { message: "hang-for-abort" });
  await waitUntil(() => providerRequests.some((body) => JSON.stringify(body).includes("hang-for-abort")));
  await request("abort");
  await waitFor((frame) => frame.type === "agent_end", abortFrom);
  assert.ok(performance.now() - abortStarted < 2000, "abort must settle before the 2s fixture would complete on its own");
  assert.equal(frames.slice(abortFrom).some((frame) => frame.type === "message_end" && frame.message?.role === "assistant" &&
    Array.isArray(frame.message.content) && frame.message.content.some((block) => block.text === "candidate local turn")), false,
    "aborted turn must not deliver the fixture assistant text");
  assert.equal((await request("get_state")).isStreaming, false, "abort ends the in-flight parent turn");
  assert.equal(existsSync(sessionFile), true, "first user turn persists the session file");
  assert.ok((await readFile(sessionFile, "utf8")).includes("Use the isolated local fixture once."));
  const readyCount = () => frames.filter((frame) => frame.type === "extension_event" && frame.name === "candidate.ready").length;
  const before = readyCount();
  await request("new_session");
  assert.equal(readyCount(), before + 1, "runtime callback replacement must not duplicate session_start");
  assert.deepEqual((await inspect()).tools, initial.tools);
  await request("switch_session", { sessionPath: sessionFile });
  const restored = await request("get_messages");
  const restoredBlob = JSON.stringify(restored.messages);
  assert.ok(restoredBlob.includes("Use the isolated local fixture once."), "switch_session restores the saved session");
  assert.ok(restoredBlob.includes("candidate local turn"));
  await request("new_session");
  await request("reload");
  assert.deepEqual((await inspect()).tools, initial.tools);
  await promptAndSettle("Verify the replacement and reloaded context owner.");
  assert.equal(hitsFor("Verify the replacement and reloaded context owner."), 1, "replacement/reload keeps the provider admission path usable");
  assert.equal(frames.some((frame) => frame.type === "invalid-json"), false, "component logs may not corrupt RPC stdout");
  assert.deepEqual(await readdir(liveDir), ["untouched"]);
  assert.equal(await readFile(join(liveDir, "untouched"), "utf8"), "live profile must remain untouched");
});
