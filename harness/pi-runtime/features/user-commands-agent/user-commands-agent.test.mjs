import assert from "node:assert/strict";
import { PI_VERSION } from "../rubato-components/pi-version.mjs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test, { after } from "node:test";
import { Type } from "typebox";
import { files, patches, userCommandsAgentFeature } from "./feature.mjs";
import { USER_COMMAND_FACTORY_NAMES, createUserCommandsAgentFactories } from "./index.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { SESSION_HELD_QUERY_EVENT, WAKE_SOURCE_STATE_EVENT } from "./goal/extension.mjs";
import { createGoal, goalStoreRef, readGoal } from "./goal/store.mjs";
import { DEFAULT_TODO_NAG_TEXT } from "./goal/todo-nag.mjs";
import { parseLoopArgs, intervalToMs } from "./loop/parse.mjs";
import {
  commandNames,
  createCommandSession,
  waitIdle,
  isolateHome,
  runtime,
  runtimeRoot,
  complete,
  assistantMessage,
  sdk,
  AssistantMessageEventStream,
} from "./test-harness.mjs";

const fixtures = [];
after(() => {
  for (const fixture of fixtures) {
    try { fixture.session?.dispose?.(); } catch {}
    fixture.restoreEnv?.();
    try { rmSync(fixture.root, { recursive: true, force: true }); } catch {}
  }
});

async function session(options) {
  const fixture = await createCommandSession(options);
  fixtures.push(fixture);
  assert.deepEqual(fixture.errors, []);
  return fixture;
}

