import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { sortModelItems, modelPickerLabel } from "./catalog.mjs";
import { feature, files, patches, patchModelSelector } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "model-picker");
  assert.equal(PI_FEATURE_NAMES.includes("model-picker"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("model-picker"), true);
  assert.deepEqual((await loadPiFeatures(["model-picker"])).map((entry) => entry.id), ["model-picker"]);
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/model-picker/catalog.mjs"]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
});

test("sorts by provider groups and keeps xai/ vs cursor/ apart, Sol first", () => {
  const sorted = sortModelItems([
    { provider: "cursor", id: "composer-2.5", model: {} },
    { provider: "xai", id: "grok-4.6", model: {} },
    { provider: "cursor", id: "gpt-5.6-sol", model: {} },
    { provider: "openai-codex", id: "gpt-5.6-luna", model: {} },
    { provider: "openai-codex", id: "gpt-5.6-sol", model: {} },
    { provider: "anthropic", id: "claude-opus-5", model: {} },
  ]);
  assert.deepEqual(sorted.map((item) => `${item.provider}/${item.id}`), [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    "anthropic/claude-opus-5",
    "xai/grok-4.6",
    "cursor/gpt-5.6-sol",
    "cursor/composer-2.5",
  ]);
});

test("display labels and stock patch replace item.id", () => {
  assert.equal(modelPickerLabel({ provider: "cursor", id: "cursor-grok-4.6", model: {} }), "grok-4.6-fast");
  assert.equal(modelPickerLabel({ provider: "anthropic", id: "claude-fable-5-1", model: {} }), "Fable 5.1");
  assert.equal(modelPickerLabel({ provider: "openai-codex", id: "gpt-daybreak-blue-latest", model: { name: "Daybreak Blue" } }), "Daybreak Blue");
  const patched = patchModelSelector(readFileSync(stockPath, "utf8"));
  assert.match(patched, /sortModelItems\(models\)/);
  assert.match(patched, /modelPickerLabel\(item\)/);
  assert.doesNotMatch(patched, /current model first, default model second/);
});
