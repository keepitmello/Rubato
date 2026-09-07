import assert from "node:assert/strict";
import test from "node:test";
import { loadPiFeatures, PI_FEATURE_NAMES } from "../feature-catalog.mjs";

test("catalog adds required tool hooks once before codemode without enabling unrelated features", async () => {
  const features = await loadPiFeatures(["codemode", "reload", "tool-execution", "codemode"]);
  assert.deepEqual(features.map(({ id }) => id), ["tool-execution", "codemode", "reload"]);
  assert.ok(features[0].patches.length > 0);
  assert.ok(features[1].files.length > 0);
  assert.equal(features[1].patches.length, 0);
  assert.equal(PI_FEATURE_NAMES.includes("service-tier"), true);
  assert.deepEqual(await loadPiFeatures([]), []);
});

test("catalog rejects unknown or malformed selections before loading feature code", async () => {
  for (const names of [["reload", "unknown"], ["__proto__"], [null], "reload"]) {
    await assert.rejects(loadPiFeatures(names), /feature/);
  }
});
