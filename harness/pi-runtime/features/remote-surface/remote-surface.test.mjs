import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { createRemoteSurfaceFactories, REMOTE_SURFACE_FACTORY_NAME } from "./index.mjs";

test("rubato-features.json disables the rubato-remote-surface factory by name", async () => {
  assert.equal(PI_FEATURE_NAMES.includes("remote-surface"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("remote-surface"), true);
  const loaded = await loadPiFeatures(["remote-surface"]);
  assert.equal(loaded.some((entry) => entry.id === "remote-surface"), true);
  assert.ok(loaded.find((entry) => entry.id === "remote-surface").files.length > 0);
  const bootstrap = readFileSync(new URL("../rubato-components/bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /createRemoteSurfaceFactories/);
  assert.match(readFileSync(new URL("./index.mjs", import.meta.url), "utf8"), /rubato-remote-surface/);
  const agentDir = mkdtempSync(join(tmpdir(), "rubato-remote-surface-toggle-"));
  try {
    writeFileSync(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: [REMOTE_SURFACE_FACTORY_NAME] }));
    const disabled = readDisabledFeatures({ agentDir, env: {} });
    const result = applyFeatureToggles(
      [{ name: "providers" }, ...createRemoteSurfaceFactories(), { name: "rubato-components" }],
      disabled,
    );
    assert.deepEqual(result.extensionFactories.map((entry) => entry.name), ["providers", "rubato-components"]);
    assert.deepEqual(result.disabled, [REMOTE_SURFACE_FACTORY_NAME]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