test("feature is additive-only, stock-version locked, and named factories match toggles", () => {
  assert.equal(userCommandsAgentFeature.id, "user-commands-agent");
  assert.deepEqual(patches, []);
  assert.ok(files.every((entry) => entry.target === "runtime" && entry.version === PI_VERSION));
  assert.ok(files.every((entry) => existsSync(entry.sourcePath)));
  assert.equal(PI_FEATURE_NAMES.includes("user-commands-agent"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("user-commands-agent"), true);
  const names = createUserCommandsAgentFactories().map((entry) => entry.name);
  assert.deepEqual(names, [...USER_COMMAND_FACTORY_NAMES]);
  for (const entry of files.filter((file) => file.path.endsWith(".mjs"))) {
    const syntax = spawnSync(process.execPath, ["--check", entry.sourcePath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, entry.path + ": " + syntax.stderr);
  }
  assert.match(readFileSync(files.find((file) => file.path.endsWith("THIRD_PARTY_NOTICES.md")).sourcePath, "utf8"), /MIT/);
});

test("stock slash-command API registers all three commands and rubato-features.json drops them", async () => {
  const enabled = await session();
  const registered = commandNames(enabled.session);
  for (const name of ["goal", "loop", "btw"]) {
    assert.equal(registered.includes(name), true, name + " missing");
  }
  const disabledNames = USER_COMMAND_FACTORY_NAMES;
  writeFileSync(join(enabled.agentDir, "rubato-features.json"), JSON.stringify({ disabled: disabledNames }));
  const disabled = readDisabledFeatures({ agentDir: enabled.agentDir, env: {} });
  const toggled = applyFeatureToggles(createUserCommandsAgentFactories({ agentDir: enabled.agentDir }), disabled);
  assert.deepEqual(toggled.extensionFactories, []);
  assert.deepEqual(toggled.disabled.sort(), [...disabledNames].sort());

  const dropped = await session({ disabled: ["rubato-goal", "rubato-btw"] });
  const left = commandNames(dropped.session);
  assert.equal(left.includes("goal"), false);
  assert.equal(left.includes("btw"), false);
  assert.equal(left.includes("loop"), true);
  const bootstrap = readFileSync(new URL("../rubato-components/bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /createUserCommandsAgentFactories/);
  assert.match(bootstrap, /user-commands-agent\/index\.mjs/);
});

test("in-memory goal store uses absolute agentDir, not a relative extensions path", () => {
  const dirs = isolateHome("goal-store-ref-");
  fixtures.push({ root: dirs.root, restoreEnv() {} });
  const manager = sdk.SessionManager.inMemory(dirs.cwd);
  assert.equal(manager.getSessionDir(), "");
  assert.equal(manager.getSessionFile(), undefined);
  const ref = goalStoreRef(manager, dirs.agentDir);
  assert.equal(isAbsolute(ref.baseDir), true);
  assert.equal(ref.baseDir.startsWith(dirs.agentDir), true);
  assert.equal(ref.baseDir.includes("no-session"), true);
});

test("/goal sets, shows, pauses, and clears a persistent goal", async () => {
  const leakDir = join(runtimeRoot, "extensions", "goal", "no-session");
  const leakBefore = existsSync(leakDir) ? readdirSync(leakDir).sort() : [];
  const fixture = await session({ only: ["rubato-goal"] });
  await fixture.session.prompt("/goal ship the stock-pi adapter");
  await waitIdle(fixture.session);
  const setNotice = fixture.notices.at(-1)?.message ?? "";
  assert.match(setNotice, /Objective: ship the stock-pi adapter/);
  assert.match(setNotice, /Status: active/);
  await fixture.session.prompt("/goal");
  assert.match(fixture.notices.at(-1).message, /ship the stock-pi adapter/);
  const continuation = fixture.session.messages.find((message) => message.customType === "goal-continuation" || message.role === "custom");
  assert.ok(continuation, "goal continuation should land in session messages");

  await fixture.session.prompt("/goal pause");
  assert.match(fixture.notices.at(-1).message, /paused/);
  await fixture.session.prompt("/goal resume");
  assert.match(fixture.notices.at(-1).message, /active/);
  // The resumed goal runs its own turns (the fixture model only talks) until it blocks; clearing it then is deterministic.
  await until(async () => (await readGoal(goalStoreRef(fixture.session.sessionManager, fixture.agentDir)))?.status === "blocked", "the resumed goal runs out its turns");
  await fixture.session.prompt("/goal clear");
  assert.match(fixture.notices.at(-1).message, /Goal cleared/);
  await fixture.session.prompt("/goal");
  assert.match(fixture.notices.at(-1).message, /No goal is currently set/);
  const stored = readdirSync(join(fixture.agentDir, "extensions", "goal", "no-session")).filter((name) => name.endsWith(".json"));
  assert.ok(stored.length >= 1, "goal json must live under agentDir");
  const leakAfter = existsSync(leakDir) ? readdirSync(leakDir).sort() : [];
  assert.deepEqual(leakAfter, leakBefore, "goal store must not write into the worktree");
});

test("/goal wake-source counts clear on session_start so codemode can republish", async () => {
  let emitWake;
  const wake = await session({
    only: ["rubato-goal"],
    extraFactories: [{ name: "wake-probe", factory: (pi) => {
      emitWake = (data) => pi.events.emit(WAKE_SOURCE_STATE_EVENT, data);
    } }],
  });
  await wake.session.prompt("/goal keep the wake snapshot");
  await waitIdle(wake.session);
  emitWake({ source: "senpi-codemode", activeCount: 2 });
  await wake.session.prompt("/goal");
  assert.match(wake.notices.at(-1).message, /Wake sources: senpi-codemode=2/);
  await wake.session.reload();
  await waitIdle(wake.session);
  await wake.session.prompt("/goal");
  assert.doesNotMatch(wake.notices.at(-1).message, /Wake sources: senpi-codemode=2/);
  emitWake({ source: "senpi-codemode", activeCount: 2 });
  await wake.session.prompt("/goal");
  assert.match(wake.notices.at(-1).message, /Wake sources: senpi-codemode=2/);
});

test("/goal does not append a create_goal nag onto todo tool results", async () => {
  const leakDir = join(runtimeRoot, "extensions", "goal", "no-session");
  const leakBefore = existsSync(leakDir) ? readdirSync(leakDir).sort() : [];
  const todoStub = { name: "todo-stub", factory: (pi) => {
    pi.registerTool({
      name: "todo",
      label: "Todo",
      description: "Fixture todo tool",
      parameters: Type.Object({ op: Type.String() }, { additionalProperties: true }),
      async execute() {
        return {
          content: [{ type: "text", text: "todo updated" }],
          details: { op: "init", phases: [{ name: "Tasks", tasks: [{ content: "Inspect contract", status: "pending" }] }] },
        };
      },
    });
  } };
  async function runTodo() {
    const fixture = await session({ only: ["rubato-goal"], extraFactories: [todoStub], noTools: "builtin" });
    const contexts = [];
    let call = 0;
    fixture.session.agent.streamFunction = (_model, context) => {
      contexts.push({ messages: structuredClone(context.messages) });
      if (call++ === 0) {
        return complete(assistantMessage([{ type: "toolCall", id: "todo-init", name: "todo", arguments: { op: "init" } }], "toolUse"));
      }
      return complete("ok");
    };
    await fixture.session.prompt("track the work");
    await waitIdle(fixture.session);
    const result = contexts.flatMap((entry) => entry.messages).find((message) => message.role === "toolResult" && message.toolCallId === "todo-init");
    const text = typeof result?.content === "string" ? result.content : (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return { fixture, text, contexts };
  }
  const result = await runTodo();
  assert.equal(result.text.includes("todo updated"), true);
  assert.doesNotMatch(result.text, /<system-reminder>/);
  assert.equal(result.text.includes(DEFAULT_TODO_NAG_TEXT), false);
  const leakAfter = existsSync(leakDir) ? readdirSync(leakDir).sort() : [];
  assert.deepEqual(leakAfter, leakBefore, "goal store must not write into the worktree");
});

test("/btw answers a side question without appending it as the main user turn", async () => {
  const captures = [];
  const fixture = await session({
    only: ["rubato-btw"],
    captures,
    btwReply: "side-answer",
  });
  const before = fixture.session.messages.length;
  await fixture.session.prompt("/btw what was the last file?");
  await waitIdle(fixture.session);
  assert.match(fixture.notices.at(-1)?.message ?? "", /side-answer/);
  const userTurns = fixture.session.messages.filter((message) => message.role === "user");
  assert.equal(userTurns.some((message) => String(message.content).includes("what was the last file")), false);
  assert.ok(captures.length >= 1, "side query should hit the model stream");
  assert.match(captures[0].systemPrompt ?? "", /side question/);
  assert.equal(typeof before, "number");
});

test("/loop arms a schedule and a fake clock fires the tick into the session", async () => {
  const pending = new Map();
  const timerPort = {
    arm(key, _dueAt, callback) { pending.set(key, callback); },
    cancel(key) { pending.delete(key); },
    cancelAll() { pending.clear(); },
  };
  const fixture = await session({ only: ["rubato-loop"], timerPort });
  await fixture.session.prompt("/loop 1s ping the deploy");
  await waitIdle(fixture.session);
  assert.match(fixture.notices.at(-1).message, /Loop loop-/);
  assert.equal(pending.size, 1);
  const before = fixture.session.messages.length;
  [...pending.values()][0]();
  await waitIdle(fixture.session);
  const texts = fixture.session.messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text).filter(Boolean).join("\n");
    return "";
  }).join("\n");
  assert.match(texts, /ping the deploy/);
  await fixture.session.prompt("/loop stop all");
  assert.equal(pending.size, 0);
  assert.equal(typeof before, "number");
  assert.equal(parseLoopArgs("1s ping").kind, "fixed");
  assert.equal(intervalToMs({ value: 1, unit: "s" }), 1000);
});

test("stock RPC get_commands lists the three commands and /fallback is gone", async (t) => {
  const dirs = isolateHome("rubato-user-commands-rpc-");
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    rmSync(dirs.root, { recursive: true, force: true });
  });
  mkdirSync(join(dirs.agentDir, "sessions"), { recursive: true });
  writeFileSync(join(dirs.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-key",
        models: [
          { id: "alpha", name: "Fixture alpha", input: ["text"], contextWindow: 100000, maxTokens: 4096 },
          { id: "beta", name: "Fixture beta", input: ["text"], contextWindow: 100000, maxTokens: 4096 },
        ],
      },
    },
  }));
  const extension = join(dirs.root, "extension.mjs");
  writeFileSync(extension, [
    "import { createUserCommandsAgentFactories } from " + JSON.stringify(new URL("./index.mjs", import.meta.url).href) + ";",
    "export default async (pi) => {",
    "  for (const entry of createUserCommandsAgentFactories({ agentDir: process.env.PI_CODING_AGENT_DIR })) {",
    "    await entry.factory(pi);",
    "  }",
    "};",
    "",
  ].join("\n"));
  const env = { ...process.env, HOME: dirs.homeDir, PI_CODING_AGENT_DIR: dirs.agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
  delete env.NODE_OPTIONS; delete env.NODE_COMPILE_CACHE;
  let child = spawn(process.execPath, [runtime.rpcEntry ?? join(runtime.codingAgentDir, "dist/rpc-entry.js"), "--offline", "--approve", "--provider", "fixture", "--model", "alpha",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
    "--session-dir", join(dirs.agentDir, "sessions"), "--extension", extension], { cwd: dirs.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { try { frames.push(JSON.parse(line)); } catch {} for (const notify of waiters) notify(); });
  const waitFor = (predicate) => new Promise((resolvePromise, reject) => {
    const finish = () => {
      const found = frames.find(predicate);
      if (found) { clearTimeout(timer); waiters.delete(finish); resolvePromise(found); }
    };
    const timer = setTimeout(() => { waiters.delete(finish); reject(new Error("RPC timeout: " + stderr)); }, 12000);
    waiters.add(finish); finish();
  });
  const request = async (id, type, data = {}) => {
    child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
    return waitFor((frame) => frame.type === "response" && frame.id === id);
  };
  const commands = await request("cmds", "get_commands");
  assert.equal(commands.success, true, stderr);
  const names = (commands.data?.commands ?? []).map((command) => command.name);
  for (const name of ["goal", "loop", "btw"]) {
    assert.equal(names.includes(name), true, name + " missing from RPC get_commands: " + names.join(","));
  }
  assert.equal(names.includes("fallback"), false, "/fallback is not a Rubato command: " + names.join(","));
  child.kill("SIGTERM");
});

