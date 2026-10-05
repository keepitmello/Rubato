import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const startGui = fileURLToPath(new URL('../start-gui.sh', import.meta.url));
const LAUNCHER = 'apps/desktop/scripts/electron-launcher.mjs';
const RUBATO_LAUNCHER = 'const APP_DISPLAY_NAME = "Rubato";\n';
const T3_LAUNCHER = 'const APP_DISPLAY_NAME = "T3 Code (Alpha)";\n';

// A T3 tree as install-gui.sh leaves it: built desktop, overlay manifest, and
// the Rubato bundle install-macos-app.sh made. The T3 launcher and the bundle's
// Electron are fakes that only record how they were started.
function tree(t, { launcher = RUBATO_LAUNCHER, bundle = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-start-gui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const t3 = path.join(root, 't3-source');
  const desktop = path.join(t3, 'apps/desktop');
  const log = path.join(root, 'started');
  mkdirSync(path.join(desktop, 'dist-electron'), { recursive: true });
  mkdirSync(path.join(desktop, 'scripts'), { recursive: true });
  writeFileSync(path.join(desktop, 'dist-electron/main.cjs'), '// built\n');
  writeFileSync(path.join(t3, LAUNCHER), launcher);
  writeFileSync(path.join(desktop, 'scripts/start-electron.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, 'T3 launcher');\n`);
  writeFileSync(path.join(t3, '.rubato-pi-overlay.json'), JSON.stringify({ version: 1, files: {
    [LAUNCHER]: { original: T3_LAUNCHER, installedHash: createHash('sha256').update(RUBATO_LAUNCHER).digest('hex') },
  } }));
  if (bundle) {
    const macos = path.join(desktop, '.electron-runtime/Rubato.app/Contents/MacOS');
    mkdirSync(macos, { recursive: true });
    writeFileSync(path.join(macos, 'Electron'),
      `#!/bin/sh\nprintf 'Rubato.app %s in %s run-as-node=%s' "$*" "$PWD" "\${ELECTRON_RUN_AS_NODE-unset}" > '${log}'\n`);
    chmodSync(path.join(macos, 'Electron'), 0o755);
  }
  return {
    desktop,
    run(hostOs = 'Darwin', extraEnv = {}) {
      // A test run from an agent shell must not look like an agent restarting its own app.
      const { PI_SESSION_ID: _agent, RUBATO_ALLOW_AGENT_GUI_RESTART: _allow, ...cleanEnv } = process.env;
      const result = spawnSync('bash', [startGui], { encoding: 'utf8', env: {
        ...cleanEnv,
        HOME: root,
        RUBATO_NODE: process.execPath,
        RUBATO_T3_SOURCE: t3,
        RUBATO_T3_HOME: path.join(root, 't3-home'),
        RUBATO_HOST_OS: hostOs,
        RUBATO_OSASCRIPT_BIN: '/usr/bin/true',
        ELECTRON_RUN_AS_NODE: '1',
        ...extraEnv,
      } });
      let started;
      try { started = readFileSync(log, 'utf8'); } catch { started = undefined; }
      return { ...result, started };
    },
  };
}

test('an installed tree starts through the T3 launcher as before', (t) => {
  const result = tree(t).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.started, 'T3 launcher');
});

// install-gui.sh checks the pin out before the overlay. When the overlay failed
// the launcher was T3's, and a GUI update reopened the app as "T3 Code (Alpha)".
test('a tree the install left at the bare pin opens the last Rubato bundle instead', (t) => {
  const h = tree(t, { launcher: T3_LAUNCHER });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  // Same binary, argument and directory the launcher gives a healthy tree.
  assert.equal(result.started, `Rubato.app dist-electron/main.cjs in ${h.desktop} run-as-node=unset`);
  assert.match(result.stderr, /마지막 Rubato 번들로 켠다/);
});

test('a half-installed tree without a Rubato bundle opens nothing', (t) => {
  const result = tree(t, { launcher: T3_LAUNCHER, bundle: false }).run();
  assert.equal(result.status, 1);
  assert.equal(result.started, undefined);
  assert.match(result.stderr, /install\.sh --apply --gui/);
});

// Off macOS the launcher makes no bundle; the name comes from the built main.cjs.
test('off macOS the launcher still starts whatever the tree holds', (t) => {
  const result = tree(t, { launcher: T3_LAUNCHER }).run('Linux');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.started, 'T3 launcher');
});

// start-gui.sh is what an agent called twice during the 2026-10-06 incident.
test('an agent session cannot launch the app directly', (t) => {
  const result = tree(t, { launcher: T3_LAUNCHER }).run('Linux', { PI_SESSION_ID: 'agent-session' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /에이전트 세션에서는 데스크톱 앱을 직접 껐다 켜지 않습니다/);
  assert.equal(result.started, undefined);
});

test('an allowed launch does not hand the agent session id to the app', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-start-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'env');
  const t3run = tree(t, { launcher: T3_LAUNCHER });
  writeFileSync(path.join(t3run.desktop, 'scripts/start-electron.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, String(process.env.PI_SESSION_ID));\n`);
  const result = t3run.run('Linux', { PI_SESSION_ID: 'agent-session', RUBATO_ALLOW_AGENT_GUI_RESTART: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'undefined');
});
