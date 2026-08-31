import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherSource = fileURLToPath(new URL("../../../scripts/rubato-pi.sh", import.meta.url));

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function dispatcherHarness(t) {
  const root = mkdtempSync(join(tmpdir(), "rubato-dispatcher-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const scripts = join(root, "harness", "scripts");
  const prompts = join(root, "harness", "prompts");
  const engineBin = join(root, "harness", "rubato-pi", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(prompts, { recursive: true });
  mkdirSync(engineBin, { recursive: true });

  const launcher = join(scripts, "rubato-pi.sh");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o755);

  const argsPath = join(root, "engine-args.txt");
  const stdinPath = join(root, "engine-stdin.txt");
  const commandPath = join(root, "command.txt");
  const fakeNode = join(root, "fake-node");
  executable(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "$RUBATO_TEST_ARGS"\nif [ "\${RUBATO_TEST_GUARD_FAIL-}" = 1 ] && [ "\${2-}" = remote ] && [ "\${3-}" = update-guard ]; then exit 73; fi\ncat > "$RUBATO_TEST_STDIN"\n`);
  executable(join(scripts, "find-node.sh"), `#!/bin/sh\nrubato_find_node() { printf '%s\\n' "$RUBATO_TEST_NODE"; }\n`);
  executable(join(prompts, "build.sh"), `#!/bin/sh\nif [ "$#" -gt 0 ]; then printf 'build\\n%s\\n' "$@" > "$RUBATO_TEST_COMMAND"; fi\n`);
  executable(join(scripts, "rubato-auth.sh"), `#!/bin/sh\nprintf 'auth\\n%s\\n' "$@" > "$RUBATO_TEST_COMMAND"\n`);
  executable(join(scripts, "rubato-update.sh"), `#!/bin/sh\nprintf 'update\\n%s\\n' "$@" > "$RUBATO_TEST_COMMAND"\n`);
  executable(join(scripts, "rubato-aside-cursor.sh"), `#!/bin/sh\nprintf 'aside-cursor\\n%s\\n' "$@" > "$RUBATO_TEST_COMMAND"\n`);
  writeFileSync(join(engineBin, "rubato-pi.mjs"), "// argv sentinel\n");

  const env = {
    ...process.env,
    HOME: join(root, "home"),
    RUBATO_TEST_NODE: fakeNode,
    RUBATO_TEST_ARGS: argsPath,
    RUBATO_TEST_STDIN: stdinPath,
    RUBATO_TEST_COMMAND: commandPath,
    RUBATO_NO_UPDATE_CHECK: "1",
    RUBATO_NO_MSEARCH_CHECK: "1",
    RUBATO_NO_ENGINE_BUILD: "1",
    RUBATO_NO_VAULT: "1",
    RUBATO_NO_KIRO_HEAL: "1",
    RUBATO_NO_SPLASH: "1",
  };

  return {
    run(args, input = "", extraEnv = {}) {
      return spawnSync(launcher, args, { cwd: root, env: { ...env, ...extraEnv }, input, encoding: "utf8" });
    },
    engineArgs() {
      return readFileSync(argsPath, "utf8").trimEnd().split("\n");
    },
    engineInput() {
      return readFileSync(stdinPath, "utf8");
    },
    command() {
      return readFileSync(commandPath, "utf8").trimEnd().split("\n");
    },
    engineEntry: join(engineBin, "rubato-pi.mjs"),
    liveEntry: join(root, "packages", "rubato-live-cli", "bin", "rubato-live.mjs"),
  };
}

test("auth, update, and build remain launcher-owned passthrough commands", (t) => {
  for (const [command, extra] of [
    ["auth", ["status"]],
    ["update", ["--check"]],
    ["build", ["--force"]],
    ["aside-cursor", ["--help"]],
  ]) {
    const harness = dispatcherHarness(t);
    const result = harness.run([command, ...extra]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(harness.command(), [command, ...extra]);
  }
});

test("legacy update runs the live-session guard first and never delegates when blocked", (t) => {
  const harness = dispatcherHarness(t);
  const result = harness.run(["update"], "", { RUBATO_TEST_GUARD_FAIL: "1" });
  assert.equal(result.status, 73, result.stderr);
  assert.deepEqual(harness.engineArgs().slice(-2), ["remote", "update-guard"]);
  assert.throws(() => harness.command(), /ENOENT/);
});

test("ordinary arguments pass through unchanged to the existing engine", (t) => {
  const harness = dispatcherHarness(t);
  const args = ["fix the cache", "--model", "xai/grok-4.6"];
  const result = harness.run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(harness.engineArgs(), [harness.engineEntry, ...args]);
});

test("direct strips only its dispatcher marker before the existing engine", (t) => {
  const harness = dispatcherHarness(t);
  const args = ["--session", "/tmp/session.jsonl"];
  const result = harness.run(["direct", ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(harness.engineArgs(), [harness.engineEntry, ...args]);
});

test("explicit lifecycle commands enter the narrow live CLI before engine setup", (t) => {
  const harness = dispatcherHarness(t);
  const result = harness.run(["list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const [entry, ...args] = harness.engineArgs();
  assert.equal(resolve(entry), harness.liveEntry);
  assert.deepEqual(args, ["list", "--json"]);
});

test("non-TTY print and RPC modes bypass interaction and preserve argv", (t) => {
  for (const args of [["--print", "hello"], ["--mode", "rpc"], ["--mode=print", "hello"]]) {
    const harness = dispatcherHarness(t);
    const result = harness.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(harness.engineArgs(), [harness.engineEntry, ...args]);
  }
});

test("piped stdin reaches the existing engine byte-for-byte", (t) => {
  const harness = dispatcherHarness(t);
  const input = "first line\n둘째 줄\n";
  const result = harness.run([], input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(harness.engineArgs(), [harness.engineEntry]);
  assert.equal(harness.engineInput(), input);
});
