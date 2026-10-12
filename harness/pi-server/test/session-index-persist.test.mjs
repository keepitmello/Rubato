import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionFiles } from '../src/session-files.mjs';
import { serveProfile } from '../src/profile-server.mjs';

// A restarted engine lists sessions from the index the previous one saved, instead of
// parsing every session file again. These tests hold the index to "old is fine, wrong is not".
const timestamp = '2026-09-01T00:00:00.000Z';
const header = (id, extra = {}) => ({ type: 'session', version: 3, id, timestamp, cwd: '/project', ...extra });
const message = (role, content, extra = {}) => ({ type: 'message', timestamp, message: { role, content, ...extra } });
const name = (value) => ({ type: 'session_info', timestamp, name: value });
const jsonl = (entries) => entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-index-persist-')));
  const sessions = path.join(root, 'sessions');
  const indexPath = path.join(root, 'server', 'session-index.json');
  await mkdir(sessions);
  t.after(async () => { await chmod(path.dirname(indexPath), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const put = async (file, entries) => {
    const target = path.join(sessions, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, jsonl(entries));
    return target;
  };
  // A store is what one engine process holds; a new store is the next process.
  const open = (options = {}) => new SessionFiles(sessions, { indexPath, ...options });
  const fresh = () => new SessionFiles(sessions).list();
  return { root, sessions, indexPath, put, open, fresh };
}
function observeReads(t) {
  const original = fs.createReadStream;
  const reads = [];
  fs.createReadStream = function (file, options) {
    if (String(file).endsWith('.jsonl')) reads.push(String(file));
    return original.call(this, file, options);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  return reads;
}

test('a new process lists from the saved index without reading a single session file', async (t) => {
  const { put, open, fresh } = await fixture(t);
  // Legacy shapes included on purpose: invalid dates give NaN, which JSON cannot carry.
  await put('a.jsonl', [header('A'), message('user', 'hello'), name(' named ')]);
  await put('x/b.jsonl', [header('B', { timestamp: 'not-a-date' }), message('user', 'later', { timestamp: 1e300 })]);
  await put('x/c.jsonl', [header('C', { timestamp: undefined, cwd: null })]);
  await put('x/broken.jsonl', ['not json']);
  const first = open();
  const listed = await first.list();
  await first.close();
  const reads = observeReads(t);
  const second = open();
  assert.deepEqual(await second.list(), listed);
  assert.deepEqual(reads, []);
  assert.deepEqual(await fresh(), listed);
  assert.equal(Number.isNaN(listed.find((item) => item.id === 'B').createdAt), true);
});

test('files changed, added or removed since the save are picked up; untouched ones are not read', async (t) => {
  const { sessions, put, open, fresh } = await fixture(t);
  const a = await put('a.jsonl', [header('A'), name('one')]);
  const b = await put('b.jsonl', [header('B')]);
  const d = await put('x/d.jsonl', [header('D'), name('aaa')]);
  await put('x/e.jsonl', [header('E')]);
  const first = open();
  await first.list();
  await first.close();
  await appendFile(a, jsonl([name('two')]));
  await rm(b);
  const c = await put('x/c.jsonl', [header('C'), name('new')]);
  // Same size, mtime put back: only the change time tells.
  const before = await stat(d);
  await writeFile(d, jsonl([header('D'), name('bbb')]));
  await utimes(d, before.atime, before.mtime);
  const reads = observeReads(t);
  const listed = await open().list();
  assert.deepEqual(listed, await fresh());
  assert.deepEqual(new Set(reads.slice(0, 3)), new Set([a, c, d]));
  assert.equal(reads.length - 3, (await readdir(sessions, { recursive: true })).filter((f) => f.endsWith('.jsonl')).length, 'the oracle read every file');
  assert.deepEqual(listed.map((item) => [item.id, item.title]).sort(), [['A', 'two'], ['C', 'new'], ['D', 'bbb'], ['E', '(no messages)']]);
});

test('a missing, corrupt, foreign or older index falls back to a full scan and is replaced', async (t) => {
  const { indexPath, put, open, fresh } = await fixture(t);
  await put('a.jsonl', [header('A'), name('kept')]);
  await put('x/b.jsonl', [header('B')]);
  const seed = open();
  await seed.list();
  await seed.close();
  const good = JSON.parse(await readFile(indexPath, 'utf8'));
  const variants = {
    missing: null,
    corrupt: '{"format":1,"entr',
    'other reader version': JSON.stringify({ ...good, metadataVersion: 'something-else' }),
    'other format': JSON.stringify({ ...good, format: 999 }),
    'other sessions folder': JSON.stringify({ ...good, root: '/elsewhere/sessions' }),
    'malformed entry': JSON.stringify({ ...good, entries: [...good.entries.slice(1), [good.entries[0][0], 7, null]] }),
    'date that is not a number': JSON.stringify({ ...good, entries: good.entries.map(([file, key, metadata]) => [file, key, metadata && { ...metadata, modifiedAt: '12' }]) }),
    'entry outside the folder': JSON.stringify({ ...good, entries: [['/etc/passwd.jsonl', 'k', null]] }),
  };
  for (const [label, body] of Object.entries(variants)) {
    if (body === null) await rm(indexPath, { force: true }); else await writeFile(indexPath, body);
    const reads = observeReads(t);
    const store = open();
    const listed = await store.list();
    assert.equal(reads.length, 2, `${label}: the store did not parse every file`);
    assert.deepEqual(listed, await fresh(), label);
    await store.close();
    const after = observeReads(t);
    await open().list();
    assert.deepEqual(after, [], `${label}: the replacement index was not usable`);
  }
});

test('a failed save leaves the previous index whole and is reported', async (t) => {
  const { indexPath, put, open } = await fixture(t);
  const a = await put('a.jsonl', [header('A'), name('one')]);
  const first = open();
  await first.list();
  await first.flush();
  const saved = await readFile(indexPath, 'utf8');
  const errors = [];
  const store = open({ onError: (error) => errors.push(error) });
  await store.list();
  await appendFile(a, jsonl([name('two')]));
  await chmod(path.dirname(indexPath), 0o500);
  await store.list();
  await store.flush();
  await chmod(path.dirname(indexPath), 0o700);
  assert.ok(errors.length >= 1, 'the failed save was not reported');
  assert.equal(await readFile(indexPath, 'utf8'), saved);
  assert.deepEqual(await readdir(path.dirname(indexPath)), ['session-index.json'], 'a partial file was left beside the index');
  await store.flush();
  const reads = observeReads(t);
  assert.equal((await open().resolve('A')).title, 'two');
  assert.deepEqual(reads, [], 'the change was not saved once the folder was writable again');
});

test('changes after the first save reach the index within the save interval, and on close', async (t) => {
  const { put, open } = await fixture(t);
  const a = await put('a.jsonl', [header('A'), name('one')]);
  const store = open({ saveIntervalMs: 50 });
  await store.list();
  await store.flush();
  await appendFile(a, jsonl([name('two')]));
  await store.list();
  await new Promise((resolve) => setTimeout(resolve, 150));
  let reads = observeReads(t);
  assert.equal((await open().resolve('A')).title, 'two');
  assert.deepEqual(reads, []);
  const slow = open({ saveIntervalMs: 60000 });
  await slow.list();
  await appendFile(a, jsonl([name('three')]));
  await slow.list();
  await slow.close();
  reads = observeReads(t);
  assert.equal((await open().resolve('A')).title, 'three');
  assert.deepEqual(reads, []);
});

test('a restarted profile engine lists its sessions without parsing them again', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-index-engine-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions');
  await mkdir(path.join(sessions, 'p'), { recursive: true });
  for (const id of ['A', 'B', 'C']) await writeFile(path.join(sessions, 'p', `${id}.jsonl`), jsonl([header(id), message('user', `hi ${id}`)]));
  const workerFactory = () => { throw new Error('listing must not open a session'); };
  const first = await serveProfile({ agentDir: root, workerFactory });
  const listed = first.host.directory.value.sessions;
  await first.close();
  const reads = observeReads(t);
  const second = await serveProfile({ agentDir: root, workerFactory });
  t.after(() => second.close());
  assert.deepEqual(second.host.directory.value.sessions, listed);
  assert.equal(listed.length, 3);
  assert.deepEqual(reads, []);
});

test('mixed legacy and malformed values read back from the index exactly as parsed', async (t) => {
  const { put, open, fresh } = await fixture(t);
  let seed = 917;
  const choose = (items) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return items[seed % items.length]; };
  const dates = [timestamp, undefined, null, 'invalid', 0, -0, 1e300];
  const contents = ['plain', '', [], [{ type: 'text', text: 'hello' }], [{ type: 'image', data: 'x' }], null, {}, [null]];
  for (let i = 0; i < 160; i++) {
    const entries = [header(choose([`fuzz-${i}`, 'NaN', { createdAt: 'NaN' }, 7]), { timestamp: choose(dates) })];
    for (let j = 0; j < 4; j++) {
      entries.push(choose([false, true]) ? name(choose([' name ', ' ', null, 7])) : { type: 'message', timestamp: choose(dates),
        message: { role: choose(['user', 'assistant', 'toolResult']), content: choose(contents), timestamp: choose([undefined, 0, -5, 1e300]) } });
    }
    await put(`${i % 8}/${i}.jsonl`, entries);
  }
  const first = open();
  const listed = await first.list();
  await first.close();
  const reads = observeReads(t);
  assert.deepEqual(await open().list(), listed);
  assert.deepEqual(reads, []);
  assert.deepEqual(await fresh(), listed);
});
