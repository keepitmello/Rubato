import assert from "node:assert/strict";
import { PI_VERSION } from "../rubato-components/pi-version.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { sessionPromptFeature } from "../session-prompt/patches.mjs";
import { runtimeFactoriesFeature } from "../runtime-factories/feature.mjs";
import { files, patches, promptRulesFeature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-prompt-rules-"));
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "stage"),
  features: [runtimeFactoriesFeature, sessionPromptFeature, promptRulesFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);
// 0.86.0: provider stream 입력이 Context -> TranscriptContext 로 바뀌었다. TranscriptContext
// 에는 messages 만 있으므로 시스템 프롬프트와 도구 목록을 messages 에서 되짚어 읽는다.
const { getCurrentSystemPrompt, getCurrentTools } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/transcript.js",
)).href);
const promptRules = await import(pathToFileURL(join(
  staged.root,
  "rubato-features/prompt-rules/index.mjs",
)).href);

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const clean = { ...env, ...extra };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_COMPILE_CACHE;
  return clean;
}

function model() {
  return {
    provider: "prompt-rules-test",
    id: "fake-model",
    name: "Offline prompt rules fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: "openai-completions",
    provider: "prompt-rules-test",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function complete(message) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: "SED", message });
  return stream;
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function createFixture({ cwd, agentDir, homeDir, sessionManager, flags = new Map(), tools = ["read", "todo"], extraFactories = [], env: extraEnv = {} }) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "prompt-rules-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [{
          id: "fake-model",
          name: "Offline prompt rules fixture",
          input: ["text", "image"],
          contextWindow: 100_000,
          maxTokens: 4096,
        }],
      },
    },
  }));
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    extensionFlagValues: flags,
    modelRuntimeSignal: AbortSignal.timeout(5_000),
    createExtensionFactories: ({ settingsManager: canonicalSettings }) => [
      ...promptRules.createPromptRulesExtensionFactories({
        settingsManager: canonicalSettings,
        env: { HOME: homeDir, ...extraEnv },
      }),
      ...extraFactories,
    ],
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    model: model(),
    tools,
  });
  const errors = [];
  const notices = [];
  await result.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
      setWidget() {},
    },
    onError(error) { errors.push(error); },
  });
  assert.deepEqual(result.extensionsResult.errors, []);
  return { ...result, services, settingsManager, errors, notices };
}

