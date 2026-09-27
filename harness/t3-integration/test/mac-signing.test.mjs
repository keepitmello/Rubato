import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mac-signing.sh');

// Fakes with the macOS 26 rule that broke signing: codesign finds the identity only when the
// dedicated keychain is on the user search list, even with --keychain.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-signing-'));
  const signDir = path.join(dir, 'signing');
  mkdirSync(signDir);
  const keychain = path.join(signDir, 'rubato-signing.keychain-db');
  writeFileSync(keychain, '');
  writeFileSync(path.join(signDir, 'keychain-password'), 'pw');
  const list = path.join(dir, 'search-list');
  writeFileSync(list, '"/login.keychain-db"\n');
  const log = path.join(dir, 'codesign.log');
  const security = path.join(dir, 'security');
  writeFileSync(security, `#!/bin/bash
case "$1" in
  find-identity) echo '  1) ABC "Rubato Local Signing"' ;;
  unlock-keychain) ;;
  list-keychains)
    if [ "$4" = "-s" ]; then shift 4; : > "${list}"; for k in "$@"; do printf '    "%s"\\n' "$k" >> "${list}"; done
    else cat "${list}"; fi ;;
esac
`);
  const codesign = path.join(dir, 'codesign');
  writeFileSync(codesign, `#!/bin/bash
if [[ " $* " == *" --sign - "* ]]; then echo adhoc >> "${log}"; exit 0; fi
if grep -q "${keychain}" "${list}"; then echo identity >> "${log}"; exit 0; fi
echo "Rubato Local Signing: no identity found" >&2; exit 1
`);
  chmodSync(security, 0o755); chmodSync(codesign, 0o755);
  const bundle = path.join(dir, 'Rubato.app'); mkdirSync(bundle);
  return { dir, signDir, list, log, security, codesign, bundle };
}

test('signs with the local certificate and leaves the keychain search list as it was', () => {
  const f = fixture();
  const run = spawnSync('bash', [script, 'sign', f.bundle], { encoding: 'utf8',
    env: { ...process.env, RUBATO_SIGNING_DIR: f.signDir, RUBATO_SECURITY_BIN: f.security, RUBATO_CODESIGN_BIN: f.codesign } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(f.log, 'utf8'), 'identity\n');
  assert.doesNotMatch(run.stderr, /애드혹/);
  assert.equal(readFileSync(f.list, 'utf8'), '    "/login.keychain-db"\n');
});
