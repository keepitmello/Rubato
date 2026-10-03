import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { BUILTINS_ENV, BUILTINS_OFF_BY_DEFAULT, stockDefaultsFeature } from "./patches.mjs";

const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-stock-defaults-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
const staged = await stagePiRuntime({
  sourceRoot: join(import.meta.dirname, "../.."),
  outputRoot: join(scratchRoot, "runtime"),
  features: [stockDefaultsFeature],
});
const dist = join(resolvePiRuntime({ root: staged.root }).codingAgentDir, "dist");
const url = (path, query = "") => `${pathToFileURL(join(dist, path)).href}${query}`;

test("built-in codemode, tool-search and mcp stay off unless the comparison env names them", async () => {
  const previous = process.env[BUILTINS_ENV];
  try {
    delete process.env[BUILTINS_ENV];
    const off = (await import(url("extensions/index.js", "?off"))).builtInExtensions.map((extension) => extension.name);
    for (const name of BUILTINS_OFF_BY_DEFAULT) assert.ok(!off.includes(name), `${name} must not load by default`);
    assert.ok(off.includes("llama.cpp"), "llama.cpp predates 0.99 and stays");
    process.env[BUILTINS_ENV] = "codemode, tool-search";
    const on = (await import(url("extensions/index.js", "?on"))).builtInExtensions.map((extension) => extension.name);
    assert.ok(on.includes("codemode") && on.includes("tool-search") && !on.includes("mcp"));
  }
  finally {
    if (previous === undefined) delete process.env[BUILTINS_ENV];
    else process.env[BUILTINS_ENV] = previous;
  }
});

test("unset tuiMode and enableInstallTelemetry mean regular and off; explicit settings still win", async () => {
  const { SettingsManager } = await import(url("core/settings-manager.js"));
  const unset = SettingsManager.inMemory();
  assert.equal(unset.getTuiMode(), "regular");
  assert.equal(unset.getEnableInstallTelemetry(), false);
  const explicit = SettingsManager.inMemory({ tuiMode: "fullscreen", enableInstallTelemetry: true });
  assert.equal(explicit.getTuiMode(), "fullscreen");
  assert.equal(explicit.getEnableInstallTelemetry(), true);
  const { isInstallTelemetryEnabled } = await import(url("core/telemetry.js"));
  assert.equal(isInstallTelemetryEnabled(unset, undefined), false);
  assert.equal(isInstallTelemetryEnabled(unset, "1"), true, "PI_TELEMETRY still overrides");
});

test("dark and light carry the 0.86.1 palettes and an unset theme resolves to dark or light, not system", async () => {
  for (const name of ["dark", "light"]) {
    const ours = JSON.parse(readFileSync(join(dist, `modes/interactive/theme/${name}.json`), "utf8"));
    const expected = JSON.parse(readFileSync(new URL(`./theme-${name}-0.86.1.json`, import.meta.url), "utf8"));
    assert.deepEqual(ours, expected);
    assert.equal(ours.appearance, name);
  }
  const theme = await import(url("modes/interactive/theme/theme.js"));
  const { InteractiveThemeController } = await import(url("modes/interactive/theme/theme-controller.js"));
  const resolve = (setting) => InteractiveThemeController.prototype.resolveThemeName.call({ getThemeSetting: () => setting });
  assert.notEqual(resolve(undefined), theme.SYSTEM_THEME_NAME);
  assert.ok(["dark", "light"].includes(resolve(undefined)));
  assert.equal(resolve("light"), "light", "an explicit theme still wins");
  assert.equal(resolve(theme.SYSTEM_THEME_NAME), theme.SYSTEM_THEME_NAME, "system stays selectable");
});