// A goal keeps taking turns by itself: what ends it is the model (update_goal) or a rule that stops a goal making no progress.
const goalRef = (fixture) => goalStoreRef(fixture.session.sessionManager, fixture.agentDir);
const until = async (check, what, ms = 8000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out: " + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const toolCall = (name, args) => complete([{ type: "toolCall", id: "call-" + Math.random().toString(36).slice(2), name, arguments: args }]);

test("an active goal starts the lead's next turn every time one ends, until the model calls it complete", async () => {
  const captures = [];
  const fixture = await session({ only: ["rubato-goal"], captures, tools: ["update_goal"],
    streamSimple: (model, context) => {
      captures.push({ model: model.id });
      return captures.length === 3 ? toolCall("update_goal", { status: "complete" }) : complete(captures.length === 4 ? "all done" : "working on it");
    } });
  await fixture.session.prompt("/goal ship the importer");
  await until(async () => (await readGoal(goalRef(fixture)))?.status === "complete", "the goal completes");
  await until(async () => captures.length === 4 && !fixture.session.isStreaming, "the turn after the tool result ends");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(captures.length, 4, "two turns that only said 'working on it', the turn that completed it, and its closing answer; then nothing more");
});

test("three automatic goal turns in a row that touch no tool block the goal with the reason, and no turn follows", async () => {
  const captures = [];
  const fixture = await session({ only: ["rubato-goal"], captures, tools: ["update_goal"],
    streamSimple: (model) => { captures.push({ model: model.id }); return complete("Next I will check the tests."); } });
  await fixture.session.prompt("/goal make the tests pass");
  await until(async () => (await readGoal(goalRef(fixture)))?.status === "blocked", "the goal blocks");
  const goal = await readGoal(goalRef(fixture));
  assert.match(goal.blockedReason, /3 goal turns in a row used no tool/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(captures.length, 3);
});

test("a stopped turn pauses the goal and a failed one blocks it; neither is continued", async () => {
  const stopped = [];
  const first = await session({ only: ["rubato-goal"], captures: stopped, tools: ["update_goal"],
    streamSimple: (model, context, options) => {
      stopped.push({ model: model.id });
      const stream = new AssistantMessageEventStream();
      const message = assistantMessage([], "aborted");
      options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...message, errorMessage: "stopped" } }), { once: true });
      return stream;
    } });
  await first.session.prompt("/goal long job");
  await until(() => stopped.length === 1, "the continuation asks the model");
  await first.session.abort();
  await until(async () => (await readGoal(goalRef(first)))?.status === "paused", "the goal pauses");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(stopped.length, 1, "a paused goal starts nothing");

  const failed = [];
  const second = await session({ only: ["rubato-goal"], captures: failed, tools: ["update_goal"],
    streamSimple: (model) => {
      failed.push({ model: model.id });
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: { ...assistantMessage([], "error"), errorMessage: "provider down" } });
      return stream;
    } });
  second.session.setAutoRetryEnabled?.(false);
  await second.session.prompt("/goal long job");
  await until(async () => (await readGoal(goalRef(second)))?.status === "blocked", "the goal blocks", 15000);
  assert.match((await readGoal(goalRef(second))).blockedReason, /ended with an error: provider down/);
});

