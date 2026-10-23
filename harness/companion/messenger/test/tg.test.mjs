import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeTg } from '../tg.mjs';

function fakeTg(t, body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-fake-tg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tg');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('the "make it for me" path is offered only when the person has a working tg client', async (t) => {
  const connected = fakeTg(t, `echo '{"daemon":{"connected":true,"account":"someone"}}'`);
  assert.deepEqual(await probeTg({ env: { ...process.env, RUBATO_TG_BIN: connected } }),
    { available: true, account: 'someone' });

  const disconnected = fakeTg(t, `echo '{"daemon":{"connected":false}}'`);
  assert.equal((await probeTg({ env: { ...process.env, RUBATO_TG_BIN: disconnected } })).available, false);

  const broken = fakeTg(t, 'exit 3');
  assert.equal((await probeTg({ env: { ...process.env, RUBATO_TG_BIN: broken } })).available, false);

  const missing = path.join(tmpdir(), 'no-such-tg-for-this-test');
  const absent = await probeTg({ env: { ...process.env, RUBATO_TG_BIN: missing } });
  assert.equal(absent.available, false);
  assert.match(absent.reason, /no tg client/);

  // A PATH with no tg at all: the case most people are in.
  const empty = await probeTg({ env: { ...process.env, RUBATO_TG_BIN: 'tg', PATH: path.join(tmpdir(), 'empty-for-this-test') } });
  assert.equal(empty.available, false);
});

test('the tg client is looked up on the given environment\'s search path, with Windows Path and PATHEXT', async (t) => {
  const { resolveBinary } = await import('../tg.mjs');
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-tg-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Named as PATHEXT spells it: Windows matches the extension in any case, but this test's
  // filesystem may not (Linux CI).
  writeFileSync(path.join(dir, 'tg.CMD'), '@echo off');
  assert.equal(resolveBinary('tg', { Path: `C:\\nowhere;${dir}`, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase(), path.join(dir, 'tg.cmd').toLowerCase());
  assert.equal(resolveBinary('tg', { Path: dir, PATHEXT: '.EXE' }, 'win32'), undefined, 'only the extensions PATHEXT names');
  writeFileSync(path.join(dir, 'tg'), '#!/bin/sh\n');
  chmodSync(path.join(dir, 'tg'), 0o755);
  assert.equal(resolveBinary('tg', { PATH: `/nowhere:${dir}` }, 'darwin'), path.join(dir, 'tg'), "the env passed in, not the process's");
  assert.equal(resolveBinary('tg', { PATH: '/nowhere' }, 'darwin'), undefined);
});
