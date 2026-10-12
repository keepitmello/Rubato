import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeFingerprint, loadedCodeFiles, loadedCodeIsCurrent, recordLoadedCode } from '../src/code-fingerprint.mjs';

const src = fileURLToPath(new URL('../src/', import.meta.url));

// A small bridge: src/ with a module that reaches a file outside src/.
function tree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-code-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'client'));
  writeFileSync(path.join(root, 'src', 'bridge.mjs'), "import { a } from './nested/a.mjs';\nexport const b = () => import('../client/lazy.mjs');\n");
  writeFileSync(path.join(root, 'src', 'nested', 'a.mjs'), "export { c } from '../../client/c.mjs';\nimport 'node:fs';\n");
  writeFileSync(path.join(root, 'client', 'c.mjs'), 'export const c = 1;\n');
  writeFileSync(path.join(root, 'client', 'lazy.mjs'), 'export const lazy = 1;\n');
  writeFileSync(path.join(root, 'client', 'unused.mjs'), 'export const unused = 1;\n');
  writeFileSync(path.join(root, 'bun.lock'), 'lock 1\n');
  const options = { root: path.join(root, 'src'), base: root, lockfiles: [path.join(root, 'bun.lock')] };
  return { root, options, records: path.join(root, 'loaded') };
}

test('the loaded code is src/ and what it imports, not the rest of the repository', (t) => {
  const { root, options } = tree(t);
  assert.deepEqual(loadedCodeFiles(options.root).map((file) => path.relative(root, file)),
    ['client/c.mjs', 'client/lazy.mjs', 'src/bridge.mjs', 'src/nested/a.mjs']);
  // The real bridge reaches the engine client outside its own directory.
  const real = loadedCodeFiles(src).map((file) => path.relative(path.resolve(src, '../../..'), file));
  assert.ok(real.includes('harness/t3-integration/src/bridge.mjs'), real.join('\n'));
  assert.ok(real.includes('harness/pi-server/src/client.mjs'), real.join('\n'));
});

test('the fingerprint moves with an imported file or the lockfile, not with an unrelated one', (t) => {
  const { root, options } = tree(t);
  const before = codeFingerprint(options);
  writeFileSync(path.join(root, 'client', 'unused.mjs'), 'export const unused = 2;\n');
  assert.equal(codeFingerprint(options), before);
  writeFileSync(path.join(root, 'client', 'lazy.mjs'), 'export const lazy = 2;\n');
  const afterImport = codeFingerprint(options);
  assert.notEqual(afterImport, before);
  writeFileSync(path.join(root, 'bun.lock'), 'lock 2\n');
  assert.notEqual(codeFingerprint(options), afterImport);
});

test('an app is current only when every live process loaded the code on disk now', (t) => {
  const { root, options, records } = tree(t);
  const alive = (pid) => pid !== 999_999;
  // Nothing recorded: we cannot tell, so the app is reopened.
  assert.deepEqual(loadedCodeIsCurrent({ directory: records, fingerprint: codeFingerprint(options), alive }),
    { current: false, reason: 'unknown' });
  recordLoadedCode({ pid: 4242, directory: records, fingerprint: codeFingerprint(options) });
  recordLoadedCode({ pid: 999_999, directory: records, fingerprint: 'an exited app' });
  assert.equal(loadedCodeIsCurrent({ directory: records, fingerprint: codeFingerprint(options), alive }).current, true);
  // The exited process's record is cleaned up on the way.
  assert.deepEqual(readdirSync(records), ['4242.json']);
  writeFileSync(path.join(root, 'client', 'c.mjs'), 'export const c = 2;\n');
  assert.deepEqual(loadedCodeIsCurrent({ directory: records, fingerprint: codeFingerprint(options), alive }),
    { current: false, reason: 'changed', live: 1, stale: 1 });
});

test('importing the bridge records what this process loaded', (t) => {
  const records = mkdtempSync(path.join(tmpdir(), 'rb-loaded-code-'));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const bridge = pathToFileURL(path.join(src, 'bridge.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(bridge)}); console.log(process.pid);`],
  { encoding: 'utf8', env: { ...process.env, RUBATO_LOADED_CODE_DIR: records } });
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  const record = JSON.parse(readFileSync(path.join(records, `${pid}.json`), 'utf8'));
  assert.equal(record.pid, pid);
  assert.equal(record.fingerprint, codeFingerprint());
});
