import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { cacheWarmingFeature } from "./patches.mjs";
import { COMPANION_ENTRY } from "../../../companion/companion.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-cache-warming-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "stage"), features: [cacheWarmingFeature] });
const runtime = resolvePiRuntime({ root: staged.root });
const { CacheWarmer, RUBATO_CACHE_LIFETIME_MS } = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/core/cache-warmer.js")).href);
const { SessionManager } = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/core/session-manager.js")).href);
const { AssistantMessageEventStream } = await import(pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js",
)).href);

const MIN = 60_000;
const usage = { input: 0, output: 1, cacheRead: 300_000, cacheWrite: 0, totalTokens: 300_001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function model(provider) {
  return { provider, id: `${provider}-model`, api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
}

function harness(provider, userAt, warmUsage = usage) {
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
      const message = { role: "assistant", provider: requestModel.provider, model: requestModel.id, usage: warmUsage, stopReason: "stop", content: [] };
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
    appendCustomEntry: (customType, data) => { branch.push({ type: "custom", customType, data }); },
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
  assert.match(warmer.status.reason, /warming window ended/);
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

test("a session's switch stops only its warmer, stays off across turns, and resumes from the last touch", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms, branch } = harness("anthropic", 0);
  const request = { model: model("anthropic"), context: {}, options: {} };
  warmer.start(request, () => true);
  warmer.onAgentSettled();

  await advance(10 * MIN);
  warmer.setSessionWarming({ enabled: false });
  assert.equal(warmer.status.state, "inactive");
  assert.deepEqual(branch.at(-1), { type: "custom", customType: "rubato.cache-warming", data: { enabled: false } });
  await advance(40 * MIN);
  assert.equal(warms.length, 0);

  // A later turn in the same session is not warmed either.
  warmer.start(request, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.state, "inactive");

  // Back on: the first refresh counts from that turn's request (50m), not from now.
  await advance(20 * MIN);
  warmer.setSessionWarming({ enabled: true });
  assert.equal(warmer.status.state, "scheduled");
  assert.equal(warmer.status.nextWarmAt, 90 * MIN);
  await advance(20 * MIN);
  assert.equal(warms.length, 1);
});

test("a session switched off stays off in a new runtime", () => {
  const { warmer, branch } = harness("anthropic", 0);
  branch.push({ type: "custom", customType: "rubato.cache-warming", data: { enabled: false } });
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  assert.equal(warmer.status.state, "inactive");
  assert.equal(warmer.sessionDisabled(), true);
});

test("warming is on unless the person turned it off in settings", async () => {
  const { SettingsManager } = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/core/settings-manager.js")).href);
  assert.equal(SettingsManager.inMemory({}).getCacheWarmingMode(), "idle");
  assert.equal(SettingsManager.inMemory({ cacheWarming: "off" }).getCacheWarmingMode(), "off");
});

test("hours count from now, so a session idle for hours can still be warmed on", async (t) => {
  // The case that showed the bug: the latest message was 9 hours ago, agent turns kept the
  // cache warm, and asking for 7 hours put the end 2 hours in the past.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 9 * 60 * MIN });
  t.after(() => mock.timers.reset());
  const { warmer, warms, branch } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.state, "inactive", "two hours after a 9-hour-old input are over");

  warmer.setSessionWarming({ hours: 7 });
  assert.deepEqual(branch.at(-1).data, { enabled: true, until: 16 * 60 * MIN, setAt: 9 * 60 * MIN });
  assert.equal(warmer.deadline(), 16 * 60 * MIN);
  assert.equal(warmer.status.state, "scheduled");
  assert.equal(warmer.status.until, 16 * 60 * MIN);
  await advance(40 * MIN);
  assert.equal(warms.length, 1);

  // A new runtime of the same session reads the end back.
  const again = harness("anthropic", 0);
  again.branch.push(...branch.filter((entry) => entry.type === "custom"));
  assert.equal(again.warmer.deadline(), 16 * 60 * MIN);
});

test("the latest action wins: an end set after the input can be shorter, a later input still gets two hours", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, branch } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.until, 2 * 60 * MIN);

  await advance(10 * MIN);
  warmer.setSessionWarming({ hours: 1 });
  assert.equal(warmer.deadline(), 70 * MIN, "shorter than the two hours after the input");
  assert.equal(warmer.status.until, 70 * MIN);

  // A later input gets its two hours over the shorter end …
  branch.push({ type: "message", message: { role: "user", timestamp: 20 * MIN } });
  assert.equal(warmer.deadline(), 140 * MIN);
  // … and keeps a set end that reaches further.
  warmer.setSessionWarming({ hours: 6 });
  branch.push({ type: "message", message: { role: "user", timestamp: 30 * MIN } });
  assert.equal(warmer.deadline(), 10 * MIN + 6 * 60 * MIN);
});

