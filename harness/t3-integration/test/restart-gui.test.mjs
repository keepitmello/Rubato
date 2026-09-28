import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const restartGui = fileURLToPath(new URL('../restart-gui.sh', import.meta.url));
const restartSrc = readFileSync(restartGui, 'utf8');

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function harness(t, {
  hostOs = 'MINGW64_NT-10.0-19045',
  app = false,
  bundle = false,
  running = false,
  quitFail = false,
  quitHang = false,
  installGui = true,
  sshServers = 2,
  // The run is the app's descendant (a restart pressed in the app): like macOS
  // pgrep, the fake leaves the app out unless -a asks for ancestors.
  descendant = false,
  // Someone opens the app (Dock, Finder) while the bundle is being rebuilt.
  openDuringBuild = false,
  // Only the first quit takes effect; later ones are ignored.
  quitOnce = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rb-restart-gui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const guiApp = app ? join(root, 'Rubato.app') : join(root, 'no-Rubato.app');
  if (app) mkdirSync(guiApp, { recursive: true });
  const guiBundle = bundle ? join(root, 'main.cjs') : join(root, 'missing', 'main.cjs');
  if (bundle) writeFileSync(guiBundle, '// desktop\n');
  const guiState = join(root, 'gui-state');
  writeFileSync(guiState, running ? 'running' : 'stopped');
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const fakePgrep = join(root, 'fake-pgrep');
  executable(fakePgrep, '#!/bin/sh\n' +
    (descendant ? 'case "$1" in -a*) ;; *) exit 1 ;; esac\n' : '') +
    `if [ "$(cat '${guiState}')" = running ]; then exit 0; else exit 1; fi\n`);
  const fakeOsascript = join(root, 'fake-osascript');
  executable(
    fakeOsascript,
    '#!/bin/sh\n' +
      `printf '%s\\n' "$*" >> '${log}'\n` +
      (quitFail ? 'exit 1\n' : quitHang ? 'exit 0\n'
        : quitOnce ? `[ "$(grep -c quit '${log}')" -gt 1 ] || printf 'stopped' > '${guiState}'\nexit 0\n`
        : `printf 'stopped' > '${guiState}'\nexit 0\n`),
  );
  const fakeQuit = join(root, 'fake-quit');
  executable(
    fakeQuit,
    '#!/bin/sh\n' +
      `printf 'QUIT-GUI\\n' >> '${log}'\n` +
      (quitFail ? 'exit 1\n' : quitHang ? 'exit 0\n' : `printf 'stopped' > '${guiState}'\nexit 0\n`),
  );
  const relaunch = join(root, 'relaunched');
  const fakeStart = join(root, 'fake-start-gui.sh');
  executable(fakeStart, `#!/bin/sh\nprintf 'START-GUI\\n' >> '${log}'\nprintf 'relaunched' > '${relaunch}'\nexit 0\n`);
  const fakeInstall = join(root, 'fake-install-gui.sh');
  executable(fakeInstall, `#!/bin/sh\nprintf 'INSTALL-GUI %s\\n' "$*" >> '${log}'\n` +
    (openDuringBuild ? `printf 'running' > '${guiState}'\n` : '') + 'exit 0\n');
  const fakeSshServers = join(root, 'fake-restart-ssh-servers.sh');
  executable(fakeSshServers, `#!/bin/sh\nprintf 'SSH-SERVERS\\n' >> '${log}'\nexit ${sshServers}\n`);
  const env = {
    ...process.env,
    HOME: home,
    RUBATO_HOST_OS: hostOs,
    RUBATO_PGREP_BIN: fakePgrep,
    RUBATO_OSASCRIPT_BIN: fakeOsascript,
    RUBATO_QUIT_GUI_BIN: fakeQuit,
    RUBATO_GUI_APP: guiApp,
    RUBATO_GUI_BUNDLE: guiBundle,
    RUBATO_START_GUI: fakeStart,
    RUBATO_INSTALL_GUI: installGui ? fakeInstall : join(root, 'no-install-gui.sh'),
    RUBATO_GUI_LOG: join(root, 'gui-restart.log'),
    RUBATO_GUI_WAIT_SECS: '2',
    RUBATO_RESTART_SSH_SERVERS: fakeSshServers,
  };
  return {
    home,
    run(extraEnv = {}, drop = []) {
      const runEnv = { ...env, ...extraEnv };
      for (const name of drop) delete runEnv[name];
      return spawnSync('sh', [restartGui], { cwd: root, env: runEnv, encoding: 'utf8' });
    },
    calls() {
      return readFileSync(log, 'utf8');
    },
    relaunched() {
      try { return readFileSync(relaunch, 'utf8'); } catch { return undefined; }
    },
  };
}

test('non-Darwin without .app still restarts when the desktop build exists', (t) => {
  const h = harness(t, { app: false, bundle: true, running: false });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /데스크톱 앱이 없어요/);
  assert.match(result.stdout, /데스크톱 번들/);
  assert.match(h.calls(), /INSTALL-GUI --apply/);
  assert.equal(h.relaunched(), undefined);
});

test('headless host restarts SSH-launched servers after syncing the bundle', (t) => {
  const h = harness(t, { app: false, bundle: true, running: false, sshServers: 0 });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(h.calls(), /INSTALL-GUI --apply\nSSH-SERVERS/);
  const failed = harness(t, { app: false, bundle: true, running: false, sshServers: 1 }).run();
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
});

test('running app restart also restarts SSH-launched servers', (t) => {
  const h = harness(t, { app: false, bundle: true, running: true, sshServers: 0 });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(h.calls(), /INSTALL-GUI --apply\nSSH-SERVERS\nSTART-GUI/);
});

