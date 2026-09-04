import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatNoticeLatency, formatTpsNotice, installTps, turnTokensPerSecond } from "../../src/extensions/tps.mjs";
import { PROCESS_STARTED_AT as SHARED_PROCESS_STARTED_AT, processStartedAt } from "../../src/process-start.mjs";

const PROCESS_STARTED_AT = 42;

function runTurn(assistantMessages, { hasUI = true } = {}) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  const notices = [];
  const ctx = { hasUI, ui: { notify: (text, level) => notices.push({ text, level }) } };

  installTps(pi, { processStartedAt: PROCESS_STARTED_AT });
  if (handlers.size === 0) return notices;
  handlers.get("agent_start")?.({}, ctx);
  for (const message of assistantMessages) {
    handlers.get("message_start")?.({ message }, ctx);
    handlers.get("message_end")?.({ message }, ctx);
  }
  handlers.get("agent_end")?.({ messages: assistantMessages }, ctx);
  return notices;
}

function assistant(usage, timing) {
  return { role: "assistant", usage, ...(timing ? { timing } : {}) };
}

const USAGE = { input: 20, output: 100, cacheRead: 80, cacheWrite: 0 };

test("the owned tps installer stays silent and never notifies", () => {
  assert.deepEqual(runTurn([
    assistant(USAGE, { processStartedAt: PROCESS_STARTED_AT, ttftMs: 1_000, waitMs: 1_000, thinkMs: 6_000 }),
    assistant(USAGE, { processStartedAt: PROCESS_STARTED_AT, ttftMs: 2_000, waitMs: 2_000, thinkMs: 2_000 }),
  ]), []);
  assert.deepEqual(runTurn([assistant(USAGE)], { hasUI: false }), []);
});

test("offline timing helpers still exist and are not used as a live notice", () => {
  assert.equal(formatNoticeLatency({ waitMs: 900, thinkMs: 0 }), "delay 900ms");
  assert.equal(formatNoticeLatency({ waitMs: 1_200, thinkMs: 4_000 }), "delay 1.2s, think 4.0s");
  assert.equal(formatNoticeLatency(null), "");
  const text = formatTpsNotice({
    tokensPerSecond: 17.5,
    cacheHitRate: 80,
    elapsedSeconds: 2,
    timing: { waitMs: 400 },
  });
  assert.match(text, /TPS 17\.5 tok\/s/);
  assert.equal(turnTokensPerSecond({ tokensPerSecond: 17.5 }, 5_100, 10), 17.5);
  assert.deepEqual(runTurn([
    assistant(
      { input: 20, output: 35, cacheRead: 80, cacheWrite: 0 },
      { processStartedAt: PROCESS_STARTED_AT, ttftMs: 100, waitMs: 100, modelDurationMs: 2_000 },
    ),
  ]), []);
});

test("every reader of timing.processStartedAt sees one value, not a fresh sample", () => {
  assert.equal(processStartedAt(), SHARED_PROCESS_STARTED_AT);
  assert.ok(Number.isInteger(SHARED_PROCESS_STARTED_AT));
});

test("the shim loads and installs as a real extension without emitting a notice", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "rubato-ext-"));
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const { ensureAgentExtensions } = await import("../../src/agent-extensions.mjs");
  ensureAgentExtensions(agentDir);
  const mod = await import(pathToFileURL(join(agentDir, "extensions", "tps.js")).href);
  const seen = [];
  const notices = [];
  mod.default({
    on: (name, handler) => {
      seen.push(name);
      handler({ message: { role: "assistant" }, messages: [assistant(USAGE)] }, {
        hasUI: true,
        ui: { notify: (text, level) => notices.push({ text, level }) },
      });
    },
  });
  assert.deepEqual(seen, []);
  assert.deepEqual(notices, []);
});
