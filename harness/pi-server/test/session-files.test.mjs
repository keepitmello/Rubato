import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionFiles } from '../src/session-files.mjs';

test('an empty real Pi session survives a fresh directory view without a worker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const created = await store.create({ cwd: tmpdir(), title: 'Persist before prompt' });
  const restored = await new SessionFiles(root).resolve(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.title, 'Persist before prompt');
  assert.equal(restored.messageCount, 0);
  assert.equal(JSON.parse((await readFile(restored.file, 'utf8')).split('\n')[0]).type, 'session');
  await assert.rejects(store.resolve('missing-session'), /not found/i);
  assert.equal((await store.list()).length, 1);
});

test('a title created as locked is one the automatic session title never replaces', async (t) => {
  const { isTitleLocked } = await import('../../pi-runtime/features/session-title/session-title.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const entries = async (created) => (await readFile(created.file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const locked = await store.create({ cwd: tmpdir(), title: '⏰ Morning research · 9/24 09:00', titleLocked: true });
  assert.equal(locked.title, '⏰ Morning research · 9/24 09:00');
  assert.equal(isTitleLocked(await entries(locked)), true);
  const ordinary = await store.create({ cwd: tmpdir(), title: 'New thread' });
  assert.equal(isTitleLocked(await entries(ordinary)), false);
});

test('a session created with a system prompt carries it as its replacement entry, and a fork keeps it', async (t) => {
  const { SYSTEM_PROMPT_REPLACEMENT_ENTRY } = await import('../../pi-runtime/features/session-prompt/patches.mjs');
  const { forkSessionFile } = await import('../src/session-link.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const entries = async (file) => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const replacements = async (file) => (await entries(file))
    .filter((entry) => entry.type === 'custom' && entry.customType === SYSTEM_PROMPT_REPLACEMENT_ENTRY);

  const text = 'You are SOUL.\nNothing else.';
  const created = await store.create({ cwd: tmpdir(), title: 'Soul talk',
    systemPrompt: { text, label: 'SOUL', source: '/Users/x/Documents/SOUL.md' } });
  const [entry] = await replacements(created.file);
  assert.equal(entry.data.value, text);
  assert.equal(entry.data.label, 'SOUL');
  assert.equal(entry.data.source, '/Users/x/Documents/SOUL.md');
  const listed = await store.resolve(created.id);
  assert.equal(listed.title, 'Soul talk');
  assert.equal(listed.systemPrompt.label, 'SOUL');
  assert.equal(listed.systemPrompt.source, '/Users/x/Documents/SOUL.md');
  assert.equal(listed.systemPrompt.value, undefined, 'the list names the prompt, never carries its text');

  const untitled = await store.create({ cwd: tmpdir(), systemPrompt: { text: 'Inline only.' } });
  assert.equal((await replacements(untitled.file))[0].data.value, 'Inline only.');

  const { metadata } = await forkSessionFile({ source: created.file, sessionsDir: root, title: 'Soul talk (fork)' });
  assert.equal((await replacements(metadata.file))[0]?.data.value, text);

  const plain = await store.create({ cwd: tmpdir(), title: 'Plain' });
  assert.deepEqual(await replacements(plain.file), []);
  assert.equal((await store.resolve(plain.id)).systemPrompt, undefined);
  await assert.rejects(store.create({ cwd: tmpdir(), systemPrompt: { text: '  ' } }), /non-empty/);
});

test('a session created as the companion carries its marker in the list, and a fork of it is an ordinary conversation', async (t) => {
  const { COMPANION_ENTRY } = await import('../../companion/companion.mjs');
  const { forkSessionFile } = await import('../src/session-link.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const markers = async (file) => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === COMPANION_ENTRY);
  const companion = await store.create({ cwd: tmpdir(), title: 'Segno', titleLocked: true, companion: true });
  assert.equal(companion.companion, true);
  assert.equal((await markers(companion.file)).length, 1);
  assert.equal((await new SessionFiles(root).resolve(companion.id)).companion, true, 'a fresh directory view reads it again');
  const plain = await store.create({ cwd: tmpdir(), title: 'Lead' });
  assert.equal(plain.companion, undefined);
  const { metadata } = await forkSessionFile({ source: companion.file, sessionsDir: root, title: 'Segno (fork)' });
  assert.equal(metadata.companion, undefined);
  assert.deepEqual(await markers(metadata.file), []);
  await assert.rejects(store.create({ cwd: tmpdir(), companion: 'yes' }), /companion must be a boolean/);
});

test('a transcript carries Pi\'s own custom messages hidden, so a client can tell whose turn follows a background finish', async (t) => {
  const { appendFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const created = await store.create({ cwd: tmpdir(), title: 'Background' });
  const head = JSON.parse((await readFile(created.file, 'utf8')).trim().split('\n').at(-1));
  const at = new Date().toISOString();
  const lines = [
    { type: 'message', id: 'm1', parentId: head.id, timestamp: at, message: { role: 'user', content: 'run it', timestamp: 1 } },
    { type: 'custom_message', id: 'c1', parentId: 'm1', timestamp: at, customType: 'senpi-terminal:notification', display: false,
      content: '<system-reminder>Background terminal session bash_9 finished: completed.</system-reminder>' },
    { type: 'custom_message', id: 'c2', parentId: 'c1', timestamp: at, customType: 'rubato-session-message', display: false,
      content: 'x', details: { v: 1, kind: 'notice', from: { sessionId: 'lead' } } },
    { type: 'message', id: 'm2', parentId: 'c2', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2 } },
  ];
  await appendFile(created.file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const { messages } = await store.transcript(created.id);
  assert.deepEqual(messages.map((message) => [message.role, message.customType ?? null, message.display ?? null]),
    [['user', null, null], ['custom', 'senpi-terminal:notification', false], ['assistant', null, null]],
    'the terminal finish comes hidden; a hidden session notice still stays out');
});
