import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INBOX_STATUSES, inboxPath, openInbox } from '../inbox.mjs';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-inbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

const clock = (start = Date.parse('2026-10-19T10:00:00Z')) => {
  let now = start;
  return () => (now += 60_000);
};

test('a bug report from another chat becomes one item, and the same message twice is one item', (t) => {
  const env = sandbox(t);
  const inbox = openInbox({ env, now: clock() });
  t.after(() => inbox.close());
  const first = inbox.add({ title: '앱이 자꾸 죽어요', body: '로그인 화면에서 죽습니다.', source: 'telegram',
    sourceRef: 'telegram:-1001:77', reporter: 'Gildong' });
  const again = inbox.add({ title: '앱이 자꾸 죽어요', source: 'telegram', sourceRef: 'telegram:-1001:77', reporter: 'Gildong' });
  assert.equal(first.item.id, 'S-1');
  assert.equal(first.item.status, 'open');
  assert.equal(first.item.reporter, 'Gildong');
  assert.equal(again.duplicate, true);
  assert.equal(again.item.id, 'S-1');
  assert.equal(inbox.list().length, 1);
});

test('the list reads newest first, filters by status and source, and counts what is open', (t) => {
  const env = sandbox(t);
  const inbox = openInbox({ env, now: clock() });
  t.after(() => inbox.close());
  inbox.add({ title: '첫 번째', source: 'telegram', sourceRef: 'telegram:1:1' });
  inbox.add({ title: '두 번째', source: 'user' });
  inbox.add({ title: '세 번째', source: 'telegram', sourceRef: 'telegram:1:2' });
  assert.deepEqual(inbox.list().map((item) => item.title), ['세 번째', '두 번째', '첫 번째']);
  assert.deepEqual(inbox.list({ source: 'telegram' }).map((item) => item.title), ['세 번째', '첫 번째']);
  inbox.update('S-1', { status: 'in-progress', leadSessionId: 'lead-7' });
  // "open" means still somebody's work: open, in-progress and waiting all count.
  assert.deepEqual(inbox.list({ status: 'open' }).map((item) => item.id), ['S-3', 'S-2', 'S-1']);
  assert.equal(inbox.counts().open, 3, 'open work = open + in-progress + waiting');
  assert.equal(inbox.counts()['in-progress'], 1);
});

test('a status change and a note are kept as the item\'s own history', (t) => {
  const env = sandbox(t);
  const inbox = openInbox({ env, now: clock() });
  t.after(() => inbox.close());
  inbox.add({ title: '로그인이 안 돼요', source: 'telegram', sourceRef: 'telegram:-5:9' });
  const linked = inbox.update('S-1', { status: 'in-progress', leadSessionId: 'lead-3', note: '재현은 리드가 맡았어.' });
  assert.equal(linked.status, 'in-progress');
  assert.equal(linked.leadSessionId, 'lead-3');
  const done = inbox.update('S-1', { status: 'done' });
  assert.equal(done.status, 'done');
  assert.ok(done.closedAt, 'closing stamps the time');
  const full = inbox.get('S-1');
  assert.deepEqual(full.notes.map((note) => note.kind), ['created', 'status', 'linked', 'note', 'status']);
  assert.deepEqual(full.notes.filter((note) => note.kind === 'status').map((note) => note.text), ['open → in-progress', 'in-progress → done']);
  assert.equal(inbox.update('S-1', { status: 'open' }).closedAt, undefined, 'reopening clears the closing time');
});

test('the inbox survives a restart and refuses what it cannot store', (t) => {
  const env = sandbox(t);
  const first = openInbox({ env, now: clock() });
  first.add({ title: '남아 있어야 해요' });
  first.close();
  const second = openInbox({ env });
  t.after(() => second.close());
  assert.deepEqual(second.list().map((item) => item.title), ['남아 있어야 해요']);
  assert.ok(inboxPath(env).endsWith('inbox/inbox.sqlite'));
  assert.throws(() => second.add({ title: '  ' }), /title/);
  assert.throws(() => second.add({ title: 'x', source: 'carrier-pigeon' }), /source must be/);
  assert.throws(() => second.update('S-1', { status: 'maybe' }), /status must be one of/);
  assert.deepEqual(INBOX_STATUSES, ['open', 'in-progress', 'waiting', 'done', 'dropped']);
});