function createInstructionProject(name) {
  const cwd = join(scratch, name);
  const agentDir = join(scratch, `${name}-agent`);
  const homeDir = join(scratch, `${name}-home`);
  const targetDir = join(cwd, "packages/app/src");
  mkdirSync(join(cwd, ".claude/rules"), { recursive: true });
  mkdirSync(join(cwd, ".cursor/rules"), { recursive: true });
  mkdirSync(join(cwd, "packages/app"), { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(cwd, "package.json"), "{}\n");
  writeFileSync(join(cwd, "AGENTS.md"), "ROOT_AGENT_ONLY\n");
  writeFileSync(join(cwd, "packages/app/AGENTS.md"), "NESTED_AGENT_ONLY\n");
  writeFileSync(join(cwd, ".claude/rules/static.md"), "---\nalwaysApply: true\n---\nSTATIC_RULE_ONLY\n");
  writeFileSync(join(cwd, ".cursor/rules/typescript.mdc"), "---\nglobs: ['**/*.ts']\n---\nDYNAMIC_RULE_ONLY\n");
  const target = join(targetDir, "thing.ts");
  writeFileSync(target, "export const value = 1;\n");
  return { cwd, agentDir, homeDir, target };
}

test("feature is additive-only, stock-version locked, and stages a complete owned closure", () => {
  assert.equal(promptRulesFeature.id, "prompt-rules");
  assert.deepEqual(patches, []);
  assert.deepEqual(files.map((entry) => entry.path), [
    "rubato-features/prompt-rules/index.mjs",
    "rubato-features/prompt-rules/instructions.mjs",
    "rubato-features/prompt-rules/todo.mjs",
    "rubato-features/prompt-rules/role-prompt.mjs",
    "rubato-features/prompt-rules/THIRD_PARTY_NOTICES.md",
  ]);
  assert.ok(files.every((entry) => entry.target === "runtime" && entry.version === PI_VERSION));
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.equal(staged.receipt.addedFiles.filter((entry) => entry.feature === "prompt-rules").length, files.length);
  for (const entry of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
  assert.match(readFileSync(join(staged.root, "rubato-features/prompt-rules/THIRD_PARTY_NOTICES.md"), "utf8"), /MIT/);
});

test("a wake-started run carries the same session prompt as a prompted run", async (t) => {
  // A background notification or child completion starts its run through
  // sendCustomMessage(triggerTurn), which never emits before_agent_start. The session
  // prompt must not depend on that event: a wake request that loses it rewrites the
  // cached prefix twice and runs the model without its instructions (audit 2026-09-23).
  const project = createInstructionProject("wake-prompt");
  const fixture = await createFixture({
    ...project,
    sessionManager: sdk.SessionManager.inMemory(project.cwd),
  });
  t.after(() => fixture.session.dispose());
  const prompts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return complete(assistant("ok"));
  };

  await fixture.session.prompt("hello");
  await fixture.session.sendCustomMessage(
    { customType: "wake-fixture", content: "background job finished", display: false },
    { triggerTurn: true },
  );

  assert.deepEqual(fixture.errors, []);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /<Task_Management>/);
  assert.equal(prompts[1], prompts[0]);
});

test("the role prompt keeps the rules and todo sections composed before it", async (t) => {
  // In production the role prompt is active and rebuilds the prompt; sections contributed by
  // handlers registered before it were dropped from every real request until 2026-09-23.
  const project = createInstructionProject("role-keeps-sections");
  const rubatoPi = resolve(sourceRoot, "../rubato-pi/src");
  const fixture = await createFixture({
    ...project,
    sessionManager: sdk.SessionManager.inMemory(project.cwd),
    env: {
      RUBATO_PI_ROLE: "lead",
      RUBATO_ROLE_PROMPT_MODULE: pathToFileURL(join(rubatoPi, "system-prompt.mjs")).href,
      RUBATO_ROLE_CONTRACT_MODULE: pathToFileURL(join(rubatoPi, "role-contract.mjs")).href,
    },
  });
  t.after(() => fixture.session.dispose());
  const prompts = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return complete(assistant("ok"));
  };
  await fixture.session.prompt("hello");
  assert.deepEqual(fixture.errors, []);
  assert.match(prompts[0], /# Working agreement/);
  assert.match(prompts[0], /<Task_Management>/);
  assert.match(prompts[0], /STATIC_RULE_ONLY/);
});

test("a wake-started first run waits for before_run readiness before declaring its tools", async (t) => {
  // MCP attaches in the background after session_start and used to be awaited only on
  // before_agent_start. A reopened session whose first run was a wake sent its first
  // request without those tools, then added them one request later: two full misses.
  let release;
  const attached = new Promise((resolve) => { release = resolve; });
  const lateTool = {
    name: "late_tool",
    label: "Late tool",
    description: "Registered after an async attach.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: "text", text: "ok" }] }; },
  };
  const lateAttach = (pi) => {
    let attach = Promise.resolve();
    pi.on("session_start", () => {
      attach = attached.then(() => {
        pi.registerTool(lateTool);
        if (!pi.getActiveTools().includes("late_tool")) pi.setActiveTools([...pi.getActiveTools(), "late_tool"]);
      });
    });
    pi.on("before_run", async () => { await attach; });
  };
  const project = createInstructionProject("wake-tools");
  const fixture = await createFixture({
    ...project,
    sessionManager: sdk.SessionManager.inMemory(project.cwd),
    extraFactories: [{ name: "late-attach", factory: lateAttach }],
    tools: ["read", "todo", "late_tool"],
  });
  t.after(() => fixture.session.dispose());
  const toolLists = [];
  fixture.session.agent.streamFunction = (_model, context) => {
    toolLists.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return complete(assistant("ok"));
  };

  setTimeout(() => release(), 20);
  await fixture.session.sendCustomMessage(
    { customType: "wake-fixture", content: "background job finished", display: false },
    { triggerTurn: true },
  );

  assert.deepEqual(fixture.errors, []);
  assert.equal(toolLists.length, 1);
  assert.ok(toolLists[0].includes("late_tool"), JSON.stringify(toolLists[0]));
});

