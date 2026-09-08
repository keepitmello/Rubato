import assert from 'node:assert/strict';
import { readFile, readdir, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readArchive } from '../scripts/asar.mjs';

// Read-only comparison of a locally built app. No launch, login or model call.
test('installed clone preserves upstream payload and changes only the branding/workflow/update boundary', {
  skip: process.env.RUBATO_MACOS_NATIVE_E2E !== '1',
}, async () => {
  const source = process.env.RUBATO_MACOS_UPSTREAM || '/Applications/ChatGPT.app';
  const target = process.env.RUBATO_MACOS_TEST_APP || '/Applications/Rubato.app';
  const plist = app => {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const original = plist(source), clone = plist(target);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let files = 0;
  async function compare(relative) {
    if (relative === 'Contents/_CodeSignature' || relative === 'Contents/Info.plist' || relative === 'Contents/Resources/app.asar' || /\/[^/]+\.lproj\/InfoPlist\.strings$/.test(relative)) return;
    const from = join(source, relative), metadata = await lstat(from);
    const to = join(target, relative === `Contents/MacOS/${original.CFBundleExecutable}` ? relative + '.real' : relative);
    if (relative === `Contents/MacOS/${original.CFBundleExecutable}`) {
      const code = p => { const r = spawnSync('/usr/bin/otool', ['-t', p], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.split('\n').slice(1).join('\n'); };
      const entitlements = p => { const r = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', p], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
      assert.equal(code(to), code(from), 'main executable instructions');
      assert.equal(entitlements(to), entitlements(from), 'main executable entitlements');
      return;
    }
    if (metadata.isSymbolicLink()) { assert.equal(await readlink(to), await readlink(from), relative); return; }
    if (metadata.isDirectory()) { for (const name of await readdir(from)) await compare(join(relative, name)); return; }
    assert.equal(hash(await readFile(to)), hash(await readFile(from)), relative); files++;
  }
  await compare('Contents');
  assert.ok(files > 100, 'must compare actual native application payload');
  for (const key of ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'UTExportedTypeDeclarations', 'NSDockTilePlugIn']) assert.deepEqual(clone[key], original[key], key);
  assert.equal(clone.CFBundleDisplayName, 'Rubato');
  const a = readArchive(await readFile(join(source, 'Contents/Resources/app.asar')));
  const b = readArchive(await readFile(join(target, 'Contents/Resources/app.asar')));
  let unchanged = 0;
  function compareAsar(node, prefix = '') {
    for (const [name, file] of Object.entries(node.files || {})) {
      const path = prefix + name;
      if (file.files) { compareAsar(file, path + '/'); continue; }
      if (file.link || file.unpacked || path === 'package.json') continue;
      const bytes = a.get(path);
      const anchor = 'constructor(e){this.options=e}async initialize(){if(!this.options.enableUpdater)';
      if (/^\.vite\/build\/window-all-closed-.*\.js$/.test(path) && bytes.toString().includes(anchor)) {
        const expected = bytes.toString().replace(anchor, 'constructor(e){this.options=e;globalThis.__rubatoAttachUpdater?.(this)}async initialize(){if(!this.options.enableUpdater)');
        assert.equal(b.get(path).toString(), expected, path);
      } else { assert.equal(hash(b.get(path)), hash(bytes), path); unchanged++; }
    }
  }
  compareAsar(a.header);
  assert.ok(unchanged > 100);
  const launcher = spawnSync(join(target, 'Contents/MacOS', clone.CFBundleExecutable), ['--rubato-print-paths'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(launcher.status, 0, launcher.stderr);
  assert.equal(JSON.parse(launcher.stdout).launchAllowed, undefined);
  const signed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  console.log(`Preserved ${files} upstream filesystem files and ${unchanged} packed ASAR entries`);
});
