import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { supportedThinkingLevels } from "./thinking-levels.mjs";
import { feature, files, patches, patchThinkingLevels } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/models.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "thinking-levels");
  assert.equal(PI_FEATURE_NAMES.includes("thinking-levels"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("thinking-levels"), true);
  assert.deepEqual((await loadPiFeatures(["thinking-levels"])).map((entry) => entry.id), ["thinking-levels"]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/thinking-levels/thinking-levels.mjs"]);
});

test("Shift+Tab cycle skips off/minimal", () => {
  assert.deepEqual(supportedThinkingLevels({ id: "gpt-4.1", reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({ id: "claude-haiku-4-5", reasoning: true }), ["low", "medium", "high"]);
  assert.deepEqual(supportedThinkingLevels({
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
  }), ["low", "medium", "high", "xhigh", "max"]);
  const patched = patchThinkingLevels(readFileSync(stockPath, "utf8"));
  assert.match(patched, /rubatoSupportedThinkingLevels\(model\)/);
  assert.doesNotMatch(patched, /return EXTENDED_THINKING_LEVELS.filter/);
});
