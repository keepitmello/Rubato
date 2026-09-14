import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile, readdir, realpath, stat, rename, symlink, link, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionFiles } from '../src/session-files.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const timestamp = '2026-09-01T00:00:00.000Z';
const header = (id, extra = {}) => ({ type: 'session', version: 3, id, timestamp, cwd: '/project', ...extra });
const message = (role, content, extra = {}) => ({ type: 'message', timestamp,
  message: { role, content, ...extra } });
const name = (value) => ({ type: 'session_info', timestamp, name: value });
const jsonl = (entries) => entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-index-')));
  const sessions = path.join(root, 'sessions');
  await mkdir(sessions);
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, entries) => {
    const target = path.join(sessions, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, jsonl(entries));
    return target;
  };
  return { root, sessions, put, store: new SessionFiles(sessions) };
}
function observeReads(t, onRead = () => {}) {
  const original = fs.createReadStream;
  const reads = [];
  let active = 0, peak = 0;
  fs.createReadStream = function (file, options) {
    const stream = original.call(this, file, options);
    if (String(file).endsWith('.jsonl')) {
      reads.push(String(file)); active++; peak = Math.max(peak, active);
      stream.once('close', () => active--);
      onRead(file, stream);
    }
    return stream;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  return { reads, get peak() { return peak; }, get active() { return active; } };
}
// Exact old listing path is the oracle, including flat/nested ordering and
// canonical containment. Never uses SessionManager.open (which can migrate).
async function legacyList(root) {
  const folders = [root, ...(await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))];
  const infos = (await Promise.all(folders.map((dir) => SessionManager.listAll(dir)))).flat();
  const canonicalRoot = await realpath(root);
  const result = [];
  for (const info of infos) {
    const file = await realpath(info.path).catch(() => null);
    if (file?.startsWith(canonicalRoot + path.sep)) result.push({ id: info.id, file, cwd: info.cwd,
      title: info.name || info.firstMessage || 'New session', createdAt: info.created.getTime(),
      modifiedAt: info.modified.getTime(), messageCount: info.messageCount });
  }
  return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

test('slim metadata matches the pinned Pi SDK; listing never migrates original bytes', async (t) => {
  const { sessions, put, store } = await fixture(t);
  const cases = [
    [header('empty')],
    [header('text'), message('assistant', 'first assistant'), message('user', 'first user'), message('assistant', 'later', { timestamp: 1790000000000 })],
    [header('blocks'), message('user', [{ type: 'image', data: 'abc' }]), message('user', [{ type: 'text', text: '가' }, { type: 'image' }, { type: 'text', text: '나' }])],
    [header('clear'), name('initial'), message('user', 'fallback'), name('   ')],
    [header('name'), message('user', 'hidden'), name('  latest name  '), message('toolResult', 'tool', { timestamp: 1990000000000 })],
    ['bad json', ' ', null, header('old', { version: 1 }), message('hookMessage', 'custom'), message('user', 'old user')],
    [header('no-date', { timestamp: undefined, cwd: null }), message('user', 'fallback stat', { timestamp: -1 })],
    [header('invalid-date', { timestamp: 'not-a-date' }), { ...message('user', 'no timestamp'), timestamp: 'invalid' }],
    [header('counts'), { type: 'message', message: { role: 'bashExecution', output: 'x' } }, message('custom', 'custom'), message('user', '')],
    [header('timestamps'), message('user', 'a', { timestamp: 10 }), message('assistant', 'b', { timestamp: 5 }), name('last metadata')],
    [header('bad-message'), { type: 'message', message: null }],
    [header('bad-content'), message('assistant', { not: 'an array' })],
    [header('bad-block'), message('assistant', [null])],
    [header('bad-name'), name(42)],
    [message('user', 'no header'), header('too-late')],
    ['garbage only'],
  ];
  const files = await Promise.all(cases.map((entries, i) => put(`${i < 8 ? '' : 'nested/'}${String(i).padStart(2, '0')}.jsonl`, entries)));
  await put('nested/deeper/ignored.jsonl', [header('too-deep')]);
  const before = await Promise.all(files.map((file) => readFile(file)));
  assert.deepEqual(await store.list(), await legacyList(sessions));
  assert.deepEqual(await store.list(), await legacyList(sessions));
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
});

test('metadata differential covers mixed legacy and malformed values across cwd folders', async (t) => {
  const { sessions, put, store } = await fixture(t);
  let seed = 731;
  const choose = (items) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return items[seed % items.length]; };
  const dates = [timestamp, undefined, null, 'invalid', 0, 1e300];
  const contents = ['plain', '', ' ', [], [{ type: 'text', text: 'hello' }], [{ type: 'image', data: 'x' }],
    [{ type: 'text', text: 7 }, { type: 'text', text: null }], null, false, {}, [null], [42]];
  for (let i = 0; i < 160; i++) {
    const entries = [header(`fuzz-${i}`, { timestamp: choose(dates), version: choose([1, 2, 3]) })];
    for (let j = 0; j < 5; j++) {
      if (choose([false, false, true])) entries.push(name(choose([' name ', ' ', null, undefined, 7])));
      else entries.push({ type: 'message', timestamp: choose(dates), message: {
        role: choose(['user', 'assistant', 'toolResult', 'custom']), content: choose(contents),
        timestamp: choose([undefined, 0, -5, 100, 1e300]),
      } });
    }
    await put(`${i % 8}/${i}.jsonl`, entries);
  }
  assert.deepEqual(await store.list(), await legacyList(sessions));
});

