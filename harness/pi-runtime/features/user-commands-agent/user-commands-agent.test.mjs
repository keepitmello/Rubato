import assert from "node:assert/strict";
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
import { WAKE_SOURCE_STATE_EVENT } from "./goal/extension.mjs";
import { goalStoreRef } from "./goal/store.mjs";
import { DEFAULT_TODO_NAG_TEXT } from "./goal/todo-nag.mjs";
import { parseLoopArgs, intervalToMs } from "./loop/parse.mjs";
import { parseRef, rewriteSessionCwd } from "./import-repro/extension.mjs";
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
  assert.ok(files.every((entry) => entry.target === "runtime" && entry.version === "0.85.1"));
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

test("stock slash-command API registers all six commands and rubato-features.json drops them", async () => {
  const enabled = await session();
  const registered = commandNames(enabled.session);
  for (const name of ["goal", "loop", "btw", "ttsr", "fallback", "ir"]) {
    assert.equal(registered.includes(name), true, name + " missing");
  }
  const disabledNames = USER_COMMAND_FACTORY_NAMES;
  writeFileSync(join(enabled.agentDir, "rubato-features.json"), JSON.stringify({ disabled: disabledNames }));
  const disabled = readDisabledFeatures({ agentDir: enabled.agentDir, env: {} });
  const toggled = applyFeatureToggles(createUserCommandsAgentFactories({ agentDir: enabled.agentDir }), disabled);
  assert.deepEqual(toggled.extensionFactories, []);
  assert.deepEqual(toggled.disabled.sort(), [...disabledNames].sort());

  const dropped = await session({ disabled: ["rubato-goal", "rubato-btw", "rubato-model-fallback"] });
  const left = commandNames(dropped.session);
  assert.equal(left.includes("goal"), false);
  assert.equal(left.includes("btw"), false);
  assert.equal(left.includes("fallback"), false);
  assert.equal(left.includes("loop"), true);
  assert.equal(left.includes("ttsr"), true);
  assert.equal(left.includes("ir"), true);
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

test("/goal todo nag is default-on like Senpi and can be turned off", async () => {
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
  async function runTodo(todoNag) {
    const fixture = await session({ only: ["rubato-goal"], extraFactories: [todoStub], noTools: "builtin", todoNag });
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
  const on = await runTodo(true);
  assert.match(on.text, /<system-reminder>/);
  assert.equal(on.text.includes(DEFAULT_TODO_NAG_TEXT), true);
  const off = await runTodo(false);
  assert.equal(off.text.includes(DEFAULT_TODO_NAG_TEXT), false);
  assert.doesNotMatch(off.text, /<system-reminder>/);
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
  assert.match(captures[0].context.systemPrompt ?? "", /side question/);
  assert.equal(typeof before, "number");
});

test("/fallback saves a chain and /fallback now switches the model observed on the session", async () => {
  const fixture = await session({ only: ["rubato-model-fallback"] });
  assert.equal(fixture.session.model.id, "alpha");
  await fixture.session.prompt("/fallback fixture/alpha fixture/beta");
  assert.match(fixture.notices.at(-1).message, /Fallback chain saved/);
  await fixture.session.prompt("/fallback now");
  await waitIdle(fixture.session);
  assert.equal(fixture.session.model.provider, "fixture");
  assert.equal(fixture.session.model.id, "beta");
  assert.match(fixture.notices.at(-1).message, /Switched to fallback model fixture\/beta/);
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

test("/ttsr reports builtin stream-quality detectors", async () => {
  const fixture = await session({ only: ["rubato-ttsr"] });
  await fixture.session.prompt("/ttsr");
  const text = fixture.notices.at(-1).message;
  assert.match(text, /TTSR stream rules/);
  assert.match(text, /collapse-repetition/);
  assert.match(text, /control-token-leak/);
  assert.match(text, /repetitive-turns/);
});

test("/ir imports a local jsonl repro into the session directory and switches to it", async () => {
  const fixture = await session({ only: ["rubato-import-repro"], persisted: true });
  const source = join(fixture.cwd, "repro.jsonl");
  const header = { type: "session", id: "imported-repro", cwd: "/ci/pi-ci-0123456789abcdef0123456789abcdef", timestamp: new Date().toISOString(), version: 3 };
  const user = { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "imported hello" }], timestamp: Date.now() } };
  writeFileSync(source, JSON.stringify(header) + "\n" + JSON.stringify(user) + "\n");
  await fixture.session.prompt("/ir " + source);
  await waitIdle(fixture.session);
  assert.match(fixture.notices.map((n) => n.message).join("\n"), /Imported session imported-repro/);
  assert.equal(fixture.switches.at(-1)?.id, "imported-repro");
  assert.equal(fixture.switches.at(-1)?.cwd, fixture.cwd);
  const parsed = parseRef("https://gist.github.com/mitsuhiko/b4d100022aefb12f25dd2d8485e0a82a");
  assert.equal(parsed.type, "gist");
  const rewritten = rewriteSessionCwd('{"cwd":"/old/path"}', "/old/path", "/new/path");
  assert.match(rewritten, /\/new\/path/);
});

test("/ir gist import uses the injected local fetch mock, never the network", async () => {
  const gistId = "b4d100022aefb12f25dd2d8485e0a82a";
  const header = { type: "session", id: "gist-repro", cwd: "/ci/work", timestamp: new Date().toISOString(), version: 3 };
  const user = { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "from gist" }], timestamp: Date.now() } };
  const jsonl = JSON.stringify(header) + "\n" + JSON.stringify(user) + "\n";
  const fixture = await session({
    only: ["rubato-import-repro"],
    persisted: true,
    fetch: async (url) => {
      assert.match(String(url), /api\.github\.com\/gists\//);
      return {
        ok: true,
        status: 200,
        async json() {
          return { files: { "session.jsonl": { filename: "session.jsonl", content: jsonl } } };
        },
        async text() { return jsonl; },
      };
    },
  });
  await fixture.session.prompt("/ir " + gistId);
  await waitIdle(fixture.session);
  assert.equal(fixture.switches.at(-1)?.id, "gist-repro");
  assert.match(fixture.notices.map((n) => n.message).join("\n"), /Imported session gist-repro/);
});
 
test("stock RPC get_commands lists the six commands and /fallback now is visible in get_state", async (t) => {
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
  for (const name of ["goal", "loop", "btw", "ttsr", "fallback", "ir"]) {
    assert.equal(names.includes(name), true, name + " missing from RPC get_commands: " + names.join(","));
  }
  const saved = await request("fb1", "prompt", { message: "/fallback fixture/alpha fixture/beta" });
  assert.equal(saved.success, true, stderr);
  const switched = await request("fb2", "prompt", { message: "/fallback now" });
  assert.equal(switched.success, true, stderr);
  const state = await request("state", "get_state");
  assert.equal(state.success, true, stderr);
  assert.equal(state.data.model.id, "beta");
  child.kill("SIGTERM");
});
