import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Type } from "typebox";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "./index.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-tool-execution-"));
const stagedRoot = join(scratchRoot, "runtime");

after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({
  sourceRoot: runtimeRoot,
  outputRoot: stagedRoot,
  features: [toolExecutionFeature],
});

async function createFixture(t) {
  const runtime = resolvePiRuntime({ root: stagedRoot });
  const {
    createAgentSession,
    DefaultResourceLoader,
    ExecuteToolError,
    SessionManager,
    SettingsManager,
  } = await import(`${pathToFileURL(runtime.sdkEntry).href}?fixture=${Date.now()}-${Math.random()}`);
  const cwd = join(scratchRoot, `cwd-${Math.random()}`);
  const agentDir = join(scratchRoot, `agent-${Math.random()}`);
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  const calls = [];
  const events = [];
  let extensionApi;
  let activations = 0;
  const factory = (pi) => {
    extensionApi = pi;
    const definition = (name, execute) => ({
      name,
      label: name,
      description: `${name} fixture`,
      parameters: Type.Object({ value: Type.String() }),
      execute,
    });
    pi.registerTool(definition("mock", async (_id, args, _signal, onUpdate) => {
      calls.push(["mock", args.value]);
      onUpdate?.({ content: [{ type: "text", text: `update:${args.value}` }], details: {} });
      return {
        content: [{ type: "text", text: `raw:${args.value}` }],
        details: { raw: true },
        usage: { input: 1 },
        addedToolNames: ["fixture-added"],
        terminate: true,
      };
    }));
    pi.registerTool(definition("fails", async () => {
      throw new Error("fixture exploded");
    }));
    pi.registerTool(definition("slow", async (_id, _args, signal) => {
      await new Promise((resolveWait, reject) => {
        const timer = setTimeout(resolveWait, 5_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
        }, { once: true });
      });
      return { content: [{ type: "text", text: "too late" }], details: {} };
    }));
    pi.registerTool(definition("lazy", async (_id, args) => ({
      content: [{ type: "text", text: `lazy:${args.value}` }],
      details: {},
    })));
    pi.registerTool({
      ...definition("no_lazy", async () => ({ content: [], details: {} })),
      allowLazyActivation: false,
    });
    pi.registerLazyToolActivator((name) => {
      if (name !== "lazy" && name !== "no_lazy") return false;
      activations += 1;
      pi.setActiveTools([...pi.getActiveTools(), name]);
      return true;
    });
    pi.on("tool_call", (event) => {
      events.push(["call", event.toolName, event.input.value]);
      if (event.input.value === "block") return { block: true, reason: "fixture policy" };
      event.input.value = `${event.input.value}:mutated`;
      return undefined;
    });
    pi.on("tool_result", (event) => {
      events.push(["result", event.toolName, event.isError]);
      if (event.toolName === "mock") {
        return {
          content: [{ type: "text", text: `hook:${event.content[0].text}` }],
          details: { hooked: true },
          usage: { input: 2 },
          isError: true,
        };
      }
      return undefined;
    });
  };

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "tool-execution-fixture", factory }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  session.setActiveToolsByName(["mock", "fails", "slow"]);
  return { session, ExecuteToolError, get api() { return extensionApi; }, calls, events, get activations() { return activations; } };
}

test("actual stock SDK executeTool validates, runs hooks, streams updates, and classifies lookup failures", async (t) => {
  const fixture = await createFixture(t);
  const updates = [];
  const result = await fixture.api.executeTool("mock", { value: "ok" }, {
    onUpdate: (update) => updates.push(update.content[0].text),
  });
  assert.deepEqual(fixture.calls, [["mock", "ok:mutated"]]);
  assert.deepEqual(updates, ["update:ok:mutated"]);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hook:raw:ok:mutated" }],
    details: { hooked: true },
    usage: { input: 2 },
    addedToolNames: ["fixture-added"],
    terminate: true,
    isError: true,
  });
  assert.deepEqual(fixture.events.slice(0, 2), [
    ["call", "mock", "ok"],
    ["result", "mock", false],
  ]);

  await assert.rejects(
    fixture.api.executeTool("mock", {}),
    (error) => error instanceof fixture.ExecuteToolError && error.code === "invalid_params",
  );
  await assert.rejects(
    fixture.api.executeTool("mock", { value: "block" }),
    (error) => error instanceof fixture.ExecuteToolError && error.code === "blocked" && /fixture policy/.test(error.message),
  );
  await assert.rejects(
    fixture.api.executeTool("missing", {}),
    (error) => error instanceof fixture.ExecuteToolError && error.code === "unknown_tool",
  );
  await assert.rejects(
    fixture.api.executeTool("lazy", { value: "x" }),
    (error) => error instanceof fixture.ExecuteToolError && error.code === "inactive_tool",
  );
});

test("inactive activation is owner-controlled, tool errors and aborts become hooked results", async (t) => {
  const fixture = await createFixture(t);
  const lazy = await fixture.api.executeTool("lazy", { value: "same-turn" }, { activateInactiveTool: true });
  assert.equal(lazy.content[0].text, "lazy:same-turn:mutated");
  assert.equal(fixture.activations, 1);
  assert.ok(fixture.api.getActiveTools().includes("lazy"));

  await assert.rejects(
    fixture.api.executeTool("no_lazy", { value: "x" }, { activateInactiveTool: true }),
    (error) => error instanceof fixture.ExecuteToolError && error.code === "inactive_tool",
  );
  assert.equal(fixture.activations, 1, "hard-disabled tool never reaches an activator");

  const failed = await fixture.api.executeTool("fails", { value: "error" });
  assert.equal(failed.content[0].text, "fixture exploded");
  assert.equal(failed.details.isError, true);
  assert.deepEqual(fixture.events.at(-1), ["result", "fails", true]);

  const controller = new AbortController();
  const pending = fixture.api.executeTool("slow", { value: "abort" }, { signal: controller.signal });
  controller.abort(new Error("fixture cancelled"));
  const aborted = await pending;
  assert.equal(aborted.content[0].text, "fixture cancelled");
  assert.equal(aborted.details.isError, true);
  assert.deepEqual(fixture.events.at(-1), ["result", "slow", true]);
});

test("reload binds one fresh lazy activator instead of retaining stale extension APIs", async (t) => {
  const fixture = await createFixture(t);
  const firstApi = fixture.api;
  await fixture.session.reload();
  assert.notEqual(fixture.api, firstApi);
  fixture.session.setActiveToolsByName(["mock"]);
  await fixture.api.executeTool("lazy", { value: "reload" }, { activateInactiveTool: true });
  assert.equal(fixture.activations, 1);
  assert.throws(() => firstApi.getActiveTools(), /stale after session replacement or reload/);
});
