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
const restartGuiSource = fileURLToPath(new URL("../../../t3-integration/restart-gui.sh", import.meta.url));
const restartGuiText = readFileSync(restartGuiSource, "utf8");
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
// The engine-build step is faked the same way. `engineBuild` selects it:
//
//   fresh    build-active-engine.mjs --check says the install matches (exit 0)
//   stale    --check says it does not (exit 10); the full build then succeeds
//   fail     --check says stale and the full build fails
//   absent   no build script on this machine at all
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
  guiMode = "absent", guiRelaunchExit = 0, guiRelaunchSleep = 0,
  installGui = false, installGuiExit = 0, engineBuild = "fresh" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rubato-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "harness", "scripts");
  mkdirSync(scripts, { recursive: true });
  const launcher = join(scripts, "rubato-pi.sh");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o755);
  // The launcher sources this for the progress line and the ✓/·/✗ shapes.
  copyFileSync(
    fileURLToPath(new URL("../../../scripts/rubato-progress.sh", import.meta.url)),
    join(scripts, "rubato-progress.sh"),
  );
  // Presence alone decides whether the build step runs; the fake node answers.
  if (engineBuild !== "absent") writeFileSync(join(scripts, "build-active-engine.mjs"), "");

  const log = join(root, "node-calls.log");
  writeFileSync(log, "");
  const fakeNode = join(root, "fake-node");
  const checkExit = engineBuild === "fresh" ? 0 : 10;
  const buildExit = engineBuild === "fail" ? 1 : engineBuild === "hosted" ? 20 : 0;
  // Who restarts after a rebuild: the build itself, or the caller that set the owner flag.
  const ownerLog = join(root, "build-owner.log");
  writeFileSync(ownerLog, "");
  executable(
    fakeNode,
    "#!/bin/sh\n" +
      `printf '%s\\n' "$*" >> '${log}'\n` +
      "case \"$1\" in\n" +
      `  *build-active-engine.mjs)\n` +
      `    if [ "$2" = "--check" ]; then exit ${checkExit}; fi\n` +
      `    printf 'owner=%s\\n' "\${RUBATO_PROFILE_RESTART_OWNER-}" >> '${ownerLog}'\n` +
      `    exit ${buildExit} ;;\n` +
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

  // The bundle step. Absent by default so the pre-existing cases keep
  // asserting the machine-without-an-installer behaviour; when present it
  // records into the same log, which is what proves the ordering.
  const fakeInstallGui = join(root, "fake-install-gui.sh");
  if (installGui) {
    executable(
      fakeInstallGui,
      "#!/bin/sh\n" +
        `printf 'INSTALL-GUI %s\\n' "$*" >> '${log}'\n` +
        `exit ${installGuiExit}\n`,
    );
  }

  const env = {
    ...process.env,
    HOME: join(root, "home"),
    RUBATO_LAUNCHCTL_BIN: fakeLaunchctl,
    RUBATO_PGREP_BIN: fakePgrep,
    RUBATO_OSASCRIPT_BIN: fakeOsascript,
    RUBATO_GUI_APP: guiApp,
    RUBATO_START_GUI: fakeStartGui,
    // The real restart-gui.sh, driven through its own seams: the fixture
    // exercises the actual quit/rebuild/relaunch code rather than a stand-in.
    RUBATO_RESTART_GUI: restartGuiSource,
    RUBATO_INSTALL_GUI: installGui ? fakeInstallGui : join(root, "no-install-gui.sh"),
    RUBATO_GUI_LOG: join(root, "gui-restart.log"),
    RUBATO_GUI_WAIT_SECS: "2",
  };
  mkdirSync(env.HOME, { recursive: true });
  return {
    root,
    run(args, extraEnv = {}) {
      return spawnSync(launcher, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
    },
    calls() {
      return readFileSync(log, "utf8");
    },
    buildOwners() {
      return readFileSync(ownerLog, "utf8");
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
  assert.match(result.stdout, /✓ 프로필 엔진/);
  assert.match(result.stdout, /✓ remote hub/);
  // The helper's stderr (in-flight turn names) flows to the user untouched.
  assert.match(result.stderr, /ENGINE-STDERR-MARKER/);
});

test("restart skips cleanly with exit 0 when neither side is present", (t) => {
  const harness = restartHarness(t, { engineToken: "missing", engineExit: 0, hubPresent: false, engineBuild: "absent" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /프로필 엔진이 없어요/);
  assert.match(result.stdout, /remote hub 은 이 기기에 없어요/);
  assert.match(result.stdout, /데스크톱 앱이 없어요/);
  assert.match(result.stdout, /다시 띄울 것이 없었어요/);
  // Only the helper's own stderr flows through; the launcher adds no failure lines.
  assert.match(result.stderr, /ENGINE-STDERR-MARKER/);
  assert.doesNotMatch(result.stderr, /✗/);
});

test("restart keeps going to the hub when the engine reports dead, still exit 0", (t) => {
  const harness = restartHarness(t, { engineToken: "dead", engineExit: 0, hubPresent: true, hubExit: 0 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /프로필 엔진은 이미 꺼져 있어요/);
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

// What the user has to do afterwards is said once, at the end, and only when
// something was actually cut. Repeating it on every step buried the one
// sentence that asks for an action.
test("restart closes with the one thing the user must do, only when a session was cut", (t) => {
  const restarted = restartHarness(t, { engineToken: "restarted", hubPresent: true }).run(["restart"]);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.stdout, /rubato.* 를 다시 실행해 이어가세요/);
  assert.equal(restarted.stdout.match(/다시 실행해 이어가세요/g).length, 1);
  // Nothing was cut: no instruction to reattach anything.
  const dead = restartHarness(t, { engineToken: "dead", hubPresent: true }).run(["restart"]);
  assert.equal(dead.status, 0, dead.stderr);
  assert.doesNotMatch(dead.stdout, /다시 실행해 이어가세요/);
});

test("restart says the app reads the new bridge code without rebuilding for it", () => {
  assert.match(restartGuiText, /바뀐 브리지 코드를 읽습니다/);
  // The bridge is imported at runtime from the repo, so it is not part of what
  // the bundle fingerprint guards. Keeping it there rebuilt all of T3 for a
  // file that never reaches the bundle.
  assert.doesNotMatch(installGuiSource, /find "\$HERE\/overlay" "\$HERE\/src"/);
  assert.match(installGuiSource, /find "\$HERE\/overlay" -type f/);
});

// `restart` means "rebuild from this working tree, then bring the old code
// down onto it". Conversations run the install under ~/.rubato-pi/stock-engine,
// not the repo, and nothing in restart used to refresh it — so `restart`
// followed by `rubato attach` re-entered old code.
test("restart brings the engine up to this source before it kills anything", (t) => {
  const harness = restartHarness(t, { engineBuild: "stale", hubPresent: true });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /엔진을 다시 만들었어요/);
  const order = harness.calls();
  assert.ok(order.indexOf("build-active-engine.mjs") < order.indexOf("restart-profile-engine.mjs"), order);
});

test("restart skips the engine build when the install already matches this source", (t) => {
  const harness = restartHarness(t, { engineBuild: "fresh", hubPresent: true });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /엔진은 이미 이 소스에 맞아요/);
  // Only the check ran; the minutes-long build did not.
  assert.match(harness.calls(), /build-active-engine\.mjs --check/);
  assert.doesNotMatch(harness.calls(), /build-active-engine\.mjs$/m);
});

test("a failed engine build exits nonzero and says the old code is still there", (t) => {
  const harness = restartHarness(t, { engineBuild: "fail", hubPresent: true });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /엔진을 다시 만들지 못했습니다\. 옛 코드가 그대로입니다/);
});

// `restart` never reaches the network: pulling is what `rubato update` is for.
test("restart does not pull", () => {
  const block = launcherText.slice(launcherText.indexOf("  restart)"), launcherText.indexOf("  new|attach|list"));
  // Comments say the rule out loud; assert on the code that obeys it.
  const code = block.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /git (pull|fetch)/);
  assert.doesNotMatch(code, /rubato-update\.sh/);
});

// Each step's own output is dozens of lines nobody reads when it went well.
test("restart keeps step output in a log instead of on the screen", () => {
  assert.match(launcherText, /RESTART_LOG/);
  assert.match(restartGuiText, /INSTALL_LOG/);
  assert.match(restartGuiText, /sh "\$INSTALL_GUI" --apply >"\$INSTALL_LOG" 2>&1/);
});

test("restart quits the app gracefully and relaunches through the single launcher", () => {
  // The app is handled in one place now, shared with the updater.
  assert.match(launcherText, /restart-gui\.sh/);
  assert.match(restartGuiText, /osascript/);
  assert.match(restartGuiText, /start-gui\.sh/);
  // Helpers live under Rubato.app/Contents/Frameworks — waiting on the
  // short pattern leaves the relaunch skipped after a successful quit.
  assert.match(restartGuiText, /Contents\/MacOS\/Electron/);
  assert.match(restartGuiText, /nohup/);
  // The embedded server owns SQLite state; a hard kill risks leaving it
  // inconsistent, so the app path never kills. Comments explain the rule, so
  // assert on code lines only.
  assert.doesNotMatch(restartGuiText, /killall|pkill/);
  const guiCode = restartGuiText.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(guiCode, /kill/);
});

test("restart relaunches the desktop app last, after engine and hub", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 0, guiMode: "running" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ 데스크톱 앱/);
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
  assert.match(result.stdout, /✓ 데스크톱 앱/);
  assert.equal(harness.relaunched(), "relaunched");
});

