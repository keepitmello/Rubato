import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_STOCK_TRIGGER_TOKENS,
  CODEX_STOCK_WINDOW,
  compactTriggerTokens,
  resolveClientCompactionThresholdRatio,
} from "../../src/client-compaction-threshold.mjs";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  injectCompactionIndexThreshold,
  injectCompactionPolicy,
  injectCompactionSettings,
} from "../../src/transforms/core-compaction-policy.mjs";
import { injectCompactionIndexReason } from "../../src/transforms/core-lane-policy.mjs";

const CODEX = { provider: "openai-codex", id: "gpt-5.6-sol" };
const CURSOR_GROK = { provider: "cursor", id: "cursor-grok-4.6-high-fast" };
const XAI_GROK = { provider: "xai", id: "grok-4.6" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

test("stock Codex 272k compact trigger is 244800", () => {
  assert.equal(CODEX_STOCK_WINDOW * 9 / 10, CODEX_STOCK_TRIGGER_TOKENS);
  assert.equal(compactTriggerTokens(CODEX_STOCK_WINDOW, 0.9), CODEX_STOCK_TRIGGER_TOKENS);
  assert.equal(resolveClientCompactionThresholdRatio({ model: CODEX }), 0.9);
  assert.equal(compactTriggerTokens(CODEX_STOCK_WINDOW, resolveClientCompactionThresholdRatio({ model: CODEX })), 244_800);
});

test("Grok on Cursor or xAI compact at 10% remaining", () => {
  assert.equal(resolveClientCompactionThresholdRatio({ model: CURSOR_GROK }), 0.9);
  assert.equal(resolveClientCompactionThresholdRatio({ model: XAI_GROK }), 0.9);
  assert.equal(compactTriggerTokens(500_000, 0.9), 450_000);
});

test("unlisted models also default to 0.9", () => {
  assert.equal(resolveClientCompactionThresholdRatio({ model: FABLE }), 0.9);
  assert.equal(resolveClientCompactionThresholdRatio({}), 0.9);
  assert.equal(
    resolveClientCompactionThresholdRatio({
      model: FABLE,
      settings: { models: { "anthropic/claude-fable-5-1": 0.8 } },
    }),
    0.8,
  );
});

test("settings.models beats global and baked defaults", () => {
  assert.equal(
    resolveClientCompactionThresholdRatio({
      model: CODEX,
      settings: { thresholdRatio: 0.7, models: { "openai-codex/gpt-5.6-sol": 0.85 } },
    }),
    0.85,
  );
  assert.equal(
    resolveClientCompactionThresholdRatio({
      model: FABLE,
      settings: { thresholdRatio: 0.72 },
    }),
    0.72,
  );
  assert.equal(resolveClientCompactionThresholdRatio({ settings: { thresholdRatio: 1.2 } }), 0.9);
});

test("policy and settings transforms honor configured ratios and attach model", () => {
  const policy = readFileSync(join(senpiDir, "dist/core/extensions/builtin/compaction/policy.js"), "utf8");
  const nextPolicy = injectCompactionPolicy(policy);
  assert.match(nextPolicy, /configuredOrAdaptiveThreshold/);
  assert.match(nextPolicy, /resolveClientCompactionThresholdRatio/);
  assert.throws(() => injectCompactionPolicy(nextPolicy));

  const settings = readFileSync(join(senpiDir, "dist/core/settings-manager.js"), "utf8");
  const nextSettings = injectCompactionSettings(settings);
  assert.match(nextSettings, /thresholdRatio: this\.settings\.compaction\?\.thresholdRatio/);
  assert.throws(() => injectCompactionSettings(nextSettings));

  const index = readFileSync(join(senpiDir, "dist/core/extensions/builtin/compaction/index.js"), "utf8");
  const nextIndex = injectCompactionIndexThreshold(injectCompactionIndexReason(index));
  assert.match(nextIndex, /function compactionSettingsFor\(ctx\)/);
  assert.match(nextIndex, /policy.shouldTriggerCompaction\(usage, contextWindow, compactionSettingsFor\(ctx\)/);
  assert.match(nextIndex, /const settings = compactionSettingsFor\(ctx\);\n        if \(idle.shouldRunIdleCompaction/);
  assert.throws(() => injectCompactionIndexThreshold(nextIndex));
});
