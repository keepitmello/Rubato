import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";

const evalPromptPath = fileURLToPath(new URL("../../src/codemode/prompt/eval-prompt.ts", import.meta.url));
const jitiHref = pathToFileURL(join(senpiDir, "node_modules/jiti/lib/jiti-static.mjs")).href;

async function loadEvalPrompt() {
  const { createJiti } = await import(jitiHref);
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti.import(evalPromptPath);
}

const MODELS = {
  default: undefined,
  claude: "anthropic/claude-fable-5-1",
  gpt: "openai-codex/gpt-6-astra",
  grok: "xai/grok-4.6",
  codex: "codex-5.3",
  kimi: "kimi-k2",
};

const FORBIDDEN = [
  /EVAL IS YOUR PRIMARY EXECUTION SURFACE/,
  /EVAL IS YOUR SUPERPOWER/,
  /MUST be written as ONE cell/,
  /EVAL FIRST/,
  /MUST be ONE eval cell/,
  /Shell commands run ONLY inside eval/,
  /WRITE REAL CODE/,
  /every risky call/i,
  /Size `parallel\(thunks\)` pools/,
  /filter belongs with that step/,
  /standalone watch is a direct/,
  /eval_first_batching/,
  /gpt_eval_dialect/,
];

test("eval prompt renders one common rule for every model dialect", async () => {
  const { buildEvalPrompt, evalEmphasisStyle, isGptCodeModeModel } = await loadEvalPrompt();
  assert.equal(isGptCodeModeModel("gpt-5.4"), true);
  assert.equal(evalEmphasisStyle("claude-opus-4-6"), "claude");
  const enabled = { py: true, js: true, rb: false, jl: false };
  const rendered = [];
  for (const [style, modelId] of Object.entries(MODELS)) {
    const parts = buildEvalPrompt(enabled, {
      spawns: false,
      monitor: true,
      modelId,
      hostLine: "darwin arm64 · 10 cores",
    });
    rendered.push(parts);
    assert.match(parts.description, /Ordinary calls are direct tools/, style);
    assert.match(parts.description, /programmatic intermediates or persistent calculations/, style);
    assert.match(parts.description, /parallel\(thunks\)/, style);
    assert.match(parts.description, /One eval call = one cell/, style);
    assert.match(parts.description, /outlives the foreground window detaches/, style);
    assert.match(parts.description, /Host: darwin arm64 · 10 cores/, style);
    assert.doesNotMatch(parts.description, /Size `parallel\(thunks\)` pools/, style);
    for (const re of FORBIDDEN) {
      assert.doesNotMatch(parts.description, re, `${style} description ${re}`);
      assert.doesNotMatch(parts.promptGuidelines[0], re, `${style} guideline ${re}`);
    }
  }
  for (let i = 1; i < rendered.length; i += 1) {
    assert.equal(rendered[i].description, rendered[0].description);
    assert.equal(rendered[i].promptGuidelines[0], rendered[0].promptGuidelines[0]);
    assert.equal(rendered[i].promptSnippet, rendered[0].promptSnippet);
  }
});

test("eval prompt omits spawn helpers when disabled and keeps host and event-loop lines", async () => {
  const { buildEvalPrompt } = await loadEvalPrompt();
  const enabled = { py: true, js: true, rb: false, jl: false };
  const noSpawns = buildEvalPrompt(enabled, {
    spawns: false,
    hostLine: "darwin arm64 · 10 cores",
  });
  assert.doesNotMatch(noSpawns.description, /output\(\*ids/);
  assert.doesNotMatch(noSpawns.description, /agent\(prompt/);
  assert.doesNotMatch(noSpawns.description, /<workflow>/);
  assert.match(noSpawns.description, /Host: darwin arm64 · 10 cores/);
  assert.match(noSpawns.description, /Python runs on a live event loop/);
  assert.match(noSpawns.description, /`"py"` IPython kernel/);
  assert.match(noSpawns.description, /`"js"` persistent JavaScript VM/);
  assert.match(noSpawns.description, /tool\.<name>\(args\)/);

  const withSpawns = buildEvalPrompt(enabled, {
    spawns: true,
    spawnDefaultAgent: "task",
    hostLine: "darwin arm64 · 10 cores",
  });
  assert.match(withSpawns.description, /output\(\*ids/);
  assert.match(withSpawns.description, /agent\(prompt/);
  assert.match(withSpawns.description, /<workflow>/);
  assert.match(withSpawns.description, /Host: darwin arm64 · 10 cores/);
  assert.match(withSpawns.description, /Python runs on a live event loop/);

  const bun = buildEvalPrompt(enabled, {
    spawns: false,
    jsRuntime: { name: "bun", version: "1.4.0" },
    bunSkillPath: "/tmp/bun-1-4/SKILL.md",
  });
  assert.match(bun.description, /Bun 1\.4\.0/);
  assert.match(bun.description, /MUST READ the bun-1-4 skill at \/tmp\/bun-1-4\/SKILL.md/);
  assert.doesNotMatch(bun.description, /Node\.js worker/);
});
