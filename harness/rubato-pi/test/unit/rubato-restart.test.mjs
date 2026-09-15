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
const installGuiSource = readFileSync(
  fileURLToPath(new URL("../../../t3-integration/install-gui.sh", import.meta.url)),
  "utf8",
);
const installMacosAppSource = readFileSync(
  fileURLToPath(new URL("../../../t3-integration/install-macos-app.sh", import.meta.url)),
  "utf8",
);

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

// Fixture launcher: the real rubato-pi.sh with a fake node that answers for
// each helper, and a fake launchctl that decides hub presence. The fake node
// appends every invocation to a log so tests can prove each part ran.
//
// The desktop-app step is faked the same way, and never touches the real
// machine: RUBATO_GUI_APP points at a fixture bundle (or a missing path for
// "not installed"), a stateful fake pgrep reports whether the app is running,
// a fake osascript performs the graceful quit by flipping that state, and a
// fake start-gui.sh records the relaunch. guiMode selects the scenario:
//
//   absent    bundle missing entirely ("not installed")
//   off       bundle present, process not running ("installed but not running")
//   running   bundle present and running; quit succeeds, relaunch succeeds
//   quit-fail running, but the quit request itself fails
//   quit-hang running; quit is accepted but the process never goes away
//   helpers-linger quit succeeded, but leftover Helper processes still
//              match a naive `Rubato.app` pattern. Relaunch must still run.
function restartHarness(t, { engineToken = "restarted", engineExit = 0, hubPresent = true, hubExit = 0,
  guiMode = "absent", guiRelaunchExit = 0, guiRelaunchSleep = 0 } = {}) {
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

  // Desktop-app fakes. The state file holds "running" or "stopped"; the
  // osascript fake flips it on a quit request unless the mode says otherwise.
  const guiApp = guiMode === "absent" ? join(root, "no-Rubato.app") : join(root, "Rubato.app");
  if (guiMode !== "absent") mkdirSync(guiApp, { recursive: true });
  const guiState = join(root, "gui-state");
  writeFileSync(guiState, guiMode === "off" || guiMode === "absent" ? "stopped" : "running");
  const fakePgrep = join(root, "fake-pgrep");
  executable(
    fakePgrep,
    "#!/bin/sh\n" +
      `STATE="$(cat '${guiState}')"\n` +
      (guiMode === "helpers-linger"
        ? "if [ \"$STATE\" = \"running\" ]; then exit 0; fi\n" +
          "case \"$2\" in\n" +
          "  *Contents/MacOS/Electron*) exit 1 ;;\n" +
          "  *) exit 0 ;;\n" +
          "esac\n"
        : "if [ \"$STATE\" = \"running\" ]; then exit 0; else exit 1; fi\n"),
  );
  const quitLog = join(root, "osascript-calls.log");
  writeFileSync(quitLog, "");
  const fakeOsascript = join(root, "fake-osascript");
  executable(
    fakeOsascript,
    "#!/bin/sh\n" +
      `printf '%s\\n' "$*" >> '${quitLog}'\n` +
      (guiMode === "quit-fail" ? "exit 1\n" : guiMode === "quit-hang" ? "exit 0\n" : `printf 'stopped' > '${guiState}'\nexit 0\n`),
  );
  const guiMarker = join(root, "gui-relaunched");
  const fakeStartGui = join(root, "fake-start-gui.sh");
  executable(
    fakeStartGui,
    "#!/bin/sh\n" +
      `printf 'START-GUI\\n' >> '${log}'\n` +
      `printf 'relaunched' > '${guiMarker}'\n` +
      (guiRelaunchSleep > 0 ? `sleep ${guiRelaunchSleep}\n` : "") +
      `exit ${guiRelaunchExit}\n`,
  );

  const env = {
    ...process.env,
    HOME: join(root, "home"),
    RUBATO_LAUNCHCTL_BIN: fakeLaunchctl,
    RUBATO_PGREP_BIN: fakePgrep,
    RUBATO_OSASCRIPT_BIN: fakeOsascript,
    RUBATO_GUI_APP: guiApp,
    RUBATO_START_GUI: fakeStartGui,
    RUBATO_GUI_LOG: join(root, "gui-restart.log"),
    RUBATO_GUI_WAIT_SECS: "2",
  };
  mkdirSync(env.HOME, { recursive: true });
  return {
    run(args) {
      return spawnSync(launcher, args, { cwd: root, env, encoding: "utf8" });
    },
    calls() {
      return readFileSync(log, "utf8");
    },
    quitCalls() {
      return readFileSync(quitLog, "utf8");
    },
    relaunched() {
      try { return readFileSync(guiMarker, "utf8"); } catch { return undefined; }
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
  assert.match(result.stdout, /데스크톱 앱이 없어 건너뜁니다/);
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
  // The old "(T3는 스스로 다시 붙습니다)" parenthetical is gone on purpose:
  // a running app no longer rides out the restart — it is quit and relaunched
  // for fresh bridge code, and the app step says so.
  assert.doesNotMatch(launcherText, /T3는 스스로 다시 붙습니다/);
  assert.match(launcherText, /바뀐 브리지 코드를 읽습니다/);
});

test("restart quits the app gracefully and relaunches through the single launcher", () => {
  assert.match(launcherText, /osascript/);
  assert.match(launcherText, /start-gui\.sh/);
  // Helpers live under Rubato.app/Contents/Frameworks — waiting on the
  // short pattern leaves the relaunch skipped after a successful quit.
  assert.match(launcherText, /Contents\/MacOS\/Electron/);
  assert.match(launcherText, /nohup/);
  // The embedded server owns SQLite state; a hard kill risks leaving it
  // inconsistent, so the app path never kills. (The engine comment mentions
  // kill -9 only to forbid it, so the kill assertions are scoped to the app.)
  assert.doesNotMatch(launcherText, /killall|pkill/);
  assert.doesNotMatch(launcherText, /kill "\$GUI_PID"|kill \$GUI_PID/);
  // Scoped to the desktop-app step: no kill of any form between the quit
  // request and the relaunch. (The engine comment above mentions kill -9
  // only to forbid it on the profile-lock path.)
  const guiStep = launcherText.slice(
    launcherText.indexOf("# Desktop app last"),
    launcherText.indexOf("재시작할 것이 없습니다"),
  );
  // Comments explain the no-kill rule, so assert on code lines only.
  const guiCode = guiStep.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(guiCode, /kill/);
});

test("restart relaunches the desktop app last, after engine and hub", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 0, guiMode: "running" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데스크톱 앱을 다시 켰습니다/);
  assert.equal(harness.relaunched(), "relaunched");
  // Graceful quit only: the same event as Dock > Quit, never a kill.
  assert.match(harness.quitCalls(), /tell application "Rubato" to quit/);
  // Order: engine, then hub, then the app launcher — the app connects to the
  // engine, so it must come after the engine restart, not before.
  const order = harness.calls();
  assert.ok(order.indexOf("restart-profile-engine.mjs") < order.indexOf("rubato-hub-restart.mjs"), order);
  assert.ok(order.indexOf("rubato-hub-restart.mjs") < order.indexOf("START-GUI"), order);
});

