import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineBuilt,
  resolveEnginePluginDir,
  rubatoExtension,
  rubatoTaskExtension,
  enginePackageJson,
} from "../../src/engine-paths.mjs";
import { PIN } from "../../src/policy.mjs";
import { readPinnedVersions } from "../../src/launch.mjs";

test("launcher-facing engine paths are Rubato-named bundles", () => {
  assert.match(rubatoExtension, /extensions\/rubato\.js$/);
  assert.match(rubatoTaskExtension, /extensions\/rubato-task\.js$/);
});

test("live engine pin matches the Rubato-built plugin", () => {
  const engine = JSON.parse(readFileSync(enginePackageJson, "utf8"));
  assert.deepEqual(engine.pi?.extensions, ["./extensions/rubato.js"]);
  assert.deepEqual(engine.imports, { "#rubato-task-runtime": "./extensions/rubato-task.js" });
  assert.deepEqual(readPinnedVersions(), { engine: PIN.engine, senpi: PIN.senpi });
});

test("non-empty RUBATO_ENGINE_DIR is authoritative when the directory is missing", () => {
  const pinned = join(tmpdir(), "rubato-engine-missing-dir", "plugin");
  const resolved = resolveEnginePluginDir({
    RUBATO_ENGINE_DIR: pinned,
    HOME: join(tmpdir(), "rubato-engine-other-home"),
  });
  assert.equal(resolved, pinned);
  assert.throws(
    () => assertEngineBuilt({ RUBATO_ENGINE_DIR: pinned }),
    (error) => {
      assert.match(String(error.message), /엔진 산출물이 없다/);
      assert.match(String(error.message), new RegExp(pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("incomplete pinned RUBATO_ENGINE_DIR does not fall back to ~/.rubato-pi", () => {
  const home = mkdtempSync(join(tmpdir(), "rubato-engine-home-"));
  const pinned = mkdtempSync(join(tmpdir(), "rubato-engine-incomplete-"));
  try {
    mkdirSync(join(home, ".rubato-pi", "engine", "plugin", "extensions"), { recursive: true });
    writeFileSync(join(home, ".rubato-pi", "engine", "plugin", "package.json"), "{}\n");
    writeFileSync(join(home, ".rubato-pi", "engine", "plugin", "extensions", "rubato.js"), "export {}\n");
    writeFileSync(join(pinned, "package.json"), "{}\n");
    const resolved = resolveEnginePluginDir({ RUBATO_ENGINE_DIR: pinned, HOME: home });
    assert.equal(resolved, pinned);
    assert.throws(
      () => assertEngineBuilt({ RUBATO_ENGINE_DIR: pinned, HOME: home }),
      (error) => {
        assert.match(String(error.message), new RegExp(pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(String(error.message), /\.rubato-pi/);
        return true;
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pinned, { recursive: true, force: true });
  }
});
