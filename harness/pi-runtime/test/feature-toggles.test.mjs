import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUIRED_FACTORIES, applyFeatureToggles, readDisabledFeatures } from "../features/rubato-components/feature-toggles.mjs";

const factories = [{ name: "rubato-assets" }, { name: "providers" }, { name: "rubato-components" }, { name: "rubato-goal" }, { name: "rubato-btw" }];

test("disabled features come from the profile file and the environment, and unknown names are reported", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "rubato-toggles-"));
  await writeFile(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: ["rubato-goal", "rubato-typo"] }));
  const disabled = readDisabledFeatures({ agentDir, env: { RUBATO_DISABLED_FEATURES: "rubato-btw, " } });
  assert.deepEqual([...disabled].sort(), ["rubato-btw", "rubato-goal", "rubato-typo"]);
  const result = applyFeatureToggles(factories, disabled);
  assert.deepEqual(result.extensionFactories.map((entry) => entry.name), ["rubato-assets", "providers", "rubato-components"]);
  assert.deepEqual(result.disabled.sort(), ["rubato-btw", "rubato-goal"]);
  assert.deepEqual(result.unknown, ["rubato-typo"]);
});

test("missing profile file means nothing is disabled; required factories refuse to be disabled", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "rubato-toggles-"));
  assert.equal(readDisabledFeatures({ agentDir, env: {} }).size, 0);
  for (const name of REQUIRED_FACTORIES) {
    assert.throws(() => readDisabledFeatures({ agentDir, env: { RUBATO_DISABLED_FEATURES: name } }), new RegExp(name));
  }
  await writeFile(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: "rubato-goal" }));
  assert.throws(() => readDisabledFeatures({ agentDir, env: {} }), /must be an array/);
});
