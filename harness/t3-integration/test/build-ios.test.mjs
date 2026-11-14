import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildIos = fileURLToPath(new URL('../mobile/build-ios.sh', import.meta.url));
const pin = JSON.parse(readFileSync(fileURLToPath(new URL('../upstream.json', import.meta.url)), 'utf8')).upstreamCommit;

// Runs build-ios.sh --simulator against a fake T3 tree with stub tools on PATH. The stub
// xcodebuild writes a Rubato.app into the derived data, or fails when STUB_XCODEBUILD_FAIL=1.
function run(t, { fail = false } = {}) {
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
    + '<plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string></dict></plist>\n');
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
  stub('corepack', '[ "$2" = install ] && mkdir -p node_modules; exit 0');
  stub('sips', 'exit 0');
  stub('pod', 'mkdir -p Pods && echo pod > Pods/LiveKitWebRTC');
  stub('xcrun', 'exit 0');
  stub('xcodebuild', `[ "\${STUB_XCODEBUILD_FAIL:-}" = 1 ] && { echo 'BUILD FAILED'; exit 65; }
while [ $# -gt 0 ]; do [ "$1" = -derivedDataPath ] && dd="$2"; shift; done
mkdir -p "$dd/Build/Products/Release-iphonesimulator/Rubato.app" "$dd/Build/Intermediates.noindex"
echo app > "$dd/Build/Products/Release-iphonesimulator/Rubato.app/Rubato"`);

  const result = spawnSync('bash', [buildIos, '--simulator'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      RUBATO_T3_MOBILE: mobile,
      RUBATO_MOBILE_WORKTREE: '1',
      STUB_XCODEBUILD_FAIL: fail ? '1' : '',
    },
  });
  return { result, out, ios };
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
