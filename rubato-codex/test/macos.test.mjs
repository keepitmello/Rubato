import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseInstallTarget, appPaths } from '../scripts/install-target.mjs';
import { parseAppcast, validateDownloadUrl, assertAppTarget, trust, verifyDownload, withAppLock } from '../scripts/macos-app.mjs';
import { readArchive, rewriteArchive } from '../scripts/asar.mjs';
import { parseUpdateArgs } from '../scripts/macos-cli.mjs';
import { parseArgs } from '../scripts/install.mjs';

test('CLI defaults to isolated app even if CODEX_HOME is set; Codex requires explicit selection', async () => {
  assert.equal((await chooseInstallTarget({}, { interactive: false })).target, 'app');
  assert.equal((await chooseInstallTarget({}, { interactive: true, ask: async () => '' })).target, 'app');
  assert.equal((await chooseInstallTarget({}, { interactive: true, ask: async () => '2' })).target, 'codex');
  await assert.rejects(chooseInstallTarget({ codexHome: '/existing' }, { interactive: false }), /requires --target codex/);
  await assert.rejects(chooseInstallTarget({ target: 'typo' }), /app or codex/);
  assert.equal(parseArgs(['install', '--target', 'codex']).options.target, 'codex');
  assert.equal(appPaths({}, '/private-user').codexHome, '/private-user/.rubato/codex');
  assert.equal(appPaths({}, '/private-user').electronHome, '/private-user/Library/Application Support/Rubato/Codex');
});
test('appcast selects full archives by architecture/build and refuses untrusted origins', () => {
  const item = (build, cpu) => `<item><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>26.${build}</sparkle:shortVersionString><sparkle:hardwareRequirements>${cpu}</sparkle:hardwareRequirements><enclosure url="${trust.downloadOrigin}/codex-app-prod/test.zip" length="12" sparkle:edSignature="AA=="/><sparkle:deltas><enclosure url="https://evil.test/x.delta"/></sparkle:deltas></item>`;
  assert.deepEqual(parseAppcast(item(1, 'arm64') + item(3, 'x64') + item(2, 'arm64'), 'arm64').map(r => r.build), ['2', '1']);
  assert.throws(() => validateDownloadUrl('https://evil.test/test.zip'), /Untrusted/);
  assert.throws(() => validateDownloadUrl('https://persistent.oaistatic.com/codex-app-prod/../test.zip'), /Untrusted/);
  assert.throws(() => verifyDownload(Buffer.from('x'), { length: 1, signature: 'AA==' }), /signature/);
  assert.throws(() => parseAppcast('<!DOCTYPE x>'), /entities/);
  assert.throws(() => assertAppTarget('/Applications/ChatGPT.app'), /Rubato.app/);
  assert.throws(() => assertAppTarget('/Rubato.app'), /explicit/);
});
function tinyAsar() {
  const json = Buffer.from(JSON.stringify({ files: { 'a.js': { size: 3, offset: '0' }, 'unpacked.node': { size: 7, unpacked: true } } }));
  const padded = Math.ceil((json.length + 4) / 4) * 4, prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4); prefix.writeUInt32LE(padded + 4, 4); prefix.writeUInt32LE(padded, 8); prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padded - json.length - 4), Buffer.from('abc')]);
}
test('ASAR rewriting preserves unpacked references, offsets and content integrity', () => {
  const rewritten = rewriteArchive(tinyAsar(), { 'a.js': 'longer contents', 'new.cjs': 'new' });
  const parsed = readArchive(rewritten.bytes);
  assert.equal(parsed.get('a.js').toString(), 'longer contents');
  assert.equal(parsed.get('new.cjs').toString(), 'new');
  assert.equal(parsed.header.files['unpacked.node'].unpacked, true);
  assert.equal(parsed.headerHash, rewritten.headerHash);
  assert.throws(() => rewriteArchive(tinyAsar(), { 'unpacked.node': 'no' }), /unpacked/);
});
test('launcher preserves isolated paths and uses the original app without bootstrap injection', async () => {
  const launcher = await readFile(new URL('../macos/launcher.m', import.meta.url), 'utf8');
  for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_ELECTRON_USER_DATA_PATH', 'OPENCODEX_HOME', '--user-data-dir=']) assert.ok(launcher.includes(key));
  assert.ok(!launcher.includes('SIGKILL'));
  assert.ok(!launcher.includes('launchAllowed'));
  assert.match(launcher, /openApplicationAtURL/);
  assert.match(launcher, /allowsRunningApplicationSubstitution = NO/);
  const builder = await readFile(new URL('../scripts/macos-app.mjs', import.meta.url), 'utf8');
  const transform = builder.split('export async function transformApp(')[1].split('export async function appPlan(')[0];
  assert.ok(!transform.includes('rewriteArchive'));
  assert.ok(!transform.includes('preserve-metadata'));
  assert.ok(!transform.includes('bootstrap.cjs'));
  assert.equal(parseUpdateArgs(['--check']).action, 'check');
  assert.equal(parseUpdateArgs([]).action, 'install');
  assert.equal(parseUpdateArgs(['--rollback']).action, 'rollback');
  assert.throws(() => parseUpdateArgs(['--wait-for-pid', 'abc']), /Invalid/);
});
test('clone transform leaves native identity, handlers and entitlements alone', async () => {
  const source = await readFile(new URL('../scripts/macos-app.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('privateGroups'));
  assert.ok(!source.includes("'--entitlements'"));
  assert.ok(!source.includes("['--force', '--deep'"));
  assert.ok(!source.includes('delete info.CFBundleURLTypes'));
  assert.ok(!source.includes('delete info.NSDockTilePlugIn'));
  assert.ok(source.includes("mode: 'signed-profile-launcher'"));
});
test('app operations reject concurrent mutation and release owned locks after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rubato-lock-test-'));
  const app = join(root, 'Rubato.app');
  try {
    await withAppLock(app, async () => assert.rejects(withAppLock(app, async () => {}), /lock exists/));
    await assert.rejects(withAppLock(app, async () => { throw new Error('expected failure'); }), /expected failure/);
    assert.equal(await withAppLock(app, async () => 'recovered'), 'recovered');
  } finally { await rm(root, { recursive: true, force: true }); }
});
