import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  executable(fakePgrep, `#!/bin/sh\nif [ "$(cat '${guiState}')" = running ]; then exit 0; else exit 1; fi\n`);
  const fakeOsascript = join(root, 'fake-osascript');
  executable(
    fakeOsascript,
    '#!/bin/sh\n' +
      `printf '%s\\n' "$*" >> '${log}'\n` +
      (quitFail ? 'exit 1\n' : quitHang ? 'exit 0\n' : `printf 'stopped' > '${guiState}'\nexit 0\n`),
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
  executable(fakeInstall, `#!/bin/sh\nprintf 'INSTALL-GUI %s\\n' "$*" >> '${log}'\nexit 0\n`);
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
    run(extraEnv = {}) {
      return spawnSync('sh', [restartGui], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' });
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