test("freshly staged stock SDK consumes native root, static rule, nested AGENTS, and matching dynamic rule", async (t) => {
  const project = createInstructionProject("instructions-on");
  const fixture = await createFixture({
    ...project,
    sessionManager: sdk.SessionManager.inMemory(project.cwd),
  });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  let call = 0;
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages),
      tools: getCurrentTools(context.messages).map((tool) => tool.name),
    });
    const response = call === 0
      ? assistant([{ type: "toolCall", id: "read-nested", name: "read", arguments: { path: project.target } }], "toolUse")
      : assistant("done");
    call += 1;
    return complete(response);
  };

  await fixture.session.prompt("Read the nested TypeScript file");
  assert.deepEqual(fixture.errors, []);
  assert.equal(contexts.length, 2);
  assert.match(contexts[0].systemPrompt, /ROOT_AGENT_ONLY/);
  assert.match(contexts[0].systemPrompt, /STATIC_RULE_ONLY/);
  assert.match(contexts[0].systemPrompt, /<Task_Management>/);
  assert.equal(contexts[0].systemPrompt.match(/ROOT_AGENT_ONLY/g)?.length, 1, "native root context is not re-added as a rule");
  assert.ok(contexts[0].tools.includes("todo"));

  const readResult = contexts[1].messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-nested");
  assert.ok(readResult, JSON.stringify(contexts[1].messages));
  const readText = textOf(readResult);
  assert.match(readText, /export const value = 1/);
  assert.match(readText, /\[Directory Context: .*packages\/app\/AGENTS\.md\]/);
  assert.match(readText, /NESTED_AGENT_ONLY/);
  assert.match(readText, /DYNAMIC_RULE_ONLY/);
  assert.doesNotMatch(readText, /STATIC_RULE_ONLY/, "static rules are not duplicated in tool results");
  assert.doesNotMatch(readText, /ROOT_AGENT_ONLY/, "root AGENTS remains native prompt context only");

  writeFileSync(join(project.cwd, "packages/app/AGENTS.md"), "NESTED_AGENT_RELOADED\n");
  writeFileSync(join(project.cwd, ".cursor/rules/typescript.mdc"), "---\nglobs: ['**/*.ts']\n---\nDYNAMIC_RULE_RELOADED\n");
  await fixture.session.reload();
  const reloadedContexts = [];
  call = 0;
  fixture.session.agent.streamFunction = (_model, context) => {
    reloadedContexts.push({ systemPrompt: getCurrentSystemPrompt(context.messages), messages: structuredClone(context.messages) });
    const response = call === 0
      ? assistant([{ type: "toolCall", id: "read-reloaded", name: "read", arguments: { path: project.target } }], "toolUse")
      : assistant("reloaded done");
    call += 1;
    return complete(response);
  };
  await fixture.session.prompt("Read again after reload");
  const reloadedResult = reloadedContexts[1].messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-reloaded");
  assert.match(textOf(reloadedResult), /NESTED_AGENT_RELOADED/);
  assert.match(textOf(reloadedResult), /DYNAMIC_RULE_RELOADED/);
});

