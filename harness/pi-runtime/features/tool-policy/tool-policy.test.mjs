import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { toolPolicyFeature } from "./feature.mjs";
import { runCommandHook } from "./hooks.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-tool-policy-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({
  sourceRoot: runtimeRoot,
  outputRoot: stagedRoot,
  features: [toolExecutionFeature, toolPolicyFeature],
});

async function createFixture(t, options = {}) {
  const runtime = resolvePiRuntime({ root: stagedRoot });
  const sdk = await import(`${pathToFileURL(runtime.sdkEntry).href}?tool-policy=${Date.now()}-${Math.random()}`);
  const policy = await import(`${pathToFileURL(join(stagedRoot, "rubato-features/tool-policy/index.mjs")).href}?fixture=${Math.random()}`);
  const cwd = await mkdtemp(join(scratchRoot, "cwd-"));
  const agentDir = await mkdtemp(join(scratchRoot, "agent-"));
  const hookScript = join(cwd, "hook.mjs");
  await writeFile(hookScript, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.event === "PreToolUse" && event.tool_input.value === "deny") {
  process.stderr.write("private detail");
  process.exitCode = 2;
} else if (event.event === "PreToolUse" && event.tool_input.value === "mutate") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { value: "changed" }, additionalContext: "pre-context"
  }}));
} else if (event.event === "PostToolUse") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PostToolUse", updatedToolOutput: "post-output", additionalContext: "post-context"
  }}));
} else if (event.event === "UserPromptSubmit") {
  process.stdout.write(JSON.stringify({ additionalContext: "prompt-context", systemMessage: "prompt-system" }));
} else if (event.event === "SessionStart" || event.event === "PostCompact") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: event.event, additionalContext: event.event + "-context"
  }}));
} else if (event.event === "PreCompact") {
  process.stdout.write(JSON.stringify({ decision: "block", reason: "keep-context" }));
} else if (event.event === "Stop") {
  process.stdout.write(JSON.stringify({ decision: "block", reason: "continue-working" }));
}
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
  const hookConfig = structuredClone(options.hookConfig ?? { hooks: {
    PreToolUse: [{ matcher: "fixture", hooks: [{ type: "command", command, timeout: 2 }] }],
    PostToolUse: [{ matcher: "fixture", hooks: [{ type: "command", command, timeout: 2 }] }],
  } });
  for (const groups of Object.values(hookConfig.hooks ?? {})) {
    for (const group of groups) for (const handler of group.hooks ?? []) {
      if (handler.command === "unused") handler.command = command;
    }
  }
  let extensionApi;
  let executions = 0;
  const approvalRequests = [];
  const persisted = [];
  const followUps = [];
  const toolFactory = (pi) => {
    extensionApi = pi;
    pi.registerTool({
      name: "fixture",
      label: "fixture",
      description: "policy fixture",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, input) {
        executions += 1;
        return { content: [{ type: "text", text: `raw:${input.value}` }], details: { raw: true } };
      },
    });
  };
  const hookFactory = policy.createHooksExtension({
    resolveSources: async () => options.hooks === false ? [] : [{
      sourcePath: hookScript,
      scope: "project",
      displayOrder: 0,
      trusted: true,
      config: hookConfig,
    }],
    sendFollowUp: async (text) => followUps.push(text),
  });
  const permissionFactory = policy.createPermissionExtension({
    resolveSettings: async () => options.permission ?? { preset: "full-access" },
    requestApproval: options.requestApproval ? async (request, ctx) => {
      approvalRequests.push(request);
      return options.requestApproval(request, ctx);
    } : undefined,
    persistApproved: async (_ctx, rules) => persisted.push(...rules),
  });
  const bashFactory = policy.createBashTimeoutExtension({
    env: { PI_BASH_DEFAULT_TIMEOUT_SECONDS: "42", PI_BASH_MAX_TIMEOUT_SECONDS: "10" },
    resolveForegroundWindowSeconds: () => 15,
    isAnthropicBashEnabled: () => false,
  });
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    followUps,
    agentDir,
    settingsManager,
    extensionFactories: [
      { name: "hooks", factory: hookFactory },
      { name: "permission", factory: permissionFactory },
      { name: "bash-timeout", factory: bashFactory },
      { name: "fixture", factory: toolFactory },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  session.setActiveToolsByName(["fixture"]);
  return {
    api: extensionApi,
    approvalRequests,
    cwd,
    get executions() { return executions; },
    persisted,
    policy,
    session,
  };
}

