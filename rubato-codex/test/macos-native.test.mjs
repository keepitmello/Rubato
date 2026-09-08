import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyUpstream } from '../scripts/macos-app.mjs';

test('installed launcher retains the official app signature and routes the isolated profile', {
  skip: process.env.RUBATO_MACOS_NATIVE_E2E !== '1',
}, async () => {
  const target = process.env.RUBATO_MACOS_TEST_APP || '/Applications/Rubato.app';
  const receipt = JSON.parse(await readFile(join(target, 'Contents/Resources/rubato-build.json')));
  assert.equal(receipt.mode, 'signed-profile-launcher');
  await verifyUpstream(receipt.upstreamApp);
  const launcher = spawnSync(join(target, 'Contents/MacOS/Rubato'), ['--rubato-print-paths'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(launcher.status, 0, launcher.stderr);
  const paths = JSON.parse(launcher.stdout);
  assert.equal(paths.codexHome, receipt.codexHome);
  assert.equal(paths.upstreamApp, receipt.upstreamApp);
  const signed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  // Launch, window and relaunch evidence are separate manual runtime checks.
});
