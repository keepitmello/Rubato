import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createInspector, findRipgrep, turnAround } from '../src/session-inspect.mjs';

const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } });
const assistant = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() } });

async function fixture(t, entries) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-inspect-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  await mkdir(sessionsDir);
  const id = '01a00000-0000-7000-8000-000000000001';
  const file = path.join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  await writeFile(file, [{ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: root }, ...entries]
    .map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const inspector = (ripgrepPath) => createInspector({ agentDir: root, sessionsDir, cwds: () => [root], locate: async () => file, ripgrepPath });
  return { root, id, file, inspector };
}

const hitIds = (result) => result.results.flatMap((item) => item.hits.map((hit) => hit.entryId)).sort();

test('without ripgrep the search reads every line and finds the same hits', async (t) => {
  const env = await fixture(t, [user('e0', null, '세션 로그 찾기 어려움'), assistant('e1', 'e0', '로그는 여기 있어'), user('e2', 'e1', 'unrelated')]);
  const plain = await env.inspector(null).search({ query: '로그', limit: 8 });
  assert.deepEqual(hitIds(plain), ['e0', 'e1']);
  if (findRipgrep(env.root)) assert.deepEqual(hitIds(await env.inspector(undefined).search({ query: '로그', limit: 8 })), ['e0', 'e1']);
});

test('a term holding a quote or backslash matches the message text, not the escaped JSON line', async (t) => {
  const env = await fixture(t, [user('e0', null, 'he said "hi" there'), assistant('e1', 'e0', 'path C:\\work here'), user('e2', 'e1', 'said nothing')]);
  for (const ripgrepPath of [undefined, null]) {
    const inspector = env.inspector(ripgrepPath);
    assert.deepEqual(hitIds(await inspector.search({ query: '"hi"', limit: 8 })), ['e0']);
    assert.deepEqual(hitIds(await inspector.search({ query: 'said "hi"', limit: 8 })), ['e0']);
    assert.deepEqual(hitIds(await inspector.search({ query: 'c:\\work', limit: 8 })), ['e1']);
  }
});

test('the turn of an entry on a rewound branch reads in its own context', () => {
  const entries = [
    { type: 'session', id: 'header' },
    user('e0', null, 'q1'), assistant('e1', 'e0', 'a1'),
    user('e2', 'e1', 'q2 before the edit'), assistant('e3', 'e2', 'old answer'),
    user('e4', 'e1', 'q2 edited'), assistant('e5', 'e4', 'new answer'),
  ];
  assert.deepEqual(turnAround(entries, 'e3').entries.map((entry) => entry.id), ['e2', 'e3']);
  assert.deepEqual(turnAround(entries, 'e1').entries.map((entry) => entry.id), ['e0', 'e1'], 'a turn ends before the next input');
  assert.deepEqual(turnAround(entries, 'e4').entries.map((entry) => entry.id), ['e4', 'e5']);
  assert.equal(turnAround(entries, 'missing'), undefined);
});