test("restart skips cleanly when the app is installed but not running", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: false, guiMode: "off" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데스크톱 앱은 이미 꺼져 있어요/);
  assert.equal(harness.relaunched(), undefined);
  assert.equal(harness.quitCalls(), "");
});

test("restart fails without relaunching when the app refuses the quit request", (t) => {
  const harness = restartHarness(t, { engineToken: "restarted", engineExit: 0, hubPresent: true, hubExit: 0, guiMode: "quit-fail" });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /데스크톱 앱에 종료를 요청하지 못했습니다\. 옛 코드가 그대로입니다/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /✓ 데스크톱 앱/);
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
  assert.match(result.stdout, /✓ 데스크톱 앱/);
  assert.equal(harness.relaunched(), "relaunched");
});

// The pin and the overlay are compiled into the T3 server bundle, so a
// relaunch alone leaves them stale. `restart` is where a user expects new
// code to take effect, and the window between quit and relaunch is the only
// safe place to rebuild — the build replaces the dist a running app reads.
test("restart rebuilds the bundle while the app is down, then relaunches", (t) => {
  const harness = restartHarness(t, { guiMode: "running", installGui: true });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ 데스크톱 앱/);
  assert.equal(harness.relaunched(), "relaunched");
  const order = harness.calls();
  assert.match(order, /INSTALL-GUI --apply/);
  // Strictly between the quit and the relaunch: rebuilding under a live app
  // would swap the dist it is reading.
  assert.ok(order.indexOf("INSTALL-GUI") < order.indexOf("START-GUI"), order);
});

