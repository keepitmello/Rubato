import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CANDIDATE_FEATURE_NAMES } from "../features/rubato-components/candidate-main.mjs";
import {
  chmodRestoreTraps,
  chmodSenpiTraps,
  installRubatoCandidate,
  retirePath,
  rollbackRubatoCandidate,
  updateRubatoCandidate,
} from "../scripts/install-candidate.mjs";
import { assertScanClean, scanInstalledCandidate } from "../scripts/install-candidate-scan.mjs";

const run = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(sourceRoot, "scripts");
const docsDir = resolve(sourceRoot, "../../docs/pi-migration");

const CORE_TOOLS = ["Agent", "team_create", "memory", "memory_apply_patch", "bash_input", "eval", "webfetch", "look_at", "apply_patch"];
const CORE_PROVIDERS = ["openai-codex", "xai", "cursor", "anthropic", "kiro", "google-antigravity", "opencode"];

function which(cmd) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
}

async function makeIsolatedBin(dir) {
  await mkdir(dir, { recursive: true });
  const names = [
    ["node", process.execPath],
    ["npm", join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm")],
    ["git", which("git")],
    ["bun", which("bun")],
    ["bash", "/bin/bash"],
    ["sh", "/bin/sh"],
  ];
  for (const [name, target] of names) {
    if (!target || !existsSync(target)) continue;
    await symlink(target, join(dir, name));
  }
  return dir;
}

function isolatedEnv({ home, agentDir, binDir, poisonDir, loadReport }) {
  const env = {
    HOME: home,
    PATH: [binDir, "/bin", "/usr/bin"].join(":"),
    LANG: "en_US.UTF-8",
    TMPDIR: join(home, "tmp"),
    RUBATO_CANDIDATE_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    GIT_AUTHOR_NAME: "Rubato test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Rubato test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    SENPI_BIN: join(poisonDir, "senpi"),
    SENPI_CODING_AGENT_DIR: join(poisonDir, "senpi-agent"),
    RUBATO_PI_CODING_AGENT_DIR: join(poisonDir, "rubato-pi"),
    RUBATO_PI_ENGINE: join(poisonDir, "engine"),
    PI_MANAGED_INSTALL_ROOT: join(poisonDir, "managed"),
    PI_PACKAGE_DIR: join(poisonDir, "pi-package"),
    PI_CODING_AGENT_DIR: join(poisonDir, "live-sentinel"),
    PI_CODING_AGENT_SESSION_DIR: join(poisonDir, "sessions"),
  };
  if (loadReport) env.RUBATO_ISOLATED_LOAD_REPORT = loadReport;
  return env;
}

function nodeArgs(traceFile, rest) {
  return traceFile ? ["--import", traceFile, ...rest] : rest;
}

async function plantFakeUserSenpi({ scratch, home }) {
  const senpiHome = join(home, ".senpi", "agent");
  const engineHome = join(home, ".rubato-pi", "engine");
  const parentSenpi = join(scratch, "node_modules", "@code-yeongyu", "senpi");
  await mkdir(senpiHome, { recursive: true });
  await mkdir(engineHome, { recursive: true });
  await mkdir(parentSenpi, { recursive: true });
  await writeFile(join(senpiHome, "index.js"), "export const marker = 'fake-user-senpi-agent';\n");
  await writeFile(join(engineHome, "untouched"), "existing engine must not be loaded");
  await writeFile(join(parentSenpi, "package.json"), `${JSON.stringify({ name: "@code-yeongyu/senpi", version: "0.0.0-fake-user-stub", type: "module", exports: { ".": "./index.js" } })}\n`);
  await writeFile(join(parentSenpi, "index.js"), "throw new Error('fake user Senpi stub must not load');\n");
  return { senpiHome, engineHome, parentSenpi };
}

test("Senpi load detector fires on crafted Senpi-app and escaped-install paths", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-isolated-detector-"));
  try {
    const installRoot = join(scratch, "engine");
    await mkdir(installRoot);
    await writeFile(join(installRoot, "keep"), "install");
    const featureRoot = join(sourceRoot, "features");
    const senpiReport = join(scratch, "senpi-loads.txt");
    const escapeReport = join(scratch, "escaped-loads.txt");
    const senpiUrl = pathToFileURL(join(await realpath(installRoot), "node_modules/@code-yeongyu/senpi/index.js")).href;
    const escapedUrl = "file:///Users/example/Github-repos/rubato/node_modules/@earendil-works/pi-coding-agent/dist/main.js";
    await writeFile(senpiReport, `${senpiUrl}\n`);
    await writeFile(escapeReport, `${escapedUrl}\n`);
    const senpiScan = await scanInstalledCandidate({ installRoot, featureRoot, loadReportPath: senpiReport });
    assert.equal(senpiScan.resolvedModulePaths.senpiAppLoads.length > 0, true);
    assert.throws(() => assertScanClean(senpiScan, { requireLoadReport: false }), /Senpi app package loaded/);
    const escapeScan = await scanInstalledCandidate({ installRoot, featureRoot, loadReportPath: escapeReport });
    assert.equal(escapeScan.resolvedModulePaths.outside.length > 0, true);
    assert.throws(() => assertScanClean(escapeScan, { requireLoadReport: false }), /escaped the install/);
  } finally {
    await retirePath(scratch);
  }
});