test("stock extension flags turn nested and rule injection off without disabling native context or todo", async (t) => {
  const project = createInstructionProject("instructions-off");
  const fixture = await createFixture({
    ...project,
    flags: new Map([
      ["no-nested-agents", true],
      ["pi-rules-mode", "off"],
    ]),
    sessionManager: sdk.SessionManager.inMemory(project.cwd),
  });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  let call = 0;
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push({ systemPrompt: getCurrentSystemPrompt(context.messages), messages: structuredClone(context.messages) });
    const response = call === 0
      ? assistant([{ type: "toolCall", id: "read-disabled", name: "read", arguments: { path: project.target } }], "toolUse")
      : assistant("done");
    call += 1;
    return complete(response);
  };
  await fixture.session.prompt("Read with optional instruction features disabled");
  assert.match(contexts[0].systemPrompt, /ROOT_AGENT_ONLY/);
  assert.match(contexts[0].systemPrompt, /<Task_Management>/);
  assert.doesNotMatch(contexts[0].systemPrompt, /STATIC_RULE_ONLY/);
  const result = contexts[1].messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-disabled");
  assert.doesNotMatch(textOf(result), /NESTED_AGENT_ONLY|DYNAMIC_RULE_ONLY/);
});

test("todo tool persists senpi.todo-state and restores exact phase state after stock reload", async (t) => {
  const cwd = join(scratch, "todo-project");
  const agentDir = join(scratch, "todo-agent");
  const homeDir = join(scratch, "todo-home");
  const sessionDir = join(scratch, "todo-sessions");
  for (const path of [cwd, agentDir, homeDir, sessionDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(cwd, "package.json"), "{}\n");
  const manager = sdk.SessionManager.create(cwd, sessionDir, { id: "prompt-rules-todo" });
  const fixture = await createFixture({ cwd, agentDir, homeDir, sessionManager: manager, tools: ["todo"] });
  t.after(() => fixture.session.dispose());
  const contexts = [];
  let call = 0;
  fixture.session.agent.streamFunction = (_model, context) => {
    contexts.push({ systemPrompt: getCurrentSystemPrompt(context.messages), messages: structuredClone(context.messages) });
    const responses = [
      assistant([{ type: "toolCall", id: "todo-init", name: "todo", arguments: {
        op: "init",
        list: [{ phase: "Build", items: ["Inspect contract", "Verify runtime"] }],
      } }], "toolUse"),
      assistant([{ type: "toolCall", id: "todo-done", name: "todo", arguments: {
        op: "done",
        task: "Inspect contract",
      } }], "toolUse"),
      assistant("todo complete"),
    ];
    const response = responses[call];
    call += 1;
    return complete(response);
  };
  await fixture.session.prompt("Track and perform two steps");
  assert.equal(contexts.length, 3);
  assert.match(contexts[0].systemPrompt, /<Task_Management>/);
  const stateEntries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "senpi.todo-state");
  assert.equal(stateEntries.length, 2);
  assert.deepEqual(stateEntries.at(-1).data.phases, [{
    name: "Build",
    tasks: [
      { content: "Inspect contract", status: "completed" },
      { content: "Verify runtime", status: "in_progress" },
    ],
  }]);
  assert.ok(manager.getSessionFile() && existsSync(manager.getSessionFile()), "completed provider turn persisted the session file");

  const entriesBeforeView = manager.getBranch().length;
  await fixture.session.reload();
  const todoTool = fixture.session.agent.state.tools.find((tool) => tool.name === "todo");
  assert.ok(todoTool, "todo remains active after stock extension reload");
  const view = await todoTool.execute("todo-view-after-reload", { op: "view" });
  assert.deepEqual(view.details.phases, stateEntries.at(-1).data.phases);
  assert.match(textOf(view), /Verify runtime \[in_progress\]/);
  assert.equal(manager.getBranch().length, entriesBeforeView, "view is read-only and appends no state entry");
});