test("a shorter end stops warming at that end", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  // Two ticks, so the 40-minute timer fires on time. One 70-minute tick would make it 30 minutes
  // late, and since 0.87 stock drops a refresh that late (see the late-timer test below).
  await advance(40 * MIN);
  await advance(30 * MIN);
  assert.equal(warms.length, 1);
  // One hour from 70m ends at 130m: the refreshes at 80m and 120m are inside it …
  warmer.setSessionWarming({ hours: 1 });
  assert.equal(warmer.status.until, 130 * MIN);
  await advance(10 * MIN);
  await advance(40 * MIN);
  assert.equal(warms.length, 3);
  // … and the one at 160m is past it, so warming ends.
  assert.equal(warmer.status.state, "inactive");
  assert.match(warmer.status.reason, /warming window ended/);
});

test("turning the switch back on after the window ended starts two hours from now", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 3 * 60 * MIN });
  t.after(() => mock.timers.reset());
  const { warmer } = harness("anthropic", 0);
  warmer.setSessionWarming({ enabled: false });
  assert.equal(warmer.deadline(), 2 * 60 * MIN, "off keeps the old end");
  warmer.setSessionWarming({ enabled: true });
  assert.equal(warmer.deadline(), 5 * 60 * MIN);
});

test("turning the switch back on inside the window keeps its end", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 30 * MIN });
  t.after(() => mock.timers.reset());
  const { warmer } = harness("anthropic", 0);
  warmer.setSessionWarming({ enabled: false });
  warmer.setSessionWarming({ enabled: true });
  assert.equal(warmer.deadline(), 2 * 60 * MIN);
});

test("an older per-session hours choice falls back to two hours after the input", () => {
  const { warmer, branch } = harness("anthropic", 0);
  branch.push({ type: "custom", customType: "rubato.cache-warming", data: { enabled: true, hours: 7 } });
  assert.equal(warmer.deadline(), 2 * 60 * MIN);
});

test("a session turned off stays off through later inputs until it is turned back on", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms, branch } = harness("anthropic", 0);
  const request = { model: model("anthropic"), context: {}, options: {} };
  warmer.start(request, () => true);
  warmer.onAgentSettled();
  warmer.setSessionWarming({ enabled: false });
  assert.equal(warmer.status.state, "inactive");

  // A new message and turn do not bring it back.
  branch.push({ type: "message", message: { role: "user", timestamp: Date.now() } });
  warmer.start(request, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.sessionDisabled(), true);
  assert.notEqual(warmer.status.state, "scheduled");
  assert.equal(warms.length, 0);

  warmer.setSessionWarming({ enabled: true });
  assert.equal(warmer.status.state, "scheduled");
});

// Stock (0.87+) gives a late timer half of the lifetime left after the interval, then calls the
// refresh a miss: a refresh that late would write a new cache at full price instead of warming.
// Rubato passes the real entry lifetime, so that grace is 10 minutes for Claude, 5 for Codex and 2.5 for Vertex.
for (const [provider, intervalMin, graceMin] of [["anthropic", 40, 10], ["openai-codex", 20, 5], ["google-vertex", 10, 2.5]]) {
  test(`${provider}: a timer that fires late still warms within ${graceMin} minutes, and stops after`, async (t) => {
    t.after(() => mock.timers.reset());
    // Each lateness on a fresh warmer: after a warm the next one counts from that warm.
    for (const [lateMs, warmed] of [[5_000, true], [graceMin * MIN, true], [graceMin * MIN + 1, false]]) {
      mock.timers.reset();
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { warmer, warms } = harness(provider, 0);
      warmer.start({ model: model(provider), context: {}, options: {} }, () => true);
      warmer.onAgentSettled();
      assert.equal(warmer.status.nextWarmAt, intervalMin * MIN);
      await advance(intervalMin * MIN + lateMs);
      if (warmed) {
        assert.equal(warms.length, 1, `${lateMs} ms late still warms`);
        assert.equal(warmer.status.state, "scheduled");
      } else {
        assert.equal(warms.length, 0, `${lateMs} ms late is past the grace`);
        assert.equal(warmer.status.state, "inactive");
        assert.match(warmer.status.reason, /cache refresh deadline missed/);
      }
      warmer.cancel();
    }
  });
}

// The stock check (sdk.js cacheContextIsCurrent): the transcript still extends the request
// when every message the request held is the same object at the same place.
function extendsRequest(requested, current) {
  return requested.length <= current.length && requested.every((message, index) => current[index] === message);
}

