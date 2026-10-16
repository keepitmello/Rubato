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
const macAppSrc = readFileSync(fileURLToPath(new URL('../install-macos-app.sh', import.meta.url)), 'utf8');

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
  assert.match(startSrc, /if \[ ! -t 2 \] && \[ "\$HOST_OS" = Darwin \]; then\n\s+"\$OSASCRIPT_BIN"/);
});

// A launch from a half-installed tree made "T3 Code (Alpha).app" next to the
// Rubato bundle and registered it as com.t3tools.t3code. The next install
// removes it, so Spotlight and Open With no longer offer a T3 app.
test('install-macos-app removes other app bundles from the runtime directory', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-macos-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.electron-runtime');
  const bundle = path.join(runtime, 'Rubato.app');
  const alpha = path.join(runtime, 'T3 Code (Alpha).app');
  for (const dir of [bundle, alpha]) mkdirSync(path.join(dir, 'Contents'), { recursive: true });
  writeFileSync(path.join(runtime, 'metadata.json'), '{}\n');
  const log = path.join(root, 'lsregister');
  writeFileSync(log, '');
  const lsregister = path.join(root, 'fake-lsregister');
  writeFileSync(lsregister, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(lsregister, 0o755);
  const start = macAppSrc.indexOf('# 런타임 디렉터리의 앱은 이 번들 하나다.');
  const step = macAppSrc.slice(start, macAppSrc.indexOf('\ndone\n', start) + 6);
  assert.ok(start > 0 && step.includes('rm -rf'), step);
  const result = spawnSync('bash', ['-c', ['set -euo pipefail', `BUNDLE='${bundle}'`, step].join('\n')],
    { encoding: 'utf8', env: { ...process.env, RUBATO_LSREGISTER: lsregister } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(runtime).sort(), ['Rubato.app', 'metadata.json']);
  assert.equal(readFileSync(log, 'utf8'), `-u ${alpha}\n`);
});

// 맥에서는 이 기계의 네이티브 바이너리만 받는다. 윈도우·리눅스는 upstream 의
// supportedArchitectures 를 그대로 따른다(윈도우는 WSL 이 리눅스 것을 쓴다).
//
// 받는 도구는 기계마다 다르다. tools 는 PATH 에 둘 가짜 도구와 그 성질이다:
//   ok          무엇이든 받는다
//   fail        언제나 실패한다 (서명 키가 낡은 corepack 같은 것)
//   rejectArch  --cpu/--os 를 거절한다 (전역 vp 0.3.x 가 실제로 그랬다)
// 받기에 성공하면 T3 의 devDependency 처럼 node_modules/.bin/vp 가 생긴다.
function installCalls(hostOs, tools, { staged = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-deps-'));
  try {
    const bin = path.join(root, 'bin');
    const t3 = path.join(root, 't3');
    mkdirSync(bin);
    mkdirSync(t3);
    writeFileSync(path.join(t3, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    if (staged) {
      mkdirSync(path.join(t3, 'apps/server/scripts'), { recursive: true });
      writeFileSync(path.join(t3, 'apps/server/scripts/cli.ts'), 'process.env.RUBATO_T3_OUT_SUFFIX\n');
    }
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
      `staged_build() { echo 'staged_build' >> '${log}'; ${staged === 'fail' ? 'return 1' : 'return 0'}; }`,
      `swap_staged() { echo 'swap_staged' >> '${log}'; }`,
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
const purge = '--config.confirm-modules-purge=false';

test('Darwin installs T3 dependencies for this machine only', () => {
  const run = installCalls('Darwin', { corepack: 'ok' });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.calls[0], `corepack pnpm install ${purge} ${arch}`);
});

test('non-Darwin installs keep upstream supportedArchitectures', () => {
  for (const host of ['Linux', 'MINGW64_NT-10.0-19045']) {
    const run = installCalls(host, { vp: 'ok' });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls[0], `vp i -- ${purge}`);
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
  assert.deepEqual(run.calls.slice(0, 2), [`vp i -- ${purge} ${arch}`, `vp i -- ${purge}`]);
  assert.match(run.output, /모든 아키텍처로 다시 받는다/);
  assert.equal(run.calls.at(-1), 'local-vp run --filter @t3tools/desktop --filter t3 build');
});

test('a broken corepack falls through to the next tool', () => {
  const run = installCalls('Darwin', { corepack: 'fail', vp: 'ok' });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.calls.slice(0, 2), [`corepack pnpm install ${purge} ${arch}`, `vp i -- ${purge} ${arch}`]);
});

// A pin that changes pnpm's hoist settings (v0.0.45 -> v0.1.0) makes pnpm want to
// remove node_modules first. Without a terminal it asks nobody and aborts with
// ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, so the app's update button could never
// get past the dependency install. Every attempt, with every tool, says not to ask.
test('no dependency install stops to ask before replacing node_modules', () => {
  const run = installCalls('Darwin', { corepack: 'fail', vp: 'rejectArch', pnpm: 'fail' });
  const installs = run.calls.filter((line) => / (install|i)( |$)/.test(line));
  assert.ok(installs.length >= 4, run.calls.join('\n'));
  for (const line of installs) assert.ok(line.includes(purge), line);
});

// Building in place left a mix when the build stopped part way: a new web and a
// half-written server beside the old desktop main, which is what the old bundle then
// opened. With the staged-build edit in the tree, it builds beside and swaps whole.
test('a build with the app closed still builds beside the live outputs and swaps them in whole', () => {
  const run = installCalls('Darwin', { corepack: 'ok' }, { staged: 'ok' });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.calls.slice(-2), ['staged_build', 'swap_staged']);
  assert.ok(!run.calls.some((line) => line.includes(' build')), run.calls.join('\n'));
});

test('a failed staged build swaps nothing in and fails', () => {
  const run = installCalls('Darwin', { corepack: 'ok' }, { staged: 'fail' });
  assert.notEqual(run.status, 0);
  assert.equal(run.calls.at(-1), 'staged_build');
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

// --prepare builds the three outputs beside the ones the open app reads, by
// running T3's build steps itself. If T3 changes those steps, the staged bundle
// would differ from what `vp run ... build` makes, so the steps are pinned here.
test('the staged build runs the same steps as T3\'s desktop build', { skip: !process.env.T3_SOURCE }, () => {
  const t3 = process.env.T3_SOURCE;
  assert.equal(JSON.parse(readFileSync(path.join(t3, 'apps/web/package.json'), 'utf8')).scripts.build, 'vp build');
  const server = readFileSync(path.join(t3, 'apps/server/vite.config.ts'), 'utf8');
  assert.match(server, /build: \{\n\s+command: "node scripts\/cli\.ts build",\n\s+dependsOn: \["@t3tools\/web#build"\]/);
  const desktop = readFileSync(path.join(t3, 'apps/desktop/vite.config.ts'), 'utf8');
  assert.match(desktop, /build: \{\n\s+command:\n\s+"node scripts\/build-browser-secret\.mjs && node scripts\/build-preview-annotation-css\.mjs && vp pack",\n\s+dependsOn: \["t3#build"\]/);
  const staged = src.slice(src.indexOf('staged_build() {'), src.indexOf('staged_complete() {'));
  for (const step of ['"$vp" build --outDir "dist$STAGE_SUFFIX"', 'RUBATO_T3_OUT_SUFFIX="$STAGE_SUFFIX" "$NODE" scripts/cli.ts build',
    '"$NODE" scripts/build-browser-secret.mjs', '"$NODE" scripts/build-preview-annotation-css.mjs', '"$vp" pack --out-dir "dist-electron$STAGE_SUFFIX"'])
    assert.ok(staged.includes(step), step);
});

function slice(start, end) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return src.slice(from, to);
}
const helpers = () => slice('staged_complete() {', 'runtime_fingerprint() {');

function outputs(root, suffix, label) {
  for (const [dir, file] of [['apps/web/dist', 'index.html'], ['apps/server/dist', 'bin.mjs'],
    ['apps/server/dist', 'client/index.html'], ['apps/desktop/dist-electron', 'main.cjs']]) {
    mkdirSync(path.dirname(path.join(root, dir + suffix, file)), { recursive: true });
    writeFileSync(path.join(root, dir + suffix, file), label);
  }
}

function runShell(lines) {
  return spawnSync('bash', ['-c', ['set -uo pipefail', ...lines].join('\n')], { encoding: 'utf8' });
}

test('a staged bundle is swapped in whole, and the old one goes', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-swap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  outputs(root, '', 'old');
  outputs(root, '.rubato-next', 'new');
  writeFileSync(path.join(root, '.rubato-gui-staged'), 'fp\n');
  const result = runShell([`T3_DIR='${root}'`, 'STAGE_SUFFIX=.rubato-next', `STAGED_STAMP='${root}/.rubato-gui-staged'`,
    'OUTPUT_DIRS="apps/web/dist apps/server/dist apps/desktop/dist-electron"', helpers(), 'swap_staged']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(root, 'apps/server/dist/bin.mjs'), 'utf8'), 'new');
  assert.equal(readFileSync(path.join(root, 'apps/desktop/dist-electron/main.cjs'), 'utf8'), 'new');
  assert.equal(readFileSync(path.join(root, 'apps/web/dist/index.html'), 'utf8'), 'new');
  // The old bundle is removed in the background.
  for (let tries = 0; tries < 50 && readdirSync(path.join(root, 'apps/server')).length > 1; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(readdirSync(path.join(root, 'apps/server')), ['dist']);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.rubato')), []);
});

test('a staged bundle that cannot be swapped whole leaves the live one as it was', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-swap-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  outputs(root, '', 'old');
  outputs(root, '.rubato-next', 'new');
  // The last output cannot move into place after the first two did.
  const result = runShell([`T3_DIR='${root}'`, 'STAGE_SUFFIX=.rubato-next', `STAGED_STAMP='${root}/.rubato-gui-staged'`,
    'OUTPUT_DIRS="apps/web/dist apps/server/dist apps/desktop/dist-electron"', helpers(),
    // A mv that refuses the desktop output, the way a busy or read-only directory would.
    'mv() { case "$1" in apps/desktop/dist-electron.rubato-next) return 1 ;; esac; command mv "$@"; }',
    'swap_staged']);
  assert.equal(result.status, 1, result.stderr);
  for (const file of ['apps/web/dist/index.html', 'apps/server/dist/bin.mjs', 'apps/desktop/dist-electron/main.cjs'])
    assert.equal(readFileSync(path.join(root, file), 'utf8'), 'old', file);
  for (const file of ['apps/web/dist.rubato-next/index.html', 'apps/server/dist.rubato-next/bin.mjs', 'apps/desktop/dist-electron.rubato-next/main.cjs'])
    assert.equal(readFileSync(path.join(root, file), 'utf8'), 'new', file);
});

// Exit codes restart-gui.sh reads: 0 current, 10 staged, 11 dependencies changed, 1 failed.
function prepareRun(t, { stamp = 'old', staged = '', complete = false, deps = true, build = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'main.cjs'), '');
  writeFileSync(path.join(root, 'stamp'), `${stamp}\n`);
  if (staged) writeFileSync(path.join(root, 'staged'), `${staged}\n`);
  const block = slice('if [ "$PREPARE" = 1 ]; then', '\nbuilt=0');
  const result = runShell([
    'PREPARE=1', 'WANT=new', 'DIM=; RST=', `BUNDLE='${root}/main.cjs'`, `STAMP='${root}/stamp'`, `STAGED_STAMP='${root}/staged'`,
    'ok() { echo "ok $1"; }', 'say() { echo "say $1"; }', 'err() { echo "err $1"; }', 'record_deps_stamp() { :; }',
    `staged_complete() { ${complete ? 'true' : 'false'}; }`, `deps_current() { ${deps ? 'true' : 'false'}; }`,
    `staged_build() { echo BUILD; ${build ? 'true' : 'false'}; }`,
    block, 'echo fell-through']);
  let stagedStamp = null;
  try { stagedStamp = readFileSync(path.join(root, 'staged'), 'utf8').trim(); } catch {}
  return { status: result.status, out: result.stdout, stagedStamp };
}

test('--prepare says what the restart has to do once the app is closed', (t) => {
  const current = prepareRun(t, { stamp: 'new' });
  assert.equal(current.status, 0);
  assert.doesNotMatch(current.out, /BUILD/);
  const already = prepareRun(t, { staged: 'new', complete: true });
  assert.equal(already.status, 10);
  assert.doesNotMatch(already.out, /BUILD/);
  const deps = prepareRun(t, { deps: false });
  assert.equal(deps.status, 11);
  assert.doesNotMatch(deps.out, /BUILD/);
  const built = prepareRun(t, { staged: 'older' });
  assert.equal(built.status, 10);
  assert.match(built.out, /BUILD/);
  assert.equal(built.stagedStamp, 'new');
  const failed = prepareRun(t, { build: false });
  assert.equal(failed.status, 1);
  assert.equal(failed.stagedStamp, null);
});

// The runtime bundle (a 290MB Electron copy, signed) was emptied on every build and
// rebuilt on the next launch. Only a new icon, name or bundle id needs that.
test('the app runtime bundle is emptied only when its icon, name or bundle id inputs change', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const here = path.join(root, 'here');
  const t3 = path.join(root, 't3');
  mkdirSync(path.join(here, 'assets'), { recursive: true });
  mkdirSync(path.join(t3, 'apps/desktop/scripts'), { recursive: true });
  for (const file of ['assets/Rubato.png', 'assets/Rubato.icns']) writeFileSync(path.join(here, file), file);
  writeFileSync(path.join(t3, 'apps/desktop/scripts/electron-launcher.mjs'), 'const APP_DISPLAY_NAME = "Rubato";');
  writeFileSync(path.join(t3, 'apps/desktop/package.json'), '{}');
  const runtime = path.join(t3, 'apps/desktop/.electron-runtime');
  const run = (built = 1) => runShell([`HERE='${here}'`, `T3_DIR='${t3}'`, `RUNTIME_STAMP='${t3}/.rubato-gui-runtime'`, `built=${built}`,
    slice('runtime_fingerprint() {', '\n}\n') + '\n}',
    slice('RUNTIME_WANT="$(runtime_fingerprint)"', '\n# 맥 앱 번들은')]);
  mkdirSync(runtime);
  assert.equal(run().status, 0);
  assert.equal(readdirSync(path.join(t3, 'apps/desktop')).includes('.electron-runtime'), false, 'a first install starts fresh');
  mkdirSync(runtime);
  assert.equal(run().status, 0);
  assert.equal(readdirSync(path.join(t3, 'apps/desktop')).includes('.electron-runtime'), true, 'nothing changed');
  writeFileSync(path.join(t3, 'apps/desktop/scripts/electron-launcher.mjs'), 'const APP_DISPLAY_NAME = "Rubato 2";');
  assert.equal(run().status, 0);
  assert.equal(readdirSync(path.join(t3, 'apps/desktop')).includes('.electron-runtime'), false, 'the name changed');
  // A failed build keeps the old bundle: it is the only way the app still opens, and
  // emptying it before the next launch remade it left /Applications/Rubato.app dangling.
  mkdirSync(runtime);
  writeFileSync(path.join(t3, 'apps/desktop/scripts/electron-launcher.mjs'), 'const APP_DISPLAY_NAME = "Rubato 3";');
  assert.equal(run(0).status, 0);
  assert.equal(readdirSync(path.join(t3, 'apps/desktop')).includes('.electron-runtime'), true, 'the build failed');
  assert.equal(run(1).status, 0);
  assert.equal(readdirSync(path.join(t3, 'apps/desktop')).includes('.electron-runtime'), false, 'the next good build still renews it');
});

test('the copied launcher icon keeps the repository icon\'s time, so the runtime bundle is not remade', () => {
  assert.match(src, /cp "\$HERE\/assets\/Rubato\.png" "\$T3_DIR\/\$target" && touch -r "\$HERE\/assets\/Rubato\.png" "\$T3_DIR\/\$target"/);
});

test('install-macos-app signs the runtime bundle only when it changed', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-macos-sign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, '.electron-runtime', 'Rubato.app');
  mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  writeFileSync(path.join(root, '.electron-runtime', 'metadata.json'), '{"v":1}\n');
  const log = path.join(root, 'signed');
  writeFileSync(log, '');
  writeFileSync(path.join(root, 'mac-signing.sh'), `printf 'sign\\n' >> '${log}'\n`);
  const step = macAppSrc.slice(macAppSrc.indexOf('ENTRY="$BUNDLE/Contents/Resources/app"'), macAppSrc.indexOf('# /Applications 이름은'));
  const run = () => runShell([`BUNDLE='${bundle}'`, `HERE='${root}'`, 'HOME_LINE=""', step]);
  for (let index = 0; index < 2; index += 1) assert.equal(run().status, 0);
  assert.equal(readFileSync(log, 'utf8'), 'sign\n', 'unchanged: signed once');
  writeFileSync(path.join(root, '.electron-runtime', 'metadata.json'), '{"v":2}\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(log, 'utf8'), 'sign\nsign\n', 'the launcher remade the bundle');
});

// After a prepare under the same lock, the install that runs with the app closed
// goes straight to the bundle: the pin checkout and overlay are already in place.
test('an install right after a prepare does not set up the sources again', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-install-gui-prepared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const t3 = path.join(root, 't3');
  mkdirSync(path.join(t3, 'apps/desktop/dist-electron'), { recursive: true });
  writeFileSync(path.join(t3, 'apps/desktop/dist-electron/main.cjs'), '');
  const fingerprint = src.slice(src.indexOf('build_fingerprint() {'), src.indexOf('\n}\n', src.indexOf('build_fingerprint() {')) + 3);
  const here = path.dirname(installGui);
  const pin = JSON.parse(readFileSync(path.join(here, 'upstream.json'), 'utf8')).upstreamCommit;
  const want = spawnSync('bash', ['-c', [`HERE='${here}'`, `PIN='${pin}'`, fingerprint, 'build_fingerprint'].join('\n')], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(t3, '.rubato-gui-build'), `${want}\n`);
  const result = spawnSync('bash', [installGui, '--apply'], { encoding: 'utf8', env: { ...process.env,
    RUBATO_GUI_PREPARED: '1', RUBATO_HOST_OS: 'Linux', RUBATO_T3_SOURCE: t3, RUBATO_T3_HOME: path.join(root, 'home') } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /데스크톱은 이미 이 핀에 맞다/);
  assert.doesNotMatch(result.stdout, /Rubato overlay|T3 [0-9a-f]{40}/);
});
