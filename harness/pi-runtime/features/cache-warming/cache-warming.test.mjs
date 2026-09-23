import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { cacheWarmingFeature } from "./patches.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-cache-warming-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "stage"), features: [cacheWarmingFeature] });
const runtime = resolvePiRuntime({ root: staged.root });
const { CacheWarmer } = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/core/cache-warmer.js")).href);
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);

const MIN = 60_000;
const usage = { input: 0, output: 1, cacheRead: 300_000, cacheWrite: 0, totalTokens: 300_001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function model(provider) {
  return { provider, id: `${provider}-model`, api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
}

function harness(provider, userAt) {
  const branch = [
    { type: "message", message: { role: "user", timestamp: userAt } },
    { type: "message", message: { role: "assistant", usage } },
  ];
  const warms = [];
  const calls = [];
  const models = {
    streamSimple(requestModel, _context, options) {
      calls.push(options);
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", provider: requestModel.provider, model: requestModel.id, usage, stopReason: "stop", content: [] };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (provider === "openai-codex") {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          options.signal.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }));
          return;
        }
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  };
  const sessionManager = {
    getBranch: () => branch,
    appendUsage: (kind, p, m, u, note) => { const entry = { kind, provider: p, note, at: Date.now() }; warms.push(entry); return entry; },
  };
  const warmer = new CacheWarmer(models, sessionManager, () => "idle");
  return { warmer, warms, calls, branch };
}

async function advance(ms) {
  mock.timers.tick(ms);
  for (let i = 0; i < 20; i += 1) await new Promise((resolveTick) => setImmediate(resolveTick));
}

test("Claude warms every 40 minutes until two hours after the latest user input", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms, calls } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.state, "scheduled");
  assert.equal(warmer.status.nextWarmAt, 40 * MIN);

  await advance(40 * MIN);
  await advance(40 * MIN);
  assert.equal(warms.length, 2);
  assert.equal(calls[0].maxTokens, 1);
  // The next refresh would land at 2h, the horizon: warming stops instead.
  await advance(40 * MIN);
  assert.equal(warms.length, 2);
  assert.equal(warmer.status.state, "inactive");
  assert.match(warmer.status.reason, /two hours since the latest user input/);
});

test("Codex warms every 20 minutes and stops each refresh after prefill", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms } = harness("openai-codex", 0);
  warmer.start({ model: model("openai-codex"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.nextWarmAt, 20 * MIN);
  await advance(20 * MIN);
  assert.equal(warms.length, 1);
  assert.equal(warms[0].note, "stopped after prefill");
  for (let step = 0; step < 4; step += 1) await advance(20 * MIN);
  assert.equal(warms.length, 5, "20, 40, 60, 80, 100 minutes");
  await advance(20 * MIN);
  assert.equal(warms.length, 5);
});

test("a request that disabled caching is not warmed", () => {
  const { warmer } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: { cacheRetention: "none" } }, () => true);
  assert.equal(warmer.status.state, "inactive");
});

test("a response that server-compacted ends warming instead of replaying the old prefix", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms, branch } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  branch.push({ type: "message", message: { role: "assistant", usage, content: [{ type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "summary" } }] } });
  warmer.onAgentSettled();
  await advance(40 * MIN);
  assert.equal(warms.length, 0);
  assert.match(warmer.status.reason, /server compaction replaced the prefix/);
});