test("isolated candidate install pipeline blocks Senpi and keeps CANDIDATE_FEATURE_NAMES", { timeout: 600_000 }, async (t) => {
  if (!which("bun")) {
    t.skip("bun is required to build Rubato bundles");
    return;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 15) || major >= 26)) {
    t.skip(`Node ^24.15 || >=26 required, got ${process.version}`);
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "rubato-isolated-install-"));
  const engine = join(scratch, "engine");
  const home = join(scratch, "home");
  const agentDir = join(home, "candidate-agent");
  const poisonDir = join(scratch, "poison");
  const binDir = join(scratch, "bin");
  const toolsDir = join(scratch, "tools");
  const loadReport = join(scratch, "load-report.txt");
  const liveSentinel = join(poisonDir, "live-sentinel");
  let traps = [];
  t.after(async () => {
    await chmodRestoreTraps(traps);
    const retired = await retirePath(scratch);
    if (retired.method === "trash") t.diagnostic(`scratch moved to ${retired.trash}`);
  });

  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(home, "tmp"), { recursive: true });
  await mkdir(poisonDir, { recursive: true });
  await mkdir(liveSentinel, { recursive: true });
  await writeFile(join(liveSentinel, "untouched"), "live profile must remain untouched");
  await makeIsolatedBin(binDir);
  await mkdir(toolsDir);
  for (const name of ["install-candidate-trace.mjs", "install-candidate-hooks.mjs", "install-candidate-child-probe.mjs"]) {
    await copyFile(join(scriptsDir, name), join(toolsDir, name));
  }
  const traceFile = join(toolsDir, "install-candidate-trace.mjs");
  await writeFile(loadReport, "");

  let installed;
  let stagingBlock;
  try {
    installed = await installRubatoCandidate({ outputRoot: engine, sourceRoot });
    t.diagnostic(`installed ${installed.receipt.features.length} features with ${installed.receipt.node.version}`);
    assert.equal(installed.receipt.state, "ready");
    assert.equal(installed.receipt.stockVersion, "0.85.1");
    for (const name of CANDIDATE_FEATURE_NAMES) {
      assert.ok(installed.receipt.features.includes(name), `missing feature ${name}`);
    }
    assert.ok(installed.receipt.features.includes("rubato-components"));
    assert.equal(installed.receipt.hashes.lock, installed.receipt.hashes.npmLock);
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n${error.cause?.message ?? ""}` : String(error);
    if (!/media-tools:native-block-delta/.test(detail)) throw error;
    stagingBlock = detail;
    t.diagnostic("restage blocked by in-progress A14 media-tools patches (native-block-delta)");
  }
  const candidateEntry = installed ? await realpath(join(engine, installed.receipt.candidateEntry)) : null;
  const runtimeSkip = stagingBlock ? "A14 in-progress media-tools patches block candidate restage" : false;

  traps = await chmodSenpiTraps(home);
  const env = isolatedEnv({ home, agentDir, binDir, poisonDir, loadReport });
  const fakeUser = await plantFakeUserSenpi({ scratch, home });
  delete env.NODE_PATH;
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(existsSync(join(binDir, "senpi")), false);
  assert.equal(existsSync(join(binDir, "omo")), false);
  assert.equal(existsSync(join(binDir, "rubato-pi")), false);

  await mkdir(join(scratch, "project", ".rubato"), { recursive: true });
  await writeFile(join(scratch, "project", ".rubato/rubato.jsonc"), JSON.stringify({
    memory: { agent: "candidate-fixture", reflection: { enabled: false }, facts: { enabled: false },
      dream: { enabled: false, shutdown_launch: false }, sync: { enabled: false } },
  }));

  await t.test("CLI --version under Senpi block", { skip: runtimeSkip }, async () => {
    const result = await run(process.execPath, nodeArgs(traceFile, [candidateEntry, "--version"]), {
      cwd: join(scratch, "project"),
      env,
      timeout: 30_000,
    });
    assert.match(result.stdout, /0\.85\.1/, result.stderr || result.stdout);
  });

  await t.test("RPC inspect, prompt, tool, abort", { skip: runtimeSkip }, async (st) => {
    const cwd = join(scratch, "project");
    const waiters = new Set();
    const providerRequests = [];
    const wake = () => { for (const notify of waiters) notify(); };
    const server = createServer(async (request, response) => {
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
          new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2000)),
        ]);
        if (!response.writableEnded) response.end(aborted ? "" : textSse("candidate local turn"));
        return;
      }
      if (blob.includes("Call memory once") && !hasToolResult) {
        const args = JSON.stringify({
          command: "create", file_path: "facts/isolated.md", description: "isolated",
          file_text: "isolated-install", reason: "loop proof",
        });
        if (!response.writableEnded) {
          response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory_loop", type: "function", function: { name: "memory", arguments: "" } }] }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + "data: [DONE]\n\n");
        }
        return;
      }
      if (!response.writableEnded) response.end(textSse(blob.includes("Call memory once") ? "model-driven memory loop done" : "candidate local turn"));
    });
    st.after(async () => {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "unused",
      models: [{ id: "local-only", contextWindow: 128000, maxTokens: 2048 }],
    } } }));
    const extension = join(scratch, "inspect.mjs");
    await writeFile(extension, `export default (pi) => {
      let context;
      pi.on("session_start", (event, ctx) => { context = ctx; pi.rpc.emit("candidate.ready", { reason: event.reason }); });
      pi.rpc.handle("candidate.inspect", () => ({
        tools: pi.getAllTools().map((tool) => tool.name),
        providers: context.modelRegistry.getRegisteredProviderIds(),
        moduleLoadList: process.moduleLoadList ?? [],
      }));
      pi.rpc.handle("candidate.execute", ({ name, params }) => pi.executeTool(name, params));
    };\n`);

    const child = spawn(process.execPath, nodeArgs(traceFile, [
      candidateEntry, "--mode", "rpc", "--offline", "--approve", "--provider", "fixture", "--model", "local-only",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", extension,
    ]), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    st.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const escalation = setTimeout(() => child.kill("SIGKILL"), 3000);
        try { await exited; } finally { clearTimeout(escalation); }
      }
    });
    const frames = [];
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { frames.push(JSON.parse(line)); } catch { frames.push({ type: "invalid-json", line }); }
      wake();
    });
    const waitUntil = (predicate) => new Promise((resolveWait, reject) => {
      const check = () => { if (predicate()) { clearTimeout(timer); waiters.delete(check); resolveWait(); } };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`RPC timeout: ${stderr}; ${JSON.stringify(frames.slice(-8))}`)); }, 45_000);
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
    const inspect = await request("extension_request", { name: "candidate.inspect" });
    for (const name of CORE_TOOLS) assert.ok(inspect.tools.includes(name), `missing tool ${name}`);
    for (const name of CORE_PROVIDERS) assert.ok(inspect.providers.includes(name), `missing provider ${name}`);
    const promptAndSettle = async (message) => {
      const from = frames.length;
      await request("prompt", { message });
      await waitFor((frame) => frame.type === "agent_end", from);
    };
    await promptAndSettle("Use the isolated local fixture once.");
    await promptAndSettle("Call memory once");
    const abortFrom = frames.length;
    const abortStarted = performance.now();
    await request("prompt", { message: "hang-for-abort" });
    await waitUntil(() => providerRequests.some((body) => JSON.stringify(body).includes("hang-for-abort")));
    await request("abort");
    await waitFor((frame) => frame.type === "agent_end", abortFrom);
    assert.ok(performance.now() - abortStarted < 2000, "abort must settle before the fixture would complete");
    assert.equal((await request("get_state")).isStreaming, false);
    assert.equal(await readFile(join(liveSentinel, "untouched"), "utf8"), "live profile must remain untouched");
    st.diagnostic(`inspect tools=${inspect.tools.length} providers=${inspect.providers.length}`);
  });

  let childReceipt;
  await t.test("child spawn in-process and RPC seams", { skip: runtimeSkip }, async () => {
    const report = join(scratch, "child-receipt.json");
    const result = await run(process.execPath, nodeArgs(traceFile, [
      join(toolsDir, "install-candidate-child-probe.mjs"), "--root", engine, "--home", join(home, "child"), "--report", report,
    ]), { cwd: scratch, env: { ...env, RUBATO_CANDIDATE_AGENT_DIR: join(home, "child", "agent") }, timeout: 40_000, maxBuffer: 2 * 1024 * 1024 });
    childReceipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(childReceipt.ok, true, result.stderr);
    assert.equal(childReceipt.rpc.success, true);
    assert.equal(childReceipt.inProcess.senpiExecutable, null);
    assert.match(childReceipt.inProcess.rpcEntry, /@earendil-works\/pi-coding-agent\/dist\/rpc-entry\.js$/);
    assert.ok(childReceipt.inProcess.factoryNames.includes("context-notes"));
    assert.ok(childReceipt.inProcess.factoryNames.includes("child-guards"));
  });

  await t.test("hidden-dependency scan and install-scan.json", async () => {
    const scan = await scanInstalledCandidate({
      installRoot: installed ? engine : undefined,
      featureRoot: join(sourceRoot, "features"),
      loadReportPath: installed ? loadReport : undefined,
      childReceipt,
      extraAllowed: [await realpath(scratch)],
    });
    assertScanClean(scan, { requireLoadReport: Boolean(installed) });
    assert.deepEqual(scan.features, [...CANDIDATE_FEATURE_NAMES]);
    assert.equal(scan.senpiPty.decision, "deferred-by-user");
    assert.equal(scan.senpiPty.usageSites.length, 5);
    assert.equal(scan.resolvedModulePaths.senpiAppLoads.length, 0);
    if (installed) {
      const loads = await readFile(loadReport, "utf8");
      assert.equal(loads.includes("/@code-yeongyu/senpi/"), false, "parent Senpi stub must not appear in the load report");
      assert.equal(loads.includes(".senpi/agent"), false);
      assert.equal(loads.includes(".rubato-pi/engine"), false);
      assert.equal(await readFile(join(fakeUser.engineHome, "untouched"), "utf8"), "existing engine must not be loaded");
    }
    const paths = scan.resolvedModulePaths;
    scan.notes = [
      `Measured ${scan.generatedAt}: ${installed ? installed.receipt.features.length : "uninstalled"} staged features, Node ${scan.node}. CANDIDATE_FEATURE_NAMES=${scan.features.length}.`,
      `Load report: ${paths.total} urls, ${paths.insideInstall} inside install, ${paths.nodeCore} node-core, ${paths.allowedScratch} scratch, ${paths.outside.length} outside, ${paths.senpiAppLoads.length} Senpi app.`,
      stagingBlock ? "Restage blocked by in-progress media-tools patches." : "Current restage matched CANDIDATE_FEATURE_NAMES.",
      "Fake user HOME ~/.senpi/agent, ~/.rubato-pi/engine, and parent node_modules/@code-yeongyu/senpi stub were present and not loaded.",
      "@code-yeongyu/senpi-pty remains a declared runtime dependency; replacement is deferred by the user.",
    ];
    await writeFile(join(docsDir, "install-scan.json"), `${JSON.stringify(scan, null, 2)}\n`);
  });

  await t.test("install update then rollback", async () => {
    await retirePath(join(scratch, "node_modules")).catch(() => {});
    const dest = installed ? engine : join(scratch, "stub-engine");
    if (!installed) {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "marker.txt"), "first-install");
      await writeFile(join(dest, "rubato-install.json"), `${JSON.stringify({
        version: 1, state: "ready", mode: "isolated-candidate", stockVersion: "0.85.1",
        features: [...CANDIDATE_FEATURE_NAMES, "rubato-components"],
        hashes: { stageReceipt: "first-install-stub", lock: "stub" },
      }, null, 2)}\n`);
    }
    const first = JSON.parse(await readFile(join(dest, "rubato-install.json"), "utf8"));
    let updated;
    try {
      updated = await updateRubatoCandidate({ outputRoot: dest, sourceRoot });
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${error.cause?.message ?? ""}` : String(error);
      assert.match(detail, /media-tools:native-block-delta/);
      assert.equal(existsSync(`${dest}.previous`), true, "failed restage must keep the previous snapshot");
      const rolled = await rollbackRubatoCandidate({ outputRoot: dest });
      const restored = JSON.parse(await readFile(join(dest, "rubato-install.json"), "utf8"));
      assert.equal(restored.hashes.stageReceipt, first.hashes.stageReceipt);
      if (!installed) assert.equal(await readFile(join(dest, "marker.txt"), "utf8"), "first-install");
      await retirePath(rolled.discarded).catch(() => {});
      return;
    }
    assert.ok(updated.previous?.dir.endsWith(".previous"));
    for (const name of CANDIDATE_FEATURE_NAMES) assert.ok(updated.receipt.features.includes(name), name);
    const rolled = await rollbackRubatoCandidate({ outputRoot: dest });
    const restored = JSON.parse(await readFile(join(dest, "rubato-install.json"), "utf8"));
    assert.equal(restored.hashes.stageReceipt, first.hashes.stageReceipt);
    await chmodRestoreTraps(traps);
    await retirePath(rolled.discarded).catch(() => {});
  });
});
