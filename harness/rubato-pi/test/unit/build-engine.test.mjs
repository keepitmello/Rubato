import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const builder = join(repoRoot, "harness", "scripts", "build-engine.mjs");

test("freshness inputs include the engine builder and Rubato plugin mapping", () => {
  const src = readFileSync(builder, "utf8");
  assert.match(src, /join\(here, "build-engine\.mjs"\)/);
  assert.match(src, /#rubato-task-runtime/);
  assert.match(src, /\.\/extensions\/rubato\.js/);
});

test("isolated RUBATO_ENGINE_DIR build emits Rubato-named launcher bundle", { timeout: 120_000 }, () => {
  const engineDir = mkdtempSync(join(tmpdir(), "rubato-engine-"));
  try {
    execFileSync(process.execPath, [builder, "--force"], {
      cwd: repoRoot,
      env: { ...process.env, RUBATO_ENGINE_DIR: engineDir },
      stdio: "pipe",
    });
    const bundle = join(engineDir, "extensions", "rubato.js");
    const task = join(engineDir, "extensions", "rubato-task.js");
    const member = join(engineDir, "extensions", "rubato-member.js");
    const memoryMcp = join(engineDir, "extensions", "rubato-memory-mcp.js");
    const manifest = JSON.parse(readFileSync(join(engineDir, "package.json"), "utf8"));
    assert.equal(existsSync(bundle), true);
    assert.equal(existsSync(join(engineDir, "extensions", "rubato-task.js")), true);
    assert.equal(existsSync(join(engineDir, "extensions", "rubato-member.js")), true);
    assert.equal(existsSync(join(engineDir, "extensions", "rubato-memory-mcp.js")), true);
    assert.deepEqual(manifest.pi?.extensions, ["./extensions/rubato.js"]);
    assert.deepEqual(manifest.imports, { "#rubato-task-runtime": "./extensions/rubato-task.js" });
    const mainText = readFileSync(bundle, "utf8");
    const taskText = readFileSync(task, "utf8");
    assert.match(mainText, /#rubato-task-runtime/);
    assert.match(taskText, /rubato-member\.js/);
    assert.match(mainText, /rubato-memory-mcp\.js/);
    assert.equal(existsSync(member), true);
    assert.equal(existsSync(memoryMcp), true);
    const check = execFileSync(process.execPath, [builder, "--check"], {
      cwd: repoRoot,
      env: { ...process.env, RUBATO_ENGINE_DIR: engineDir },
      encoding: "utf8",
    });
    assert.equal(check, "");
  } finally {
    rmSync(engineDir, { recursive: true, force: true });
  }
});

test("explicit missing RUBATO_ENGINE_DIR fails check against that path", () => {
  const engineDir = mkdtempSync(join(tmpdir(), "rubato-engine-missing-"));
  const pinned = join(engineDir, "plugin");
  try {
    let status = 0;
    try {
      execFileSync(process.execPath, [builder, "--check"], {
        cwd: repoRoot,
        env: { ...process.env, RUBATO_ENGINE_DIR: pinned },
        stdio: "pipe",
      });
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 10);
    assert.equal(existsSync(join(pinned, "extensions", "rubato.js")), false);
  } finally {
    rmSync(engineDir, { recursive: true, force: true });
  }
});
