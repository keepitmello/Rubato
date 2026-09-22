import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { MODEL_ORDER, admitPickerItems, modelPickerLabel, PROVIDER_ORDER, sortModelItems } from "./catalog.mjs";
import { feature, files, patches, patchModelSelector } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "model-picker");
  assert.equal(PI_FEATURE_NAMES.includes("model-picker"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("model-picker"), true);
  assert.deepEqual((await loadPiFeatures(["model-picker"])).map((entry) => entry.id), ["model-picker"]);
  assert.deepEqual(files.map((entry) => entry.path), [
    "dist/rubato-features/model-picker/model-label.mjs",
    "dist/rubato-features/model-picker/product-model-catalog.mjs",
    "dist/rubato-features/model-picker/catalog.mjs",
  ]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
});

test("sorts by provider groups and keeps xai/ vs cursor/ apart, Sol first", () => {
  // 세대 id 를 손으로 적지 않는다 — 정렬은 카탈로그 순서를 읽으므로, 픽스처가
  // 카탈로그에 없는 세대를 가리키면 정렬 결과가 조용히 달라진다.
  const opus = MODEL_ORDER.anthropic[1];
  const sorted = sortModelItems([
    { provider: "cursor", id: "composer-2.5", model: {} },
    { provider: "xai", id: "grok-4.7", model: {} },
    { provider: "cursor", id: "gpt-5.6-sol", model: {} },
    { provider: "openai-codex", id: "gpt-5.6-luna", model: {} },
    { provider: "openai-codex", id: "gpt-5.6-sol", model: {} },
    { provider: "anthropic", id: opus, model: {} },
  ]);
  assert.deepEqual(sorted.map((item) => `${item.provider}/${item.id}`), [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    `anthropic/${opus}`,
    "xai/grok-4.7",
    "cursor/gpt-5.6-sol",
    "cursor/composer-2.5",
  ]);
});

test("picker admits only the product providers, current model excepted", () => {
  const equal = (a, b) => a === b;
  const openaiAstra = { provider: "openai", id: "gpt-6-astra", model: "api-astra" };
  const opus = MODEL_ORDER.anthropic[1];
  const admitted = admitPickerItems(
    [
      openaiAstra,
      { provider: "openai-codex", id: "gpt-6-astra", model: "codex-astra" },
      { provider: "anthropic", id: opus, model: "opus" },
    ],
    undefined,
    equal,
  );
  assert.deepEqual(admitted.map((item) => `${item.provider}/${item.id}`), [
    "openai-codex/gpt-6-astra",
    `anthropic/${opus}`,
  ]);
  const keptCurrent = admitPickerItems([openaiAstra], "api-astra", equal);
  assert.deepEqual(keptCurrent, []);
  const keptOutside = admitPickerItems(
    [{ provider: "openai-codex", id: "gpt-5.4", model: "legacy-sol" }],
    "legacy-sol",
    equal,
  );
  assert.deepEqual(keptOutside.map((item) => `${item.provider}/${item.id}`), ["openai-codex/gpt-5.4"]);
  assert.deepEqual([...PROVIDER_ORDER], [
    "openai-codex", "anthropic", "xai", "google-antigravity", "kiro", "cursor", "opencode", "b-ai",
  ]);
});

test("display labels and stock patch replace item.id", () => {
  assert.equal(modelPickerLabel({ provider: "cursor", id: "grok-4.7", model: {} }), "Grok 4.7 fast");
  assert.equal(modelPickerLabel({ provider: "xai", id: "grok-4.7", model: {} }), "Grok 4.7");
  assert.equal(modelPickerLabel({ provider: "openai-codex", id: "gpt-6-astra", model: {} }), "Astra 6");
  assert.equal(modelPickerLabel({ provider: "openai-codex", id: "gpt-5.6-sol", model: {} }), "Sol 5.6");
  assert.equal(modelPickerLabel({ provider: "google-antigravity", id: "gemini-3.8-flash", model: {} }), "Gemini 3.8 Flash");
  assert.equal(modelPickerLabel({ provider: "anthropic", id: "claude-fable-5-1", model: {} }), "Fable 5.1");
  assert.equal(modelPickerLabel({ provider: "anthropic", id: "claude-opus-5-5", model: {} }), "Opus 5.5");
  assert.equal(modelPickerLabel({ provider: "anthropic", id: "claude-opus-5-5-sub", model: {} }), "Opus 5.5 [sub]");
  assert.equal(modelPickerLabel({ provider: "anthropic", id: "claude-fable-5-1-sub", model: {} }), "Fable 5.1 [sub]");
  assert.equal(modelPickerLabel({ provider: "openai-codex", id: "gpt-daybreak-blue-latest", model: { name: "Daybreak Blue" } }), "Daybreak Blue");
  const patched = patchModelSelector(readFileSync(stockPath, "utf8"));
  assert.match(patched, /sortModelItems\(admitPickerItems\(models, this.currentModel, modelsAreEqual\)\)/);
  assert.match(patched, /modelPickerLabel\(item\)/);
  assert.doesNotMatch(patched, /current model first, default model second/);
});