test("a message another extension holds for the lead starts the next turn itself, so the goal sends none", async () => {
  const captures = [];
  const fixture = await session({ only: ["rubato-goal"], captures, tools: ["update_goal"],
    extraFactories: [{ name: "held-probe", factory: (pi) => { pi.events.on(SESSION_HELD_QUERY_EVENT, (query) => { query.count += 1; }); } }],
    streamSimple: (model) => { captures.push({ model: model.id }); return complete("ok"); } });
  await fixture.session.prompt("/goal ship it");
  await until(() => captures.length === 1 && !fixture.session.isStreaming, "the first turn ends");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(captures.length, 1, "nothing of the goal's own followed");
  assert.equal((await readGoal(goalRef(fixture))).status, "active", "the goal stays for the held message's turn to carry on");
});

test("a stop that lands after the run's last message pauses the goal instead of letting it restart the work", async () => {
  const captures = [];
  let runner;
  const fixture = await session({ only: ["rubato-goal"], captures, tools: ["update_goal"],
    extraFactories: [{ name: "stop-probe", factory: (pi) => { pi.on("agent_end", async () => { await runner.emit({ type: "session_abort" }); }); } }],
    streamSimple: (model) => { captures.push({ model: model.id }); return complete("ok"); } });
  runner = fixture.session.extensionRunner;
  await fixture.session.prompt("/goal ship it");
  await until(async () => (await readGoal(goalRef(fixture)))?.status === "paused", "the goal pauses");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(captures.length, 1);
});

