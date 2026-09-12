// Real staged Pi SDK/validator/extension hooks and the real Cursor exec bridge.
// No model request, credentials, or live profile are used.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiRuntime } from "../resolve-runtime.mjs";
import { stagePiRuntime } from "../stage-runtime.mjs";
import { providersFeature } from "../features/providers/patches.mjs";
import { toolExecutionFeature } from "../features/tool-execution/patches.mjs";
import { providerExecutionFeature } from "../features/provider-execution/patches.mjs";

test("staged native write/edit use real Pi validation and session middleware", { timeout: 90_000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-native-files-"));
  let session;
  const savedEnv = Object.fromEntries(["HOME", "PI_OFFLINE", "PI_PACKAGE_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].map((key) => [key, process.env[key]]));
  t.after(async () => {
    await session?.dispose();
    await rm(scratch, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const root = join(scratch, "runtime");
  await stagePiRuntime({ sourceRoot: join(import.meta.dirname, ".."), outputRoot: root,
    features: [toolExecutionFeature, providersFeature, providerExecutionFeature] });
  const runtime = resolvePiRuntime({ root });
  const cwd = join(scratch, "cwd"), agentDir = join(scratch, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  Object.assign(process.env, { HOME: scratch, PI_OFFLINE: "1", PI_PACKAGE_DIR: runtime.codingAgentDir,
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions") });
  const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);
  const { createCursorExecBridge } = await import(pathToFileURL(join(
    runtime.packages["@earendil-works/pi-ai"].dir,
    "dist/rubato-features/provider-execution/cursor-exec-bridge.mjs",
  )).href);
  const hooks = [];
  let deny = true;
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "native-file-observer", factory: (pi) => {
      pi.on("tool_call", (event) => {
        hooks.push(["call", event.toolName, event.toolCallId]);
        if (deny) return { block: true, reason: "fixture denies file mutations" };
      });
      pi.on("tool_result", (event) => {
        hooks.push(["result", event.toolName, event.toolCallId]);
        return { content: [{ type: "text", text: "result middleware ran" }] };
      });
    } }],
  });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, tools: ["read"],
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: { id: "fixture", name: "Fixture", provider: "openai", api: "openai-completions",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
  });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  await session.bindExtensions({ onError: (error) => assert.fail(error) });
  const bridge = createCursorExecBridge({ cwd, agentDir, lineageId: "native-file-regression",
    executeTool: (name, args, options) => session.executeTool(name, args, options) });
  const blocked = await bridge.piWrite({ execId: "blocked", toolCallId: "blocked",
    args: { path: "file", content: "bad" } });
  assert.equal(blocked.isError, true);
  assert.equal(existsSync(join(cwd, "file")), false);
  assert.deepEqual(hooks, [["call", "write", "blocked"]]);

  deny = false; hooks.length = 0;
  const allowed = await bridge.piWrite({ execId: "allowed", toolCallId: "allowed",
    args: { path: "file", content: "before" } });
  assert.equal(allowed.isError, false);
  assert.equal(allowed.content[0].text, "result middleware ran");
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "before");
  assert.deepEqual(hooks, [["call", "write", "allowed"], ["result", "write", "allowed"]]);
  assert.equal(session.getActiveToolNames().includes("write"), false, "native availability does not expose write to the model");

  await chmod(join(cwd, "file"), 0o755);
  await symlink("file", join(cwd, "link"));
  const edited = await bridge.piEdit({ execId: "edit", toolCallId: "edit",
    args: { path: "link", edits: [{ oldText: "before", newText: "after" }] } });
  assert.equal(edited.isError, false);
  assert.equal((await lstat(join(cwd, "link"))).isSymbolicLink(), true);
  assert.equal((await stat(join(cwd, "file"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "after");

  hooks.length = 0;
  // Pi's validator coerces a number into a string, so `path: 123` would be
  // accepted here exactly as it is for any registered tool. An empty path is
  // the schema violation that must fail before permission or result hooks run.
  const invalid = await bridge.piWrite({ execId: "invalid", toolCallId: "invalid",
    args: { path: "", content: "bad" } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(hooks, [], "real schema validation rejects before middleware");

  const binary = await bridge.write({ execId: "binary", toolCallId: "binary",
    path: "binary", fileBytes: new Uint8Array([0, 255, 128]) });
  assert.equal(binary.isError, false);
  assert.deepEqual(await readFile(join(cwd, "binary")), Buffer.from([0, 255, 128]));
  hooks.length = 0;
  const replay = await bridge.piWrite({ execId: "allowed", toolCallId: "allowed",
    args: { path: "file", content: "must-not-run-again" } });
  assert.equal(replay.isError, false);
  assert.deepEqual(hooks, []);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "after");
});
