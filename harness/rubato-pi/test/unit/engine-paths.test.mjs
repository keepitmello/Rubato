import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEnginePluginDir,
  rubatoExtension,
  rubatoTaskExtension,
} from "../../src/engine-paths.mjs";

test("launcher-facing engine paths are Rubato-named bundles", () => {
  assert.match(rubatoExtension, /extensions\/rubato\.js$/);
  assert.match(rubatoTaskExtension, /extensions\/rubato-task\.js$/);
});

test("non-empty RUBATO_ENGINE_DIR is authoritative when the directory is missing", () => {
  const pinned = join(tmpdir(), "rubato-engine-missing-dir", "plugin");
  const resolved = resolveEnginePluginDir({
    RUBATO_ENGINE_DIR: pinned,
    HOME: join(tmpdir(), "rubato-engine-other-home"),
  });
  assert.equal(resolved, pinned);
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
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pinned, { recursive: true, force: true });
  }
});