test('unchanged warm list and resolve read no JSONL; change parses one file; create avoids rescanning history', async (t) => {
  const { root, put, store } = await fixture(t);
  const a = await put('a.jsonl', [header('A')]);
  await put('other/b.jsonl', [header('B')]);
  const io = observeReads(t);
  const first = await store.list();
  assert.equal(io.reads.length, 2);
  first[0].title = 'caller mutation'; first.splice(0);
  await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2 ? store.list() : store.resolve('A')));
  assert.equal(io.reads.length, 2);
  assert.equal((await store.resolve('A')).title, '(no messages)');
  await appendFile(a, jsonl([name('new title')]));
  assert.equal((await store.resolve('A')).title, 'new title');
  assert.deepEqual(io.reads.slice(2), [a]);
  const created = await store.create({ cwd: root, title: 'new' });
  assert.deepEqual(io.reads.slice(3), [created.file]);
  assert.equal((await store.list()).length, 3);
  assert.equal(io.reads.length, 4);
  assert.equal(io.active, 0);
});

test('equal-size rewrite with restored mtime, truncation, replacement, rename and deletion invalidate the cache', async (t) => {
  const { sessions, put, store } = await fixture(t);
  const a = await put('a.jsonl', [header('A'), name('one')]);
  const io = observeReads(t);
  await store.list();
  const originalStat = await stat(a);
  await writeFile(a, jsonl([header('A'), name('two')]));
  await utimes(a, originalStat.atime, originalStat.mtime);
  assert.equal((await store.resolve('A')).title, 'two');
  await writeFile(a, jsonl([header('A')]));
  assert.equal((await store.resolve('A')).title, '(no messages)');
  const replacement = path.join(sessions, 'swap');
  await writeFile(replacement, jsonl([header('B')]));
  await rename(replacement, a);
  await assert.rejects(store.resolve('A'), /not found/i);
  assert.equal((await store.resolve('B')).file, a);
  const moved = path.join(sessions, 'b.jsonl');
  await rename(a, moved);
  assert.equal((await store.resolve('B')).file, moved);
  await rm(moved);
  assert.deepEqual(await store.list(), []);
  assert.equal(io.reads.length, 5);
});

