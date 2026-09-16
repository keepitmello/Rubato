import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installGui = fileURLToPath(new URL('../install-gui.sh', import.meta.url));
const startGui = fileURLToPath(new URL('../start-gui.sh', import.meta.url));
const src = readFileSync(installGui, 'utf8');
const startSrc = readFileSync(startGui, 'utf8');

function plan(hostOs) {
  return spawnSync('bash', [installGui], {
    encoding: 'utf8',
    env: { ...process.env, RUBATO_HOST_OS: hostOs },
  });
}

test('Darwin plan still creates /Applications/Rubato.app', () => {
  const result = plan('Darwin');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/Applications\/Rubato\.app/);
  assert.doesNotMatch(result.stdout, /start-gui\.sh \(T3 electron\)/);
});

test('non-Darwin plan builds desktop without a macOS app bundle', () => {
  for (const host of ['Linux', 'MINGW64_NT-10.0-19045']) {
    const result = plan(host);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\/Applications\/Rubato\.app/);
    assert.doesNotMatch(result.stdout, /install-macos-app/);
    assert.match(result.stdout, /start-gui\.sh \(T3 electron\)/);
  }
});

test('install-macos-app.sh is invoked only inside the Darwin apply branch', () => {
  assert.match(src, /is_darwin\(\) \{ \[ "\$HOST_OS" = Darwin \]; \}/);
  const apply = src.slice(src.indexOf('mkdir -p "$(dirname "$T3_DIR")"'));
  const calls = [...apply.matchAll(/install-macos-app\.sh/g)];
  assert.equal(calls.length, 2, apply);
  assert.match(apply, /if is_darwin; then[\s\S]*install-macos-app\.sh[\s\S]*fi\n\nif \[ "\$built" = 1 \]/);
  const afterDarwin = apply.slice(apply.lastIndexOf('if [ "$built" = 1 ]; then'));
  assert.doesNotMatch(afterDarwin, /install-macos-app/);
  assert.match(afterDarwin, /start-gui\.sh/);
});

test('non-Darwin finish does not run install-macos-app.sh and still reports a launch path', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'macos-called');
  writeFileSync(path.join(root, 'install-macos-app.sh'), `#!/bin/bash\nprintf 'called' > '${marker}'\nprintf '%s\\n' '${path.join(root, 'Rubato.app')}'\n`);
  chmodSync(path.join(root, 'install-macos-app.sh'), 0o755);
  const finish = src.slice(src.indexOf('# 맥 앱 번들은'));
  const wrapper = [
    'set -uo pipefail',
    `HOST_OS=MINGW64_NT-10.0-19045`,
    'is_darwin() { [ "$HOST_OS" = Darwin ]; }',
    `HERE='${root}'`,
    'built=1',
    'ok() { printf "ok %s\\n" "$1"; }',
    'err() { printf "err %s\\n" "$1" >&2; }',
    finish,
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /start-gui\.sh/);
  let called = 'missing';
  try { called = readFileSync(marker, 'utf8'); } catch { called = 'missing'; }
  assert.equal(called, 'missing');
});

test('Darwin finish still creates/links the app bundle via install-macos-app.sh', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-darwin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Rubato.app');
  mkdirSync(bundle);
  const marker = path.join(root, 'macos-called');
  writeFileSync(path.join(root, 'install-macos-app.sh'), `#!/bin/bash\nprintf 'called' > '${marker}'\nprintf '%s\\n' '${bundle}'\n`);
  chmodSync(path.join(root, 'install-macos-app.sh'), 0o755);
  const finish = src.slice(src.indexOf('# 맥 앱 번들은'));
  const wrapper = [
    'set -uo pipefail',
    'HOST_OS=Darwin',
    'is_darwin() { [ "$HOST_OS" = Darwin ]; }',
    `HERE='${root}'`,
    'built=1',
    'ok() { printf "ok %s\\n" "$1"; }',
    'err() { printf "err %s\\n" "$1" >&2; }',
    finish,
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /응용 프로그램:/);
  assert.match(result.stdout, /더블클릭으로 켠다/);
  assert.equal(readFileSync(marker, 'utf8'), 'called');
});

test('start-gui still execs T3 electron and only uses osascript on Darwin', () => {
  assert.match(startSrc, /exec "\$NODE" scripts\/start-electron\.mjs/);
  assert.match(startSrc, /\[ "\$\(uname -s\)" = Darwin \]/);
});