test('non-Darwin without .app or desktop build still skips', (t) => {
  const h = harness(t, { app: false, bundle: false, running: false });
  const result = h.run();
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stdout, /데스크톱 앱이 없어요/);
  assert.doesNotMatch(h.calls(), /INSTALL-GUI/);
});

test('non-Darwin running app quits gracefully and relaunches via start-gui.sh', (t) => {
  const h = harness(t, { app: false, bundle: true, running: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /✓ 데스크톱 앱/);
  assert.equal(h.relaunched(), 'relaunched');
  assert.match(h.calls(), /QUIT-GUI/);
  assert.match(h.calls(), /INSTALL-GUI --apply/);
  assert.match(h.calls(), /START-GUI/);
  assert.ok(h.calls().indexOf('QUIT-GUI') < h.calls().indexOf('INSTALL-GUI'), h.calls());
  assert.ok(h.calls().indexOf('INSTALL-GUI') < h.calls().indexOf('START-GUI'), h.calls());
  assert.doesNotMatch(h.calls(), /tell application/);
});

test('non-Darwin quit failure does not relaunch', (t) => {
  const h = harness(t, { app: false, bundle: true, running: true, quitFail: true });
  const result = h.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /데스크톱 앱에 종료를 요청하지 못했습니다\. 옛 코드가 그대로입니다/);
  assert.equal(h.relaunched(), undefined);
});

test('Darwin without .app still skips even if the desktop build exists', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: false, bundle: true, running: false });
  const result = h.run();
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stdout, /데스크톱 앱이 없어요/);
  assert.doesNotMatch(h.calls(), /INSTALL-GUI/);
});

test('Darwin running app still quits with osascript, not the Windows helper', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, bundle: false, running: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /✓ 데스크톱 앱/);
  assert.equal(h.relaunched(), 'relaunched');
  assert.match(h.calls(), /tell application "Rubato" to quit/);
  assert.doesNotMatch(h.calls(), /QUIT-GUI/);
});

test('GUI update reopens an app the user closed during the update', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: false });
  const result = h.run({ RUBATO_GUI_UPDATE_RELAUNCH: '1', RUBATO_GUI_UPDATE_NODE: process.execPath });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(h.calls(), /tell application/);
  assert.match(h.calls(), /INSTALL-GUI --apply/);
  // The detached launcher may still be starting at shell exit; its success
  // is deliberately not reported as a loaded window by restart-gui.sh.
  assert.match(result.stdout, /창 준비는 GUI 업데이터가 확인/);
});

// `rubato restart`, `rubato update` and the app's own update and restart all quit,
// rebuild and reopen the app here. Two at once would write the same bundle.
test('a second restart does not touch the app while one holds it', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true });
  const lock = join(h.home, '.rubato-pi', 'gui-update', 'app.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  const result = h.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /다른 재시작이나 업데이트가 데스크톱 앱을 다루는 중/);
  assert.equal(h.calls(), '');
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(process.pid));
});

test('a lock left by a dead restart is taken over, and released at the end', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true });
  const lock = join(h.home, '.rubato-pi', 'gui-update', 'app.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), '99999999\n');
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(h.relaunched(), 'relaunched');
  assert.equal(existsSync(lock), false);
});

// About's restart runs under the app it replaces. Without -a macOS pgrep did not
// see it, so the app was not quit and a second one was opened over it.
test('a restart pressed in the app still finds the app and quits it first', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true, descendant: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(h.calls(), /tell application "Rubato" to quit/);
  assert.ok(h.calls().indexOf('tell application') < h.calls().indexOf('START-GUI'), h.calls());
});

// The app is down while the bundle is rebuilt, and a Dock click in that window
// opened a second app next to the one the restart then launched. The later app's
// desktop login replaced the earlier one's, which then asked to pair.
test('an app opened during the rebuild is quit before the new one starts', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true, openDuringBuild: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = h.calls();
  assert.equal(calls.match(/tell application "Rubato" to quit/g)?.length, 2, calls);
  assert.ok(calls.indexOf('INSTALL-GUI') < calls.lastIndexOf('tell application'), calls);
  assert.ok(calls.lastIndexOf('tell application') < calls.indexOf('START-GUI'), calls);
  assert.match(result.stdout, /번들을 맞추는 사이 열린 앱이 있어요/);
});

test('an app opened during the rebuild that will not quit gets no second app', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true, openDuringBuild: true, quitOnce: true });
  const result = h.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /새 앱을 켜지 않았습니다/);
  assert.equal(h.relaunched(), undefined);
});

// /Applications and the app belong to the account. From a temporary HOME (a test,
// a sandbox) the default must not reach them; a named RUBATO_GUI_APP still does.
test('from another HOME the account\'s app is left alone', (t) => {
  const h = harness(t, { hostOs: 'Darwin', app: true, running: true });
  const result = h.run({}, ['RUBATO_GUI_APP']);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stdout, /데스크톱 앱을 건드리지 않아요/);
  assert.equal(h.calls(), '');
});

test('restart-gui keeps Darwin Electron pattern and has no force-quit happy path', () => {
  assert.match(restartSrc, /Rubato\\\\.app\/Contents\/MacOS\/Electron/);
  assert.match(restartSrc, /tell application "Rubato" to quit/);
  assert.match(restartSrc, /tell application id "app.rubato.t3" to quit/);
  assert.doesNotMatch(restartSrc, /killall|pkill|kill -9|taskkill \/T/);
  const guiCode = restartSrc.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(guiCode, /kill/);
  assert.match(restartSrc, /CloseMainWindow/);
  assert.match(restartSrc, /dist-electron\/main\.cjs/);
});
