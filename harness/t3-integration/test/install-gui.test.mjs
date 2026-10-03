import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// 맥에서는 이 기계의 네이티브 바이너리만 받는다. 윈도우·리눅스는 upstream 의
// supportedArchitectures 를 그대로 따른다(윈도우는 WSL 이 리눅스 것을 쓴다).
//
// 받는 도구는 기계마다 다르다. tools 는 PATH 에 둘 가짜 도구와 그 성질이다:
//   ok          무엇이든 받는다
//   fail        언제나 실패한다 (서명 키가 낡은 corepack 같은 것)
//   rejectArch  --cpu/--os 를 거절한다 (전역 vp 0.3.x 가 실제로 그랬다)
// 받기에 성공하면 T3 의 devDependency 처럼 node_modules/.bin/vp 가 생긴다.
function installCalls(hostOs, tools) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-deps-'));
  try {
    const bin = path.join(root, 'bin');
    const t3 = path.join(root, 't3');
    mkdirSync(bin);
    mkdirSync(t3);
    writeFileSync(path.join(t3, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const log = path.join(root, 'calls');
    writeFileSync(log, '');
    writeFileSync(path.join(bin, 'node'), `#!/bin/bash\nexec '${process.execPath}' "$@"\n`);
    chmodSync(path.join(bin, 'node'), 0o755);
    const localVp = path.join(root, 'local-vp');
    writeFileSync(localVp, `#!/bin/bash\nprintf 'local-vp %s\\n' "$*" >> '${log}'\n`);
    chmodSync(localVp, 0o755);
    for (const [name, mode] of Object.entries(tools)) {
      const script = [
        '#!/bin/bash',
        `printf '${name} %s\\n' "$*" >> '${log}'`,
        mode === 'fail' ? 'exit 1' : '',
        mode === 'rejectArch' ? `case " $* " in *" --cpu="*) echo " ERROR  Unknown options: 'cpu', 'os'" >&2; exit 1;; esac` : '',
        `mkdir -p '${t3}/node_modules/.bin' && cp '${localVp}' '${t3}/node_modules/.bin/vp'`,
      ].join('\n');
      writeFileSync(path.join(bin, name), script + '\n');
      chmodSync(path.join(bin, name), 0o755);
    }
    const start = src.indexOf('build_desktop() {');
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);
    const wrapper = [
      'set -uo pipefail',
      `HOST_OS='${hostOs}'`,
      'is_darwin() { [ "$HOST_OS" = Darwin ]; }',
      `T3_DIR='${t3}'`,
      `NODE='${path.join(bin, 'node')}'`,
      `DEPS_STAMP='${path.join(t3, '.rubato-gui-deps')}'`,
      fn,
      'build_desktop',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    return { status: result.status, output: result.stderr + result.stdout,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const arch = `--cpu=${process.arch} --os=darwin`;

test('Darwin installs T3 dependencies for this machine only', () => {
  const run = installCalls('Darwin', { corepack: 'ok' });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.calls[0], `corepack pnpm install ${arch}`);
});

test('non-Darwin installs keep upstream supportedArchitectures', () => {
  for (const host of ['Linux', 'MINGW64_NT-10.0-19045']) {
    const run = installCalls(host, { vp: 'ok' });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls[0], 'vp i');
  }
});

test('corepack is preferred over a global vp that rejects the arch options', () => {
  const run = installCalls('Darwin', { corepack: 'ok', vp: 'rejectArch' });
  assert.equal(run.status, 0, run.output);
  assert.ok(!run.calls.some((line) => line.startsWith('vp ')), run.calls.join('\n'));
});

test('an old global vp alone still installs, without the arch limit', () => {
  const run = installCalls('Darwin', { vp: 'rejectArch' });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.calls.slice(0, 2), [`vp i -- ${arch}`, 'vp i']);
  assert.match(run.output, /모든 아키텍처로 다시 받는다/);
  assert.equal(run.calls.at(-1), 'local-vp run --filter @t3tools/desktop --filter t3 build');
});

test('a broken corepack falls through to the next tool', () => {
  const run = installCalls('Darwin', { corepack: 'fail', vp: 'ok' });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.calls.slice(0, 2), [`corepack pnpm install ${arch}`, `vp i -- ${arch}`]);
});

test('an install that fails with every tool stops the build', () => {
  const run = installCalls('Darwin', { corepack: 'fail', vp: 'fail' });
  assert.notEqual(run.status, 0);
  assert.ok(!run.calls.some((line) => line.includes(' build')), run.calls.join('\n'));
});

// 웹 아이콘은 upstream 의 같은 이름 파일 자리에 깔린다. upstream 이 이름을 바꾸면
// 복사는 아무도 읽지 않는 새 파일을 만들고 T3 아이콘이 그대로 남는다.
test('every web icon replaces a file the pinned T3 web app already serves', { skip: !process.env.T3_SOURCE }, () => {
  const pin = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8')).upstreamCommit;
  const served = spawnSync('git', ['-C', process.env.T3_SOURCE, 'ls-tree', '--name-only', pin, 'apps/web/public/'], { encoding: 'utf8' });
  assert.equal(served.status, 0, served.stderr);
  const icons = readdirSync(fileURLToPath(new URL('../assets/web', import.meta.url)));
  assert.ok(icons.length > 0);
  for (const icon of icons) assert.ok(served.stdout.split('\n').includes(`apps/web/public/${icon}`), icon);
});
