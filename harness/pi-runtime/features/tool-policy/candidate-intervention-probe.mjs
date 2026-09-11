import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (typeof root !== "string" || !isAbsolute(root)) {
  console.error("Usage: node candidate-intervention-probe.mjs /absolute/staged-candidate-root");
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "rubato-a3-intervention-"));
const home = join(scratch, "home");
const agentDir = join(home, "candidate-agent");
const cwd = join(scratch, "project");
const hookLog = join(scratch, "hook.log");
const hookScript = join(agentDir, "hook.mjs");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });
await writeFile(hookScript, `import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(hookLog)}, input + "\\n");
const event = JSON.parse(input);
if (event.event === "PreToolUse") process.exitCode = 2;
`);
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
await writeFile(join(agentDir, "hooks.json"), JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "memory", hooks: [{ type: "command", command, timeout: 2 }] }],
  },
}));

process.env.HOME = home;
process.env.PI_OFFLINE = "1";
process.env.NO_COLOR = "1";
process.env.RUBATO_SPEED_INDEX = "0";
process.env.RUBATO_NO_KIRO_ENSURE = "1";
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_DATA_HOME = join(home, ".local/share");
process.env.XDG_STATE_HOME = join(home, ".local/state");
delete process.env.PI_MANAGED_INSTALL_ROOT;
delete process.env.PI_PACKAGE_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.RUBATO_PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");

const sdk = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const { createRubatoExtensionFactories } = await import(pathToFileURL(join(root, "rubato-features/rubato-components/bootstrap.mjs")).href);
const settingsManager = sdk.SettingsManager.inMemory();
const modelRuntime = await sdk.ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const assembled = createRubatoExtensionFactories({
  cwd, agentDir, settingsManager, modelRuntime,
  codemodeOptions: { complete: async () => { throw new Error("Provider calls are forbidden in A3 probe"); } },
  providerOptions: {
    env: { PI_OFFLINE: "1", RUBATO_SPEED_INDEX: "0", RUBATO_NO_KIRO_ENSURE: "1" },
    kiro: { ensureKiro: async () => { throw new Error("Kiro daemon launch is forbidden in A3 probe"); } },
  },
});
const names = assembled.extensionFactories.map(({ name }) => name);
const indexOf = (name) => {
  const index = names.indexOf(name);
  assert.notEqual(index, -1, `missing factory ${name}: ${names.join(",")}`);
  return index;
};
assert.ok(indexOf("rubato-loop-guard") < indexOf("rubato-hooks"));
assert.ok(indexOf("rubato-hooks") < indexOf("rubato-permission"));
assert.ok(indexOf("rubato-permission") < indexOf("rubato-gpt-apply-patch"));
assert.ok(indexOf("rubato-gpt-apply-patch") < indexOf("rubato-bash-timeout"));
assert.ok(indexOf("rubato-bash-timeout") < indexOf("terminal"));
assert.ok(indexOf("terminal") < indexOf("rubato-tool-pair-guard"));

const permissionReplies = [];
let api;
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [...assembled.extensionFactories, { name: "a3-probe", factory: (pi) => {
    api = pi;
    pi.events.on("permission_replied", (data) => permissionReplies.push(data));
  } }],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, [], "candidate factories must register");
const { session } = await sdk.createAgentSession({
  cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
  sessionManager: sdk.SessionManager.inMemory(cwd),
});
const errors = [];
try {
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [], "session_start handlers must bind");
  const permissionResult = await session.extensionRunner.emitToolCall({
    type: "tool_call", toolCallId: "a3-permission", toolName: "lsp_diagnostics", input: {},
  });
  assert.equal(permissionResult, undefined);
  const allow = permissionReplies.find((entry) => entry?.reply === "allow" && entry?.toolName === "lsp_diagnostics");
  assert.ok(allow, `permission did not allow: ${JSON.stringify(permissionReplies)}`);
  await assert.rejects(
    api.executeTool("memory", {
      command: "create", file_path: "facts/a3.md", description: "blocked", file_text: "no", reason: "probe",
    }),
    (error) => error.code === "blocked" && error.message === "PreToolUse hook blocked the tool call.",
  );
  const logged = await readFile(hookLog, "utf8");
  assert.match(logged, /"event":"PreToolUse"/);
  assert.match(logged, /"tool_name":"memory"/);
  process.stdout.write(`A3_INTERVENTION ${JSON.stringify({
    factories: names,
    permissionReply: allow.reply,
    permissionTool: allow.toolName,
    hookBlockedMemory: true,
    hookLog: logged.trim(),
    isolatedHome: home,
  })}\n`);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  await rm(scratch, { recursive: true, force: true });
}