test("restart reports a failed rebuild but still brings the app back", (t) => {
  const harness = restartHarness(t, { guiMode: "running", installGui: true, installGuiExit: 1 });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /옛 번들 그대로 다시 켭니다/);
  // Leaving the user with no app would be worse than an old bundle.
  assert.equal(harness.relaunched(), "relaunched");
});

test("restart brings a stopped app's bundle up to the pin without launching it", (t) => {
  const harness = restartHarness(t, { hubPresent: false, guiMode: "off", installGui: true });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /다음에 켜면 새 코드로 떠요/);
  assert.match(harness.calls(), /INSTALL-GUI --apply/);
  // `restart` does not decide that this machine wants a window open.
  assert.equal(harness.relaunched(), undefined);
  assert.equal(harness.quitCalls(), "");
});

test("both verbs reach the app through the one script that owns it", () => {
  // A rebuilt bundle that nobody relaunches is invisible: the updater used to
  // stop at the disk and print "다음 세션부터 적용돼요", leaving the running app
  // on old code. Both verbs now call restart-gui.sh, so quit/rebuild/relaunch
  // is decided in one place and they cannot drift apart.
  assert.match(updateSource, /restart-gui\.sh/);
  assert.match(launcherText, /restart-gui\.sh/);
  assert.match(updateSource, /need_gui/);
  // The installers stay pure disk work; stopping and starting the app is
  // restart-gui.sh's job alone.
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

// A rebuild restarts the profile engine exactly once. The build would do it on its own
// (replace-live-engine.mjs); `restart` owns that step and tells the build so, or its own step
// would find the engine already gone and report "이미 꺼져 있어요" after a real restart.
test("restart rebuilds as the restart owner, so the engine restarts once and is reported as restarted", (t) => {
  const harness = restartHarness(t, { engineBuild: "stale", engineToken: "restarted", hubPresent: false });
  const result = harness.run(["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(harness.buildOwners(), "owner=1\n");
  assert.equal(harness.calls().match(/restart-profile-engine\.mjs/g)?.length, 1, harness.calls());
  assert.match(result.stdout, /엔진을 다시 만들었어요/);
  assert.match(result.stdout, /✓ 프로필 엔진/);
});

// Session start is the path that left pid 4902 running old code on a new install: the build
// there owns the restart, so the launcher must not claim it.
// `--print` is also what `rubato dispatch` runs from inside a conversation.
function sessionStart(harness) {
  mkdirSync(join(harness.root, "harness", "rubato-pi"), { recursive: true });
  mkdirSync(join(harness.root, "harness", "prompts"), { recursive: true });
  executable(join(harness.root, "harness", "prompts", "build.sh"), "#!/bin/sh\nexit 0\n");
  return harness.run(["--print", "hello"], {
    RUBATO_NO_UPDATE_CHECK: "1", RUBATO_NO_MSEARCH_CHECK: "1", RUBATO_NO_VAULT: "1", RUBATO_NO_KIRO_HEAL: "1",
  });
}

test("session start lets a real rebuild restart the engine itself", (t) => {
  const harness = restartHarness(t, { engineBuild: "stale", hubPresent: false });
  const result = sessionStart(harness);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(harness.buildOwners(), "owner=\n", "the build is not told someone else restarts");
  assert.doesNotMatch(harness.calls(), /restart-profile-engine\.mjs/, "the launcher adds no second restart");
  assert.match(harness.calls(), /bin\/rubato-pi\.mjs --print hello/, "and the session still starts");
});

test("session start with a current engine builds nothing", (t) => {
  const harness = restartHarness(t, { engineBuild: "fresh", hubPresent: false });
  const result = sessionStart(harness);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(harness.buildOwners(), "");
  assert.match(harness.calls(), /bin\/rubato-pi\.mjs --print hello/);
});

test("session start inside an engine conversation goes on with the unchanged engine", (t) => {
  const harness = restartHarness(t, { engineBuild: "hosted", hubPresent: false });
  const result = sessionStart(harness);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /pi 엔진을 맞추지 못했습니다/);
  assert.match(harness.calls(), /bin\/rubato-pi\.mjs --print hello/);
});

test("session start stops when the build fails", (t) => {
  const harness = restartHarness(t, { engineBuild: "fail", hubPresent: false });
  const result = sessionStart(harness);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi 엔진을 맞추지 못했습니다/);
  assert.doesNotMatch(harness.calls(), /bin\/rubato-pi\.mjs --print hello/);
});
