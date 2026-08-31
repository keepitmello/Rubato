import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineBuilt,
  ensureEngineNodeModules,
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

test("ensureEngineNodeModules retargets a release leftover /tmp symlink", () => {
  const plugin = mkdtempSync(join(tmpdir(), "rubato-engine-links-"));
  const repo = mkdtempSync(join(tmpdir(), "rubato-engine-repo-"));
  const stale = join(tmpdir(), "rubato-release-gone", "node_modules");
  try {
    mkdirSync(join(plugin, "extensions"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "@earendil-works", "pi-tui"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), "{}\n");
    writeFileSync(join(plugin, "extensions", "rubato.js"), "export {}\n");
    symlinkSync(stale, join(plugin, "node_modules"), "dir");
    symlinkSync(join(stale, "@code-yeongyu", "senpi", "node_modules"), join(plugin, "extensions", "node_modules"), "dir");
    const linked = ensureEngineNodeModules(plugin, repo);
    assert.ok(linked.length >= 1);
    assert.equal(readlinkSync(join(plugin, "node_modules")), join(repo, "node_modules"));
    assert.equal(readlinkSync(join(plugin, "extensions", "node_modules")), join(repo, "node_modules"));
  } finally {
    rmSync(plugin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("assertEngineBuilt repairs module links on a live plugin dir", () => {
  const plugin = mkdtempSync(join(tmpdir(), "rubato-engine-assert-"));
  const repo = mkdtempSync(join(tmpdir(), "rubato-engine-assert-repo-"));
  try {
    mkdirSync(join(plugin, "extensions"), { recursive: true });
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), "{}\n");
    writeFileSync(join(plugin, "extensions", "rubato.js"), "export {}\n");
    symlinkSync("/private/tmp/rubato-release-missing/node_modules", join(plugin, "node_modules"), "dir");
    assertEngineBuilt({ RUBATO_ENGINE_DIR: plugin, HOME: join(tmpdir(), "rubato-engine-assert-home") });
    // assertEngineBuilt uses the live repoRoot for links, not the fake repo.
    // Just prove it no longer points at the missing /tmp path.
    assert.notEqual(readlinkSync(join(plugin, "node_modules")), "/private/tmp/rubato-release-missing/node_modules");
  } finally {
    rmSync(plugin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