test("rebuilding the transcript keeps the request it extends, with notices, a summary and edits in it", () => {
  const session = SessionManager.inMemory("/tmp");
  const text = (value) => [{ type: "text", text: value }];
  const user = session.appendMessage({ role: "user", content: text("first"), timestamp: 1 });
  session.appendMessage({ role: "assistant", content: text("ok"), usage, timestamp: 2 });
  session.appendCompaction("summary of the first window", user, 100);
  session.appendCustomMessageEntry("rubato-runtime:wake", "a background task finished", false);
  const edited = session.appendMessage({ role: "user", content: text("long tool output"), timestamp: 3 });
  session.appendContextEdit(edited, { content: "trimmed" });
  const requested = session.buildSessionProjection().messages;
  assert.deepEqual(requested.map((message) => message.role), ["compactionSummary", "user", "assistant", "custom", "user"]);

  session.appendMessage({ role: "assistant", content: text("done"), usage, timestamp: 4 });
  // Each turn boundary rebuilds the transcript from the session (agent-session _refreshFinalizedContext).
  const rebuilt = session.buildSessionProjection().messages;
  assert.ok(extendsRequest(requested, rebuilt), "the rebuilt transcript still extends the request");
  assert.equal(rebuilt[4].content, "trimmed");
});

test("a warmer holding a transcript with a notice still refreshes after the turn boundary rebuild", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 });
  session.appendCustomMessageEntry("senpi-terminal:notification", "watcher fired", false);
  let transcript = session.buildSessionProjection().messages;
  const requested = transcript;
  session.appendMessage({ role: "assistant", content: [], usage, timestamp: 1 });
  transcript = session.buildSessionProjection().messages;

  const { warmer, warms } = harness("anthropic", 0);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => extendsRequest(requested, transcript));
  warmer.onAgentSettled();
  await advance(40 * MIN);
  assert.equal(warms.length, 1);
  assert.equal(warmer.status.state, "scheduled");
});

test("the context ring counts Codex's cache for the lifetime the warmer refreshes it on", async () => {
  const { resolveCachePolicy } = await import("../statusline/statusline.mjs");
  const codex = resolveCachePolicy({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" });
  assert.equal(codex.kind, "sliding");
  assert.equal(codex.ttlSeconds * 1000, RUBATO_CACHE_LIFETIME_MS["openai-codex"]);
  assert.equal(resolveCachePolicy({ provider: "anthropic", api: "anthropic-messages" }).ttlSeconds * 1000, RUBATO_CACHE_LIFETIME_MS.anthropic);
  const vertex = resolveCachePolicy({ provider: "google-vertex", api: "google-vertex", id: "gemini-4-argon" });
  assert.equal(vertex.kind, "sliding");
  assert.equal(vertex.ttlSeconds * 1000, RUBATO_CACHE_LIFETIME_MS["google-vertex"]);
});

test("a Vertex Gemini session is warmed every 10 minutes with a one-token replay", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { warmer, warms, calls } = harness("google-vertex", 0);
  warmer.start({ model: model("google-vertex"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  assert.equal(warmer.status.nextWarmAt, 10 * MIN);
  await advance(10 * MIN);
  assert.equal(warms.length, 1);
  assert.equal(calls[0].maxTokens, 1);
  await advance(10 * MIN);
  assert.equal(warms.length, 2);
});

test("a Vertex refresh that reads nothing from the cache ends warming; a hit keeps it going", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const missed = harness("google-vertex", 0, { ...usage, input: 300_000, cacheRead: 0 });
  missed.warmer.start({ model: model("google-vertex"), context: {}, options: {} }, () => true);
  missed.warmer.onAgentSettled();
  await advance(10 * MIN);
  assert.equal(missed.warms.length, 1, "the miss is recorded");
  assert.equal(missed.warmer.status.state, "inactive");
  assert.match(missed.warmer.status.reason, /refresh missed the cache/);
  await advance(10 * MIN);
  assert.equal(missed.warms.length, 1, "and nothing is sent after it");

  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hit = harness("google-vertex", 0);
  hit.warmer.start({ model: model("google-vertex"), context: {}, options: {} }, () => true);
  hit.warmer.onAgentSettled();
  await advance(10 * MIN);
  assert.equal(hit.warmer.status.state, "scheduled");
});

test("a Claude refresh that reads nothing keeps warming: only Vertex stops on a miss", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { warmer, warms } = harness("anthropic", 0, { ...usage, input: 300_000, cacheRead: 0 });
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  await advance(40 * MIN);
  assert.equal(warms.length, 1);
  assert.equal(warmer.status.state, "scheduled");
});

test("the companion warms without an end until the person turns its warming off", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const { warmer, warms, branch } = harness("anthropic", 0);
  branch.unshift({ type: "custom", customType: COMPANION_ENTRY, data: {} });
  assert.equal(warmer.deadline(), Number.POSITIVE_INFINITY);
  warmer.start({ model: model("anthropic"), context: {}, options: {} }, () => true);
  warmer.onAgentSettled();
  // A day of silence: every 40 minutes, past the two-hour window and the 24-hour cap alike.
  for (let step = 0; step < 36; step += 1) await advance(40 * MIN);
  assert.equal(warms.length, 36);
  assert.equal(warmer.status.state, "scheduled");
  warmer.setSessionWarming({ enabled: false });
  await advance(40 * MIN);
  assert.equal(warms.length, 36);
});
