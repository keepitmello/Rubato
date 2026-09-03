import test from "node:test";
import assert from "node:assert/strict";
import { DISABLED_AGENT_NAMES, DISABLED_CATEGORY_NAMES, MODEL_CATEGORIES, MODEL_CATEGORY_CHAINS } from "../../src/defaults.mjs";
import { loadRubatoPiRubatoConfig, pinMemoryJobsToGrok } from "../../src/rubato-config.mjs";

test("task config maps model names and disables inactive category routing", () => {
  const { config } = loadRubatoPiRubatoConfig();
  assert.equal(MODEL_CATEGORIES.grok, "xai/grok-4.6");
  assert.equal(config.models, undefined);
  for (const [name, models] of Object.entries(MODEL_CATEGORY_CHAINS)) {
    assert.deepEqual(config.categories[name], { models });
  }
  for (const name of DISABLED_CATEGORY_NAMES) {
    assert.deepEqual(config.categories[name], { disable: true });
  }
});

test("semantic categories own ordered provider preference and fallback", () => {
  assert.deepEqual(MODEL_CATEGORY_CHAINS.grok, [
    "xai/grok-4.6",
    "cursor/cursor-grok-4.6",
  ]);
  assert.deepEqual(MODEL_CATEGORY_CHAINS.opus, [
    "kiro/claude-opus-5",
    "anthropic/claude-opus-5",
  ]);
  assert.deepEqual(MODEL_CATEGORY_CHAINS.sol, [
    "kiro/gpt-5.6-sol",
    "openai-codex/gpt-5.6-sol",
  ]);
});

test("inactive agents this harness does not route are disabled", () => {
  const { config } = loadRubatoPiRubatoConfig();
  for (const name of DISABLED_AGENT_NAMES) {
    assert.deepEqual(config.agents[name], { disable: true });
  }
  assert.deepEqual(Object.keys(config.agents).sort(), [...DISABLED_AGENT_NAMES].sort());
});

test("memory pin leaves absent settings to the memory schema and reopens quick as grok-only", () => {
  const pinned = pinMemoryJobsToGrok(loadRubatoPiRubatoConfig());
  assert.equal(pinned.config.memory, undefined);
  assert.deepEqual(pinned.config.categories.grok, { models: MODEL_CATEGORY_CHAINS.grok });
  assert.deepEqual(pinned.config.categories.quick, { models: MODEL_CATEGORY_CHAINS.grok });
  assert.equal(pinned.config.categories.quick.disable, undefined);
});

test("memory pin keeps user memory keys and overwrites only the reflection category", () => {
  const pinned = pinMemoryJobsToGrok({
    config: {
      memory: { agent: "rubato", project: [], reflection: { timeout_minutes: 20 } },
      categories: { quick: { disable: true } },
    },
    diagnostics: [],
  });
  assert.equal(pinned.config.memory.agent, "rubato");
  assert.deepEqual(pinned.config.memory.project, []);
  assert.equal(pinned.config.memory.reflection.timeout_minutes, 20);
  assert.equal(pinned.config.memory.reflection.category, "grok");
  assert.deepEqual(pinned.config.categories.quick, { models: MODEL_CATEGORY_CHAINS.grok });
});
