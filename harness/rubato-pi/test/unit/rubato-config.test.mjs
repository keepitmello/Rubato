import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLED_AGENT_NAMES, DISABLED_CATEGORY_NAMES, MEMORY_JOB_MODELS, MODEL_CATEGORIES, MODEL_CATEGORY_CHAINS } from "../../src/defaults.mjs";
import { loadRubatoPiRubatoConfig, pinMemoryJobsToGrok } from "../../src/rubato-config.mjs";

test("task config maps model names and disables inactive category routing", () => {
  const { config } = loadRubatoPiRubatoConfig();
  assert.equal(MODEL_CATEGORIES.grok, "cursor/cursor-grok-4.6");
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
  assert.deepEqual(MEMORY_JOB_MODELS, ["xai/grok-4.6", "cursor/cursor-grok-4.6-high-fast"]);
  assert.equal(pinned.config.memory, undefined);
  assert.deepEqual(pinned.config.categories.grok, { models: MEMORY_JOB_MODELS });
  assert.deepEqual(pinned.config.categories.quick, { models: MEMORY_JOB_MODELS });
  assert.equal(pinned.config.categories.quick.disable, undefined);
  assert.deepEqual(loadRubatoPiRubatoConfig().config.categories.grok, {
    models: MODEL_CATEGORY_CHAINS.grok,
  });
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
  assert.deepEqual(pinned.config.categories.quick, { models: MEMORY_JOB_MODELS });
});

const TASK_SCHEMA_DEFAULTS_EXCEPT_MODE = {
  default_concurrency: 5,
  global_concurrency: 8,
  max_depth: 1,
  residency_max_children: 8,
  ttl_ms: 86400000,
  resume_children: true,
  warnings: { unavailable_categories: true },
  wait: { min_ms: 5000, default_ms: 60000, max_ms: 600000 },
  team: { max_members: 8, max_parallel_members: 4, max_wall_clock_minutes: 120 },
};

function withProjectTask(task, run) {
  const cwd = mkdtempSync(join(tmpdir(), "rubato-config-"));
  try {
    mkdirSync(join(cwd, ".rubato"));
    writeFileSync(join(cwd, ".rubato", "rubato.json"), JSON.stringify({ task }));
    run(loadRubatoPiRubatoConfig({ cwd }).config.task);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("task defaults to process mode with a full schema-matching block when no project file exists", () => {
  const { config } = loadRubatoPiRubatoConfig();
  assert.equal(config.task.default_execution_mode, "process");
  for (const [key, value] of Object.entries(TASK_SCHEMA_DEFAULTS_EXCEPT_MODE)) {
    assert.deepEqual(config.task[key], value);
  }
});

test("project file default_execution_mode in-process wins over the harness process default", () => {
  withProjectTask({ default_execution_mode: "in-process" }, (task) => {
    assert.equal(task.default_execution_mode, "in-process");
    assert.equal(task.default_concurrency, 5);
  });
});

test("partial project task block keeps process default and fills remaining schema caps", () => {
  withProjectTask({ default_concurrency: 3 }, (task) => {
    assert.equal(task.default_execution_mode, "process");
    assert.equal(task.default_concurrency, 3);
    assert.equal(task.global_concurrency, 8);
    assert.equal(task.max_depth, 1);
  });
});