test("restart still reports the app when the relauncher stays up", (t) => {
  // start-gui.sh execs Electron, which outlives the check: the launcher pid
  // is still alive after the settle sleep.
  const harness = restartHarness(t, { guiMode: "running", guiRelaunchSleep: 5 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데스크톱 앱을 다시 켰습니다/);
  assert.equal(harness.relaunched(), "relaunched");
});

test("restart skips cleanly when the app is installed but not running", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: false, guiMode: "off" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데스크톱 앱은 이미 꺼져 있어 건너뜁니다/);
  assert.equal(harness.relaunched(), undefined);
  assert.equal(harness.quitCalls(), "");
});

test("restart fails without relaunching when the app refuses the quit request", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 0, guiMode: "quit-fail" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /데스크톱 앱에 종료를 요청하지 못했습니다\. 옛 코드가 그대로입니다/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /다시 켰습니다/);
  // Never relaunched, and never told the user it will return on its own.
  assert.equal(harness.relaunched(), undefined);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /스스로/);
});

test("restart does not relaunch when the app ignores the quit request", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: false, guiMode: "quit-hang" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /종료 요청을 받고도 끝나지 않았습니다\. 옛 코드가 그대로입니다/);
  assert.match(result.stderr, /다시 켜지 않았습니다/);
  assert.equal(harness.relaunched(), undefined);
});

test("restart relaunches even when Electron helpers still match Rubato.app", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: false, guiMode: "helpers-linger" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데스크톱 앱을 다시 켰습니다/);
  assert.equal(harness.relaunched(), "relaunched");
});

test("updater GUI step rebuilds on disk without touching the running app", () => {
  // need_gui routes through install-gui.sh --apply: pin checkout, overlay,
  // on-disk bundle rebuild, /Applications relink. No quit, kill, or relaunch
  // of the live process anywhere on that path — so the restart verb's new
  // app relaunch cannot double-fire from an update. The updater is left alone.
  assert.match(updateSource, /install-gui\.sh" --apply/);
  assert.match(updateSource, /need_gui/);
  for (const source of [installGuiSource, installMacosAppSource]) {
    assert.doesNotMatch(source, /osascript/);
    assert.doesNotMatch(source, /kickstart/);
    assert.doesNotMatch(source, /pkill|killall|kill /);
  }
});

test("updater hub step calls the hub helper directly, not the user-facing restart verb", () => {
  // `rubato restart` now also restarts the profile engine, so routing the
  // hub step through it would kill live conversations on a hub-only change.
  assert.doesNotMatch(updateSource, /rubato-pi\.sh" restart/);
  assert.match(updateSource, /rubato-hub-restart\.mjs/);
  assert.match(updateSource, /need_hub/);
});
