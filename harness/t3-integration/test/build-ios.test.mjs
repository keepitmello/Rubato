import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildIos = fileURLToPath(new URL('../mobile/build-ios.sh', import.meta.url));
const pin = JSON.parse(readFileSync(fileURLToPath(new URL('../upstream.json', import.meta.url)), 'utf8')).upstreamCommit;

// Runs build-ios.sh against a fake T3 tree with stub tools on PATH. The stub xcodebuild writes a
// Rubato.app into the derived data or an archive, records each call in xcodebuild.calls, and fails
// when STUB_XCODEBUILD_FAIL=1.
function run(t, { fail = false, args = ['--simulator'] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-build-ios-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const mobile = path.join(root, 't3-mobile');
  const out = path.join(home, '.rubato/t3-mobile-build');
  const ios = path.join(mobile, 'apps/mobile/ios');
  mkdirSync(path.join(ios, 'Rubato'), { recursive: true });
  writeFileSync(path.join(mobile, '.git'), 'gitdir: elsewhere\n');
  writeFileSync(path.join(mobile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(ios, 'Rubato/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>\n');
  // Left over from an earlier run that died before its own cleanup.
  mkdirSync(path.join(out, 'device'), { recursive: true });
  mkdirSync(path.join(out, 'export-old'), { recursive: true });

  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('git', `[ "$3" = rev-parse ] && [ "$4" = HEAD ] && { echo ${pin}; exit 0; }; exit 0`);
  stub('node', `case "$1" in *apply.mjs) echo '{ "compatible": true }';; *) exec "${process.execPath}" "$@";; esac`);
  // The fingerprint build-ios.sh pins for over-the-air updates comes from expo-updates as JSON, and
  // prebuild writes ios/ again after the script clears it.
  stub('corepack', `[ "$2" = install ] && mkdir -p node_modules
[ "$3" = expo-updates ] && echo '{"hash":"stub"}'
if [ "$3" = expo ] && [ "$4" = prebuild ]; then
  mkdir -p ios/Rubato
  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>' > ios/Rubato/Info.plist
fi
exit 0`);
  stub('sips', 'exit 0');
  stub('pod', 'mkdir -p Pods && echo pod > Pods/LiveKitWebRTC');
  stub('xcrun', 'exit 0');
  stub('xcodebuild', `[ "\${STUB_XCODEBUILD_FAIL:-}" = 1 ] && { echo 'BUILD FAILED'; exit 65; }
echo "$*" >> "${path.join(root, 'xcodebuild.calls')}"
for a in "$@"; do [ "$a" = -exportArchive ] && exit 0; done
while [ $# -gt 0 ]; do
  [ "$1" = -derivedDataPath ] && dd="$2"; [ "$1" = -archivePath ] && ar="$2"; shift
done
mkdir -p "$dd/Build/Products/Release-iphonesimulator/Rubato.app" "$dd/Build/Intermediates.noindex"
echo app > "$dd/Build/Products/Release-iphonesimulator/Rubato.app/Rubato"
if [ -n "\${ar:-}" ]; then
  mkdir -p "$ar/Products/Applications/Rubato.app"
  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ApplicationProperties</key><dict>' \\
    '<key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleVersion</key><string>7</string></dict></dict></plist>' > "$ar/Info.plist"
fi`);
  stub('df', 'printf "%s\\n" "Filesystem 1K-blocks Used Available" "disk 1 1 99999999"');

  const result = spawnSync('bash', [buildIos, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      RUBATO_T3_MOBILE: mobile,
      RUBATO_MOBILE_WORKTREE: '1',
      STUB_XCODEBUILD_FAIL: fail ? '1' : '',
      ASC_KEY_ID: 'KEY', ASC_ISSUER_ID: 'ISSUER', ASC_KEY_PATH: path.join(root, 'key.p8'),
    },
  });
  const callsFile = path.join(root, 'xcodebuild.calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  return { result, out, ios, calls, root };
}

test('a simulator build keeps the app and its log, and no native tree or intermediates', { skip: process.platform !== 'darwin' }, (t) => {
  const { result, out, ios } = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(out, 'Rubato-simulator.app/Rubato')), 'the app survives for simctl install');
  assert.ok(existsSync(path.join(out, 'sim.log')));
  for (const gone of [ios, path.join(out, 'sim'), path.join(out, 'device'), path.join(out, 'export-old')]) {
    assert.ok(!existsSync(gone), `${gone} is removed`);
  }
});

test('a failed build still removes the native tree and intermediates but keeps the log', { skip: process.platform !== 'darwin' }, (t) => {
  const { result, out, ios } = run(t, { fail: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(existsSync(path.join(out, 'sim.log')));
  for (const gone of [ios, path.join(out, 'sim'), path.join(out, 'device'), path.join(out, 'export-old')]) {
    assert.ok(!existsSync(gone), `${gone} is removed`);
  }
});

test('--archive keeps a signed archive and uploads nothing', { skip: process.platform !== 'darwin' }, (t) => {
  const { result, out, ios, calls } = run(t, { args: ['--archive'] });
  assert.equal(result.status, 0, result.stderr);
  const archive = result.stdout.match(/^archive: (.+)$/m)?.[1];
  assert.ok(archive && existsSync(path.join(archive, 'Info.plist')), result.stdout);
  assert.ok(archive.startsWith(out));
  assert.equal(calls.length, 1);
  assert.match(calls[0], / archive$/);
  assert.match(calls[0], /CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION=\d{12} MARKETING_VERSION=1\.0\.0 -allowProvisioningUpdates/);
  assert.ok(!calls.some((call) => call.includes('-exportArchive')), 'no upload');
  for (const gone of [ios, path.join(out, 'device')]) assert.ok(!existsSync(gone), `${gone} is removed`);
});

test('--upload sends an existing archive without building', { skip: process.platform !== 'darwin' }, (t) => {
  const made = run(t, { args: ['--archive'] });
  const archive = made.result.stdout.match(/^archive: (.+)$/m)[1];
  const archiveCopy = path.join(made.root, 'kept.xcarchive');
  spawnSync('ditto', [archive, archiveCopy]);
  const { result, calls } = run(t, { args: ['--upload', archiveCopy] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^-exportArchive -archivePath \S+kept\.xcarchive /);
  assert.match(result.stdout, /^uploaded 1\.0\.0 \(7\)$/m);
});

test('--upload without an archive is a usage error', (t) => {
  const { result, calls } = run(t, { args: ['--upload'] });
  assert.equal(result.status, 2);
  assert.equal(calls.length, 0);
});

// The script is documented and called as ./build-ios.sh, not through bash.
test('the build scripts stay executable', () => {
  for (const script of ['build-ios.sh', 'update-ios.sh']) {
    const mode = statSync(fileURLToPath(new URL(`../mobile/${script}`, import.meta.url))).mode;
    assert.ok(mode & 0o100, `${script} is executable`);
  }
});