test("actual stock executor applies trusted Pre/PostToolUse mutation, context, and exit-2 blocking", async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.api.executeTool("fixture", { value: "mutate" });
  assert.equal(fixture.executions, 1);
  assert.deepEqual(result.content.map(({ text }) => text), ["post-output", "post-context", "pre-context"]);
  assert.deepEqual(result.details, { raw: true });

  await assert.rejects(
    fixture.api.executeTool("fixture", { value: "deny" }),
    (error) => error.code === "blocked" && error.message === "PreToolUse hook blocked the tool call.",
  );
  assert.equal(fixture.executions, 1, "blocked hook never reaches permission or tool execution");
});

test("stock lifecycle events drive prompt context, compact cancellation, post-compact, and bounded Stop follow-up", async (t) => {
  const hook = (event, matcher = event) => [{ matcher, hooks: [{ type: "command", command: "unused", timeout: 2 }] }];
  const fixture = await createFixture(t, { hookConfig: { hooks: {
    UserPromptSubmit: hook("UserPromptSubmit"),
    SessionStart: hook("SessionStart", "SessionStart|startup"),
    PreCompact: hook("PreCompact", "PreCompact|manual"),
    PostCompact: hook("PostCompact", "PostCompact|manual"),
    Stop: hook("Stop"),
  } } });

  const promptInput = await fixture.session.extensionRunner.emitInput("hello", undefined, "interactive");
  assert.deepEqual(promptInput, { action: "continue" });
  const prompt = await fixture.session.extensionRunner.emitBeforeAgentStart("hello", undefined, "BASE", { cwd: fixture.cwd });
  assert.deepEqual(prompt.messages?.map(({ content }) => content), ["prompt-context"]);
  assert.match(prompt.systemPrompt, /^BASE\n\nprompt-system\n## Bash Tool Timeout Policy/);

  const signal = new AbortController().signal;
  const compact = await fixture.session.extensionRunner.emit({
    type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal,
  });
  assert.deepEqual(compact, { cancel: true });
  await fixture.session.extensionRunner.emit({
    type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false,
  });
  await fixture.session.extensionRunner.emit({
    type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }],
  });
  assert.deepEqual(fixture.followUps, ["continue-working"]);
});

test("permission presets deny asks without UI and always approval covers the session then persists", async (t) => {
  const denied = await createFixture(t, { hooks: false, permission: { preset: "read-only" } });
  await assert.rejects(
    denied.api.executeTool("fixture", { value: "no" }),
    (error) => error.code === "blocked" && /Permission required for fixture/.test(error.message),
  );
  assert.equal(denied.executions, 0);

  let approvals = 0;
  const approved = await createFixture(t, {
    hooks: false,
    permission: { preset: "ask" },
    requestApproval: async () => { approvals += 1; return { reply: "always" }; },
  });
  await approved.api.executeTool("fixture", { value: "one" });
  await approved.api.executeTool("fixture", { value: "two" });
  assert.equal(approvals, 1, "always approval covers later matching calls in the same session");
  assert.equal(approved.executions, 2);
  await approved.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  assert.deepEqual(approved.persisted, [{ permission: "fixture", pattern: "*", action: "allow" }]);
});

test("bash timeout mutates missing values, preserves explicit values, and contributes detach prompt", async (t) => {
  const fixture = await createFixture(t, { hooks: false });
  const missing = { command: "sleep 1" };
  assert.equal(await fixture.session.extensionRunner.emitToolCall({
    type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: missing,
  }), undefined);
  assert.equal(missing.timeout, 42);
  const explicit = { command: "sleep 1", timeout: 7 };
  await fixture.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "bash-2", toolName: "bash", input: explicit });
  assert.equal(explicit.timeout, 7);
  const prompt = await fixture.session.extensionRunner.emitBeforeAgentStart("prompt", undefined, "BASE", { cwd: fixture.cwd });
  assert.match(prompt.systemPrompt, /Default timeout: 42s/);
  assert.match(prompt.systemPrompt, /~15s window/);
});

test("command hook timeout kills its isolated subprocess and reports timeout without hanging", async (t) => {
  const cwd = await mkdtemp(join(scratchRoot, "timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const handler = {
    source: { sourcePath: "<timeout>", scope: "runtime" },
    config: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 5000)")}`, timeout: 0.05 },
  };
  const started = Date.now();
  const result = await runCommandHook(handler, { event: "PreToolUse" }, { cwd });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 2_000);
});
