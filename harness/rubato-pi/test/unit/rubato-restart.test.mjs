import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcherSource = fileURLToPath(new URL("../../../scripts/rubato-pi.sh", import.meta.url));
const launcherText = readFileSync(launcherSource, "utf8");
const updateSource = readFileSync(
  fileURLToPath(new URL("../../../scripts/rubato-update.sh", import.meta.url)),
  "utf8",
);

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

// Fixture launcher: the real rubato-pi.sh with a fake node that answers for
// each helper, and a fake launchctl that decides hub presence. The fake node
// appends every invocation to a log so tests can prove both parts ran.
function restartHarness(t, { engineToken = "restarted", engineExit = 0, hubPresent = true, hubExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rubato-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "harness", "scripts");
  mkdirSync(scripts, { recursive: true });
  const launcher = join(scripts, "rubato-pi.sh");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o755);

  const log = join(root, "node-calls.log");
  writeFileSync(log, "");
  const fakeNode = join(root, "fake-node");
  executable(
    fakeNode,
    "#!/bin/sh\n" +
      `printf '%s\\n' "$*" >> '${log}'\n` +
      "case \"$1\" in\n" +
      `  *restart-profile-engine.mjs) printf 'ENGINE-STDERR-MARKER\\n' >&2; printf '%s\\n' '${engineToken}'; exit ${engineExit} ;;\n` +
      `  *rubato-hub-restart.mjs) printf '{"ok":true}\\n'; exit ${hubExit} ;;\n` +
      "esac\n" +
      "exit 0\n",
  );
  executable(join(scripts, "find-node.sh"), `#!/bin/sh\nrubato_find_node() { printf '%s\\n' '${fakeNode}'; }\n`);
  const fakeLaunchctl = join(root, "fake-launchctl");
  executable(fakeLaunchctl, hubPresent ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\nexit 1\n");

  const env = {
    ...process.env,
    HOME: join(root, "home"),
    RUBATO_LAUNCHCTL_BIN: fakeLaunchctl,
  };
  mkdirSync(env.HOME, { recursive: true });
  return {
    run(args) {
      return spawnSync(launcher, args, { cwd: root, env, encoding: "utf8" });
    },
    calls() {
      return readFileSync(log, "utf8");
    },
  };
}

test("restart reaches the profile engine and the hub, and says which it did", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 0 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(harness.calls(), /restart-profile-engine\.mjs/);
  assert.match(harness.calls(), /rubato-hub-restart\.mjs/);
  assert.match(result.stdout, /프로필 엔진을 재시작했습니다/);
  assert.match(result.stdout, /remote hub을 재시작했습니다/);
  // The helper's stderr (in-flight turn names) flows to the user untouched.
  assert.match(result.stderr, /ENGINE-STDERR-MARKER/);
});

test("restart skips cleanly with exit 0 when neither side is present", (t) => {
  const harness = restartHarness(t, { engineToken: "missing", engineExit: 0, hubPresent: false });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /프로필 엔진이 없어 건너뜁니다/);
  assert.match(result.stdout, /remote hub launch agent이 없어 건너뜁니다/);
  assert.match(result.stdout, /재시작할 것이 없습니다/);
  // Only the helper's own stderr flows through; the launcher adds no failure lines.
  assert.equal(result.stderr, "ENGINE-STDERR-MARKER\n");
});

test("restart keeps going to the hub when the engine reports dead, still exit 0", (t) => {
  const harness = restartHarness(t, { engineToken: "dead", engineExit: 0, hubPresent: true, hubExit: 0 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /프로필 엔진은 이미 꺼져 있어 건너뜁니다/);
  assert.match(harness.calls(), /rubato-hub-restart\.mjs/);
});

for (const token of ["no-pid", "timeout 1234"]) {
  test(`engine ${token.split(" ")[0]} failure exits nonzero and names the old engine as still running`, (t) => {
    const harness = restartHarness(t, { engineToken: token, engineExit: 1, hubPresent: true, hubExit: 0 });
    const result = harness.run(["restart"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /옛 코드가 그대로입니다/);
    assert.doesNotMatch(result.stderr, /다음 세션이 새 엔진을 띄웁니다/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /새 엔진이 (자동으로|스스로)/);
    // The hub is independent: it is still attempted after an engine failure.
    assert.match(harness.calls(), /rubato-hub-restart\.mjs/);
  });
}

test("hub failure exits nonzero and names the old hub as still running", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 1 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /remote hub 재시작에 실패했습니다\. 옛 코드가 그대로입니다/);
});

test("restart states the CLI-reattach consequence next to the engine restart", () => {
  assert.match(launcherText, /다시 붙여야 합니다/);
  assert.match(launcherText, /T3는 스스로 다시 붙습니다/);
});

test("updater hub step calls the hub helper directly, not the user-facing restart verb", () => {
  // `rubato restart` now also restarts the profile engine, so routing the
  // hub step through it would kill live conversations on a hub-only change.
  assert.doesNotMatch(updateSource, /rubato-pi\.sh" restart/);
  assert.match(updateSource, /rubato-hub-restart\.mjs/);
  assert.match(updateSource, /need_hub/);
});
