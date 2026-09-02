import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiNested } from "../../src/engine-paths.mjs";
import { supportedThinkingLevels } from "../../src/thinking-levels.mjs";
import { injectThinkingLevels, isThinkingLevelsUrl } from "../../src/transforms/misc-thinking-levels.mjs";

function levels(model, hooks) {
  return supportedThinkingLevels(model, hooks);
}

function allowXhigh(model) {
  return model.thinkingLevelMap?.xhigh != null || /opus-5|sonnet-5|fable-5|gpt-5\.6|grok-4\.6/.test(model.id);
}

function allowMax(model) {
  return model.thinkingLevelMap?.max != null || /opus-5|sonnet-5|fable-5|gpt-5\.6/.test(model.id);
}

const hooks = { supportsXhigh: allowXhigh, supportsMax: allowMax };

test("reasoning 이 없으면 off 만 남는다", () => {
  assert.deepEqual(levels({ id: "gpt-4.1", reasoning: false }), ["off"]);
});

test("맵이 없는 Claude Haiku 는 low/medium/high 만 순환한다", () => {
  assert.deepEqual(levels({ id: "claude-haiku-4-5", reasoning: true }, hooks), ["low", "medium", "high"]);
});

test("가산형 Claude Opus 맵은 off/minimal 없이 xhigh/max 를 연다", () => {
  assert.deepEqual(
    levels({
      id: "claude-opus-5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }, hooks),
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("Codex 가산형 맵의 minimal→low 별칭은 칸에서 빠진다", () => {
  assert.deepEqual(
    levels({
      id: "gpt-5.6-sol",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
    }, hooks),
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("공식 OpenAI GPT-5.6 도 off/minimal 없이 low 부터 순환한다", () => {
  assert.deepEqual(
    levels({
      id: "gpt-5.6-sol",
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }, hooks),
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("Grok 4.6 은 맵이 막은 off/minimal/max 를 순환하지 않는다", () => {
  assert.deepEqual(
    levels({
      id: "grok-4.6",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }, hooks),
    ["low", "medium", "high", "xhigh"],
  );
});

test("Gemini 3.1 Pro 는 LOW/HIGH 만 실제 단계다", () => {
  assert.deepEqual(
    levels({
      id: "gemini-3.1-pro-preview",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "LOW",
        medium: null,
        high: "HIGH",
      },
    }, hooks),
    ["low", "high"],
  );
});

test("Gemma 의 MINIMAL 도 순환에서 빠지고 high 만 남는다", () => {
  assert.deepEqual(
    levels({
      id: "gemma-4-31b-it",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "MINIMAL",
        low: null,
        medium: null,
        high: "HIGH",
      },
    }, hooks),
    ["high"],
  );
});

test("pi-ai models.js 니들에 변환이 걸린다", () => {
  const path = senpiNested("@earendil-works", "pi-ai", "dist/models.js");
  const source = readFileSync(path, "utf8");
  const url = pathToFileURL(path).href;
  assert.equal(isThinkingLevelsUrl(url), true);
  const next = injectThinkingLevels(source);
  assert.notEqual(next, source);
  assert.match(next, /rubatoSupportedThinkingLevels/);
  assert.equal(next.includes("return EXTENDED_THINKING_LEVELS.filter"), false);
});