test("background work holds the goal's next turn back, and it looks again later instead of waiting for a wake that may never come", async () => {
  const captures = [];
  let emitWake;
  const fixture = await session({ only: ["rubato-goal"], captures, tools: ["update_goal"], factoryOptions: { recheckMs: 80 },
    extraFactories: [{ name: "wake-probe", factory: (pi) => { emitWake = (data) => pi.events.emit(WAKE_SOURCE_STATE_EVENT, data); } }],
    streamSimple: (model) => { captures.push({ model: model.id }); return captures.length === 2 ? toolCall("update_goal", { status: "complete" }) : complete("waiting on the server"); } });
  emitWake({ source: "terminal-background-sessions", activeCount: 1 });
  await fixture.session.prompt("/goal keep the dev server up");
  await until(() => captures.length === 1 && !fixture.session.isStreaming, "the first turn ends");
  await until(async () => (await readGoal(goalRef(fixture)))?.status === "complete", "the recheck starts another turn that completes it");
});

test("a goal keeps the whole objective a companion's first message can carry", async () => {
  const fixture = await session({ only: ["rubato-goal"] });
  const objective = "x".repeat(7000) + " acceptance: all green";
  const goal = await createGoal(goalRef(fixture), objective);
  assert.equal(goal.objective, objective);
});
