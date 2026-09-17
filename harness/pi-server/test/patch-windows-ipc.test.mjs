import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchThrow, patchListener } from '../scripts/patch-windows-ipc.mjs';

test('strips the Windows unix-transport throw and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubato-ipc-'));
  const file = join(dir, 'unix.js');
  writeFileSync(file, `function validate(options) {
    if (process.platform === "win32")
        throw new Error("Unix transport is not supported on Windows");
    return options;
}
`);
  assert.equal(patchThrow(file), 'patched');
  const once = readFileSync(file, 'utf8');
  assert.equal(once.includes('Unix transport is not supported on Windows'), false);
  assert.equal(patchThrow(file), 'clean');
});

test('injects named-pipe fastpath into the unix listener', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubato-ipc-'));
  const file = join(dir, 'listener.js');
  writeFileSync(file, `    async start(accept) {
        this.accept = accept;
        const ownedBindPath = getOwnedBindPath(this.path);
    }
`);
  assert.equal(patchListener(file), 'patched');
  const once = readFileSync(file, 'utf8');
  assert.match(once, /WINDOWS_PIPE_FASTPATH/);
  assert.match(once, /server.listen\(this.path\)/);
  assert.equal(patchListener(file), 'clean');
});
