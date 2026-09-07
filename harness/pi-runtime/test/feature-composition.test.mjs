import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { stagePiRuntime } from "../stage-runtime.mjs";
import { patches } from "../features/reload/patches.mjs";
import { createMcpExtension } from "../features/mcp/index.mjs";

const run = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("staged binary and actual SDK compose reload veto with MCP resource lifecycle", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-pi-composition-"));
  let session;
  t.after(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    await rm(scratch, { recursive: true, force: true });
  });
  const probePath = join(scratch, "dependency-probe.mjs");
  await writeFile(probePath, `import {findPackageJSON} from "node:module";
import {readFileSync} from "node:fs";
export const versions = Object.fromEntries(["typebox", "@babel/parser"].map(name =>
  [name, JSON.parse(readFileSync(findPackageJSON(name, import.meta.url), "utf8")).version]));\n`);
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: [
    { id: "reload", patches },
    { id: "dependency-probe", patches: [], files: [{ target: "runtime", version: "0.85.1", path: "rubato-features/dependency-probe/probe.mjs", sourcePath: probePath }] },
  ] });
  const probe = await import(pathToFileURL(join(staged.root, "rubato-features/dependency-probe/probe.mjs")));
  assert.deepEqual(probe.versions, { typebox: "1.3.18", "@babel/parser": "8.0.4" });
  const agentDir = join(scratch, "agent");
  const cwd = join(scratch, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const env = { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_COMPILE_CACHE;
  const nodeResult = await run(process.execPath, [staged.runtime.patchableCliEntry, "--version"], { cwd, env, timeout: 10_000 });
  assert.equal(nodeResult.stdout.trim(), "0.85.1");
  const bin = join(staged.root, staged.receipt.binEntry);
  const binResult = process.platform === "win32"
    ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${bin}.cmd" --version"`], { cwd, env, timeout: 10_000, windowsVerbatimArguments: true })
    : await run(bin, ["--version"], { cwd, env, timeout: 10_000 });
  assert.equal(binResult.stdout.trim(), "0.85.1");

  const sdk = await import(pathToFileURL(staged.runtime.sdkEntry));
  const markerPath = join(scratch, "mcp.log");
  let veto = true;
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "test-reload-guard", factory: (pi) => pi.on("session_before_reload", () => veto ? { cancel: true, reason: "active work" } : undefined) },
      { name: "rubato-mcp", factory: createMcpExtension({ servers: [{
        name: "composition", type: "stdio", command: process.execPath,
        args: [join(sourceRoot, "features/mcp/fake-server.mjs")],
        env: { RUBATO_MCP_TEST_MARKER: markerPath }, requestTimeoutMs: 2_000,
      }] }) },
    ],
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd) }));
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const markerCount = async (marker) => (await readFile(markerPath, "utf8")).split("\n").filter((line) => line === marker).length;
  const tool = () => session.getToolDefinition("mcp__composition_echo");
  const first = tool();
  assert.ok(first);
  assert.equal((await first.execute("one", { value: "before" })).content[0].text, "echo:before");
  assert.deepEqual(await session.reload(), { cancelled: true, reason: "active work" });
  assert.equal(tool(), first);
  assert.equal(await markerCount("initialized"), 1);
  assert.equal(await markerCount("exit"), 0);

  veto = false;
  assert.deepEqual(await session.reload(), { cancelled: false });
  assert.notEqual(tool(), first);
  assert.equal(await markerCount("initialized"), 2);
  assert.equal(await markerCount("exit"), 1);
  assert.equal((await tool().execute("two", { value: "after" })).content[0].text, "echo:after");
  await assert.rejects(first.execute("stale", {}), /closed/);
  assert.deepEqual(errors, []);
  assert.equal(staged.receipt.fullRubatoParity, false);
});