test('partial JSONL, malformed stable files and deletion/recreation do not poison the cache', async (t) => {
  const { put, store } = await fixture(t);
  const a = await put('a.jsonl', [header('A')]);
  const bad = await put('bad.jsonl', ['broken json']);
  const io = observeReads(t);
  await store.list(); await store.list();
  assert.equal(io.reads.length, 2);
  await appendFile(a, '{"type":"session_info","name":"part');
  assert.equal((await store.resolve('A')).title, '(no messages)');
  await appendFile(a, 'ial"}\n');
  assert.equal((await store.resolve('A')).title, 'partial');
  await writeFile(bad, jsonl([header('fixed')]));
  assert.equal((await store.list()).length, 2);
  await rm(a); await store.list();
  await writeFile(a, jsonl([header('A'), name('recreated')]));
  assert.equal((await store.resolve('A')).title, 'recreated');
});

test('append while a stream is open is bounded and cannot validate an incomplete cached snapshot', async (t) => {
  const { put, store } = await fixture(t);
  const a = await put('a.jsonl', [header('A')]);
  let changed = false;
  const io = observeReads(t, (file, stream) => {
    if (file === a && !changed) {
      changed = true;
      stream.once('open', () => fs.appendFileSync(a, jsonl([name('appended during read')])));
    }
  });
  assert.equal((await store.list())[0].title, '(no messages)');
  assert.equal((await store.resolve('A')).title, 'appended during read');
  await store.list();
  assert.equal(io.reads.length, 2);
});

test('canonical containment, symlink retargeting and duplicate identities retain safe resolution', async (t) => {
  const { root, sessions, put, store } = await fixture(t);
  const outside = path.join(root, 'outside.jsonl');
  await writeFile(outside, jsonl([header('outside')]));
  const a = await put('a.jsonl', [header('A')]);
  const alias = path.join(sessions, 'alias.jsonl');
  await symlink(outside, alias);
  const io = observeReads(t);
  assert.deepEqual((await store.list()).map((item) => item.id), ['A']);
  assert.deepEqual(io.reads, [a]);
  await rm(alias); await symlink(a, alias);
  await assert.rejects(store.resolve('A'), /ambiguous/i);
  await rm(alias); await link(a, alias);
  await assert.rejects(store.resolve('A'), /ambiguous/i);
  await rm(alias);
  assert.equal((await store.resolve('A')).file, a);
  await put('clone.jsonl', [header('A')]);
  await assert.rejects(store.resolve('A'), /ambiguous/i);
});

test('overlapping cold lists and resolves share one globally bounded scan across folders', async (t) => {
  const { put, store } = await fixture(t);
  await Promise.all(Array.from({ length: 80 }, (_, i) => put(`${i % 20}/${i}.jsonl`, [header(`id-${i}`), message('assistant', 'x'.repeat(32768))])));
  const io = observeReads(t);
  const result = await Promise.all([store.list(), store.list(), store.resolve('id-0')]);
  assert.equal(result[0].length, 80);
  assert.equal(result[2].id, 'id-0');
  assert.equal(io.reads.length, 80);
  assert.ok(io.peak <= 10, `opened ${io.peak} streams concurrently`);
  assert.equal(io.active, 0);
});

test('inventory-only host never imports the engine, providers or TUI SDK', async (t) => {
  const { sessions, put } = await fixture(t);
  await put('a.jsonl', [header('A')]);
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.includes('pi-coding-agent')) throw new Error('Inventory loaded the agent SDK');
      return next(specifier, context);
    }});
    const { createSessionHost } = await import(${JSON.stringify(new URL('../src/host.mjs', import.meta.url).href)});
    const host = createSessionHost({ sessionsDir: ${JSON.stringify(sessions)}, serverId: 'test', pollMs: 0,
      workerFactory() { throw new Error('Inventory spawned a worker'); } });
    try {
      await host.start();
      const result = await host.resolveSession('A');
      if (result.id !== 'A' || host.metrics.runtimeStarts !== 0) throw new Error('Wrong inventory result');
      console.log('inventory-without-engine');
    } finally { await host.close(); }
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000 });
  assert.match(result.stdout, /inventory-without-engine/);
});
