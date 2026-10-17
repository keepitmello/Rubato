import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Type } from "typebox";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { createDrainGate } from "./gate.mjs";
import { feature, patchAgentLoop, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const stock = resolvePiRuntime({ root: runtimeRoot });
const stockLoop = join(stock.packages["@earendil-works/pi-agent-core"].dir, "dist/agent-loop.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratchRoot = await mkdtemp(join(tmpdir(), "rubato-drain-gate-"));
const stagedRoot = join(scratchRoot, "runtime");
after(() => rm(scratchRoot, { recursive: true, force: true }));

await stagePiRuntime({ sourceRoot: runtimeRoot, outputRoot: stagedRoot, features: await loadPiFeatures(["abort-provenance", "drain-gate"]) });
const staged = resolvePiRuntime({ root: stagedRoot });
const sdk = await import(pathToFileURL(staged.sdkEntry).href);
const { AssistantMessageEventStream } = await import(pathToFileURL(join(staged.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js")).href);
const gate = globalThis[Symbol.for("rubato.drain-gate")];

const until = async (predicate, label) => {
  for (let i = 0; i < 500; i += 1) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timeout: ${label}`);
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content, stopReason) => ({ role: "assistant", content, api: "openai-completions", provider: "drain-test",
  model: "fake-model", usage, stopReason, timestamp: Date.now() });
const streamOf = (message) => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: message.stopReason, message });
  });
  return stream;
};

/** A session on disk whose model calls `work` once, then answers. `work` returns when released. */
async function createFixture(t) {
  const cwd = join(scratchRoot, `cwd-${Math.random()}`);
  const agentDir = join(scratchRoot, `agent-${Math.random()}`);
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "drain-test": {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused-test-key", models: [{ id: "fake-model" }],
  } } }));
  let release;
  let toolStarted = false;
  const factory = (pi) => {
    pi.registerTool({ name: "work", label: "work", description: "fixture", parameters: Type.Object({}),
      execute: async () => {
        toolStarted = true;
        await new Promise((resolveWork) => { release = resolveWork; });
        return { content: [{ type: "text", text: "worked" }], details: {} };
      } });
  };
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "drain-fixture", factory }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: sdk.SessionManager.create(cwd, join(agentDir, "sessions")) });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  session.setActiveToolsByName(["work"]);
  const requests = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(context.messages.map((message) => message.role).filter((role) => role !== "system"));
    return streamOf(requests.length === 1
      ? reply([{ type: "toolCall", id: "call_work", name: "work", arguments: {} }], "toolUse")
      : reply([{ type: "text", text: "done" }], "stop"));
  };
  const ends = [];
  session.subscribe((event) => { if (event.type === "agent_end") ends.push(event); });
  return { session, requests, ends, release: () => release(), get toolStarted() { return toolStarted; } };
}

const persistedRoles = async (session) => (await readFile(session.sessionFile, "utf8")).trim().split("\n")
  .map((line) => JSON.parse(line)).filter((entry) => entry.type === "message" && entry.message.role !== "system").map((entry) => entry.message.role);

test("descriptor is stock-locked, listed on the candidate, and gates the loop once", async () => {
  assert.equal(PI_FEATURE_NAMES.includes("drain-gate"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("drain-gate"), true);
  assert.deepEqual((await loadPiFeatures(["drain-gate"])).map((entry) => entry.id), ["drain-gate"]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockLoop)));
  const patched = patchAgentLoop(readFileSync(stockLoop, "utf8"));
  assert.match(patched, /rubatoDrainGate\.enter\(\)/);
  assert.match(patched, /rubatoDrainGate\.draining && await rubatoDrainGate\.park\(signal\)/);
  assert.throws(() => patchAgentLoop(patched), /pristine/);
  assert.ok(gate, "the staged loop registers the process gate");
});

test("a draining run finishes its tool call, waits before the next request, and an abort ends it without a reply", async (t) => {
  const fixture = await createFixture(t);
  t.after(() => gate.end());
  const run = fixture.session.prompt("go");
  await until(() => fixture.toolStarted, "tool start");
  gate.begin();
  // The tool call the reply asked for is still running: the engine may not close yet.
  assert.equal(gate.active, 1);
  assert.equal(gate.quiet, false);
  fixture.release();
  await until(() => gate.quiet && gate.parked === 1, "parked at the gate");
  assert.equal(fixture.requests.length, 1, "the next request waits");
  assert.deepEqual(await persistedRoles(fixture.session), ["user", "assistant", "toolResult"]);

  await fixture.session.abort();
  await run;
  assert.equal(gate.active, 0);
  assert.equal(fixture.requests.length, 1);
  // No aborted reply joins the file: the next engine continues from the tool result.
  assert.deepEqual(await persistedRoles(fixture.session), ["user", "assistant", "toolResult"]);
  assert.equal(fixture.ends.length, 1);
});

test("a restart that gives up lets the waiting run send its request", async (t) => {
  const fixture = await createFixture(t);
  t.after(() => gate.end());
  const run = fixture.session.prompt("go");
  await until(() => fixture.toolStarted, "tool start");
  gate.begin();
  fixture.release();
  await until(() => gate.parked === 1, "parked");
  gate.end();
  await run;
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1], ["user", "assistant", "toolResult"]);
  assert.deepEqual(await persistedRoles(fixture.session), ["user", "assistant", "toolResult", "assistant"]);
});

test("the gate is quiet only when every running loop waits at it", async () => {
  const local = createDrainGate();
  assert.equal(await local.park(undefined), false, "an open gate never waits");
  const leaveA = local.enter();
  const leaveB = local.enter();
  local.begin();
  const controller = new AbortController();
  const parkedA = local.park(controller.signal);
  assert.equal(local.quiet, false);
  const parkedB = local.park(undefined);
  assert.equal(local.quiet, true);
  controller.abort();
  assert.equal(await parkedA, true);
  leaveA();
  leaveA();
  assert.equal(local.active, 1);
  local.end();
  assert.equal(await parkedB, false);
  leaveB();
  assert.deepEqual([local.active, local.parked], [0, 0]);
});
