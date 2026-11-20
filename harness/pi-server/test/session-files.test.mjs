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

test('a scan running while sessions are created never lists one without the marks it was created with', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  let creating = true;
  const seen = [];
  const watching = (async () => {
    while (creating) seen.push(...await new SessionFiles(root).list());
  })();
  for (let i = 0; i < 30; i++) await store.create({ cwd: tmpdir(), title: 'Roo', titleLocked: true, companion: true, companionId: 'roo' });
  creating = false;
  await watching;
  assert.ok(seen.length > 0, 'the scan saw sessions while they were made');
  assert.deepEqual(seen.filter((row) => row.companion !== true || row.companionId !== 'roo' || row.title !== 'Roo'), []);
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

test('a transcript since a moment reads only the newest messages of the live branch, the same rows the whole one has', async (t) => {
  const { appendFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const created = await store.create({ cwd: tmpdir(), title: 'Long companion' });
  let parentId = JSON.parse((await readFile(created.file, 'utf8')).trim().split('\n').at(-1)).id;
  const minute = (n) => Date.parse('2026-11-20T00:00:00Z') + n * 60_000;
  const lines = [];
  const add = (id, n, message, parent = parentId) => {
    lines.push({ type: 'message', id, parentId: parent, timestamp: new Date(minute(n)).toISOString(), message: { ...message, timestamp: minute(n) } });
    parentId = id;
  };
  // Over two read chunks of old work, in Korean, so a chunk boundary falls inside a character.
  for (let i = 0; i < 1200; i++) add(`old${i}`, 0, { role: 'toolResult', toolCallId: `t${i}`, toolName: 'bash', content: [{ type: 'text', text: '가'.repeat(700) }] });
  lines.push({ type: 'model_change', id: 'mc', parentId, timestamp: new Date(minute(1)).toISOString(), provider: 'anthropic', modelId: 'claude' });
  parentId = 'mc';
  add('u1', 50, { role: 'user', content: '어디까지 했어?' });
  add('a1', 51, { role: 'assistant', content: [{ type: 'text', text: '절반쯤.' }] });
  const fork = parentId;
  add('lost', 52, { role: 'assistant', content: [{ type: 'text', text: '되감긴 답' }] });
  add('a2', 53, { role: 'assistant', content: [{ type: 'text', text: '다 했어.' }] }, fork);
  await appendFile(created.file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const whole = await store.transcript(created.id);
  assert.equal(whole.model, 'anthropic/claude');
  const recent = await store.transcript(created.id, { since: minute(50) });
  assert.deepEqual(recent.messages, whole.messages.filter((message) => message.timestamp >= minute(50)),
    'the same rows as the whole branch from then on; the rewound answer stays out');
  assert.deepEqual(recent.messages.map((message) => message.entryId), ['u1', 'a1', 'a2']);
  assert.equal('model' in recent, false, 'the model is in the part not read');
  assert.equal(recent.since, minute(50));

  // A file in an older format needs Pi's migration, which reads the whole file: the whole branch comes.
  const older = await store.create({ cwd: tmpdir(), title: 'Older' });
  const [header, ...rest] = (await readFile(older.file, 'utf8')).trim().split('\n');
  await writeFile(older.file, [JSON.stringify({ ...JSON.parse(header), version: 2 }), ...rest,
    JSON.stringify({ type: 'message', id: 'o1', parentId: JSON.parse(rest.at(-1) ?? header).id ?? null, timestamp: new Date(minute(0)).toISOString(),
      message: { role: 'user', content: 'old', timestamp: minute(0) } })].join('\n') + '\n');
  const fallback = await store.transcript(older.id, { since: minute(50) });
  assert.deepEqual(fallback.messages.map((message) => message.entryId), ['o1']);
  assert.equal('since' in fallback, false);
});

test("a conversation's artifacts folder is not searched for conversations; an older per-cwd folder still is", async (t) => {
  const { mkdir, copyFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const top = await store.create({ cwd: tmpdir(), title: 'Top level' });
  const artifacts = top.file.replace(/\.jsonl$/, '-artifacts');
  await mkdir(artifacts);
  await copyFile(top.file, join(artifacts, 'stray.jsonl'));
  const legacy = join(root, '--Users-someone-project--');
  await mkdir(legacy);
  const other = await new SessionFiles(legacy).create({ cwd: tmpdir(), title: 'Per-cwd folder' });
  const files = (await new SessionFiles(root).list()).map((session) => session.file).sort();
  assert.deepEqual(files, [top.file, other.file].sort(), 'artifacts skipped, the per-cwd folder listed');
});
