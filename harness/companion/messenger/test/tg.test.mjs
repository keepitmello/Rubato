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
