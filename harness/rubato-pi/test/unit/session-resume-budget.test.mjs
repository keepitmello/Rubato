import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { applyCoreSessionTransforms } from "../../src/transforms/core-session.mjs";
import { injectResumeUsabilityBudget, isSdkUrl } from "../../src/transforms/core-session-resume-budget.mjs";

function applyNoThrow(url, source) {
  const warnings = [];
  const next = applyCoreSessionTransforms(url, source, (text, transform) => {
    try {
      const out = transform(text);
      return typeof out === "string" ? out : text;
    } catch (error) {
      warnings.push(error.message);
      return text;
    }
  });
  return { next, warnings };
}

function pinnedSdk() {
  return readFileSync(join(senpiDir, "dist/core/sdk.js"), "utf8");
}

test("sdk url matcher hits senpi sdk", () => {
  assert.equal(isSdkUrl("file:///x/@code-yeongyu/senpi/dist/core/sdk.js"), true);
  assert.equal(isSdkUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
});

test("resume skips the live-context usability assert", () => {
  const source = pinnedSdk();
  assert.match(source, /session\.assertModelUsable\(undefined, liveContextTokens\)/);
  const next = injectResumeUsabilityBudget(source);
  assert.match(next, /if \(!hasExistingSession\) \{\n        session\.assertModelUsable\(\);\n    \}/);
  assert.doesNotMatch(next, /liveContextTokens/);
  assert.throws(() => injectResumeUsabilityBudget(next));
});

test("core-session cluster injects resume budget skip without drift", () => {
  const filePath = join(senpiDir, "dist/core/sdk.js");
  const url = pathToFileURL(filePath).href;
  const { next, warnings } = applyNoThrow(url, readFileSync(filePath, "utf8"));
  assert.equal(warnings.length, 0, warnings.join("; "));
  assert.match(next, /if \(!hasExistingSession\)/);
  assert.doesNotMatch(next, /assertModelUsable\(undefined, liveContextTokens\)/);
});

test("astra-sized live context fails the switch gate", async () => {
  const { projectModelUsabilityBudget } = await import(
    pathToFileURL(join(senpiDir, "dist/core/extensions/builtin/compaction/model-usability-budget.js")).href
  );
  const model = {
    provider: "openai-codex",
    id: "gpt-6-astra",
    contextWindow: 272000,
    maxTokens: 128000,
  };
  const compaction = {
    enabled: true,
    reserveTokens: 20000,
    leadTokens: 8000,
    speculativeEnabled: true,
  };
  const animation = projectModelUsabilityBudget({
    model,
    systemPrompt: "",
    tools: [],
    liveContextTokens: 140174,
    compaction,
  });
  const independence = projectModelUsabilityBudget({
    model,
    systemPrompt: "",
    tools: [],
    liveContextTokens: 261793,
    compaction,
  });
  assert.equal(animation.usable, false);
  assert.equal(independence.usable, false);
  assert.ok(animation.shortfallTokens > 0);
  assert.ok(independence.shortfallTokens > animation.shortfallTokens);
});
